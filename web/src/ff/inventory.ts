/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * The parts inventory: a creative-mode palette for the physics bench.
 *
 * The palette is never authored by hand. Every slot comes from `kb.components` in the exported
 * physics bundle, so the moment the Python kernel learns a new component the bench can place it.
 * That is the whole point of keeping the knowledge base as data: the 3D app is a *view* of it.
 *
 * Two constraints shape everything below.
 *
 *   1. **Seated reach.** The user is in a chair at a real desk and never stands up, so every slot
 *      and every placed part must stay inside a ~0.6 m sphere around the shoulder. This is not a
 *      comment we hope holds: `layoutGrid()` shrinks the slot pitch until the furthest slot
 *      measures inside `REACH_RADIUS`, and `computeReachBox()` derives the clamp box that
 *      `OneHandGrabbable.translateMin`/`translateMax` enforces on every spawned part.
 *   2. **Infinite stock.** Squeezing a slot must not empty it. A slot is a `OneHandGrabbable` with
 *      `rotate` and `translate` both false, so grabbing it cannot move it; the grab is only a
 *      trigger. `GrabSystem` still tags it `Grabbed` — it keys that tag off active pointers, not
 *      off movement — and that tag is the signal this system spawns on.
 *
 * XR terms, once: a *grip pose* is where the headset reports the user's fist, as opposed to the
 * *target ray* that points out of a controller. A newly spawned part rides the grip pose until the
 * squeeze ends, which is what makes it feel handed over rather than teleported.
 *
 * No physics is computed here. A part carries only `kind` (a key into `kb.components`) and a fresh
 * `instanceId`; the solver bridge looks up verified properties from those two strings.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  CylinderGeometry,
  Float32BufferAttribute,
  GrabSystem,
  Grabbed,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OneHandGrabbable,
  Quaternion,
  SRGBColorSpace,
  SphereGeometry,
  Uint16BufferAttribute,
  Vector3,
  createSystem,
  setWorldPosition,
  setWorldQuaternion,
  type Entity,
} from '@iwsdk/core';

import { loadPhysics, type ComponentDef, type KnowledgeBase } from '../physics/kernel.js';
import { Bench as BenchComponent, Part } from './components.js';
import { CadModels } from './models.js';

// ------------------------------------------------------------------ seated ergonomics

/** Hard requirement: nothing this system creates may sit further than this from the shoulder. */
const REACH_RADIUS = 0.6;

/** A seated shoulder sits roughly this far above a desk surface. */
const SHOULDER_RISE = 0.22;

/** …and the shoulder line is this far beyond the bench's near edge, where the chair is. */
const SEAT_CLEARANCE = 0.08;

/** How high a held part may be lifted off the bench before the clamp stops it. */
const LIFT_MAX = 0.35;

/** Parts may hang this far past the near edge, so they can be picked up without leaning in. */
const NEAR_OVERHANG = 0.12;

// ------------------------------------------------------------------ palette geometry

/** Half width the palette tries to occupy; also capped by the bench at build time. */
const PANEL_HALF_MAX = 0.28;

/** Slot centre-to-centre spacing. `layoutGrid()` shrinks this if reach demands it. */
const SLOT_PITCH = 0.062;

/** Never shrink below this: a smaller slot is not grabbable with a fist. */
const SLOT_PITCH_MIN = 0.042;

/** The square backing tile behind each slot. */
const TILE = 0.052;
const TILE_THICKNESS = 0.004;

/** Lean the panel back like a till keypad so a seated user reads it face-on. Radians, about X. */
const PANEL_TILT = -0.95;

/** Panel-local Z offsets, stacked so nothing z-fights with the tile face. */
const TILE_Z = 0.002;
const RIBBON_Z = 0.0045;
const LABEL_Z = 0.005;
const PROXY_Z = 0.022;

/** The group-colour strip along the bottom of every tile. */
const RIBBON_H = 0.004;

/** Label strip, sized to the 4:1 cells of the label atlas. */
const LABEL_W = 0.046;
const LABEL_H = LABEL_W / 4;

/** Edge length of the preview mesh inside a slot, and of a real part on the bench. */
const PREVIEW_SIZE = 0.03;
const PART_SIZE = 0.05;

/** Where `spawn()` drops a part when no hand is holding anything. Bench-local metres. */
const STAGE_PITCH = 0.07;
const STAGE_Z = 0.08;

// ------------------------------------------------------------------ presentation tables

/**
 * Tag names the palette groups by, in display order.
 *
 * This orders and colours groups; it does not decide *which* components exist. A component whose
 * tags match none of these still gets a group, derived from its own first tag, so a new domain in
 * the knowledge base appears without touching this file.
 */
const GROUP_TAGS: readonly string[] = ['circuit', 'electrostatic', 'magnetostatic', 'tool'];

/** Accent colours, cycled by group index. */
const GROUP_COLORS: readonly number[] = [0x3fd8c4, 0xf2b25c, 0x8f7bff, 0xff6f8f, 0x6fd36f];

/** The proxy meshes we know how to build. Deliberately crude: a palette is not a render target. */
type ProxyShape = 'box' | 'cylinder' | 'sphere' | 'plates' | 'slab' | 'rod' | 'probe';

/**
 * Tag to proxy shape, most specific tag first.
 *
 * A box for a resistor, a cylinder for a battery, a sphere for a charge. The order matters:
 * `spherical_cavity_in_charged_sphere` carries both `charge_source` and `uniform_field` and is a
 * sphere, so `charge_source` has to be consulted first.
 */
const SHAPE_BY_TAG: ReadonlyArray<readonly [string, ProxyShape]> = [
  ['emf', 'cylinder'],
  ['storage', 'plates'],
  ['resistive', 'box'],
  ['probe', 'probe'],
  ['tool', 'probe'],
  ['charge_source', 'sphere'],
  ['field_region', 'slab'],
  ['uniform_field', 'slab'],
];

/**
 * Refinement from the model name the knowledge base already declares.
 *
 * `model3d` is the kernel's own hint about the shape of the thing (`plane.glb`, `line.glb`), and it
 * separates cases the tags cannot: an infinite charged plane and a point charge are both
 * `charge_source`, but one is a sheet and the other a ball. Keys are shape nouns, not component
 * names, so this stays a rendering heuristic rather than a second copy of the component list.
 */
const SHAPE_BY_MODEL: Readonly<Record<string, ProxyShape>> = {
  plane: 'slab',
  parallel_plates: 'plates',
  field_region: 'slab',
  line: 'rod',
  ruler: 'rod',
  sphere: 'sphere',
  shell: 'sphere',
  cavity_sphere: 'sphere',
  point_charge: 'sphere',
  particle: 'sphere',
  electron: 'sphere',
  probe: 'probe',
  battery: 'cylinder',
  capacitor: 'plates',
};

/** One palette slot. The meshes are kept so highlighting is a material swap, not a rebuild. */
interface Slot {
  kind: string;
  entity: Entity;
  tile: Mesh;
  /** Every mesh of the preview, so a highlight recolours all of it. */
  preview: Mesh[];
  /** The slot's own group colour, restored when the highlight clears. */
  accent: MeshStandardMaterial;
}

export class InventorySystem extends createSystem({
  benches: { required: [BenchComponent] },
  parts: { required: [Part] },
  /** Both slots and spawned parts match this; the slot map tells them apart. */
  grabbed: { required: [OneHandGrabbable, Grabbed] },
}) {
  // ---------------------------------------------------------------- knowledge base

  private cad = new CadModels();
  private kb?: KnowledgeBase;
  private bench?: Entity;
  private built = false;
  /** Set by a cleanup func so an in-flight bundle load cannot resurrect a destroyed system. */
  private stopped = false;

  // ---------------------------------------------------------------- palette state

  private palette?: Entity;
  /**
   * Slot lookup by entity.
   *
   * elics recycles `Entity` instances from a pool, so an entity object is only a safe map key for
   * as long as it is alive. Slots are created once and released only in teardown, so they never
   * return to the pool while this map exists. Spawned parts are deliberately not keyed here.
   */
  private readonly slots = new Map<Entity, Slot>();
  private readonly order: string[] = [];
  private readonly wantedKinds = new Set<string>();
  private readonly issuedIds = new Set<string>();
  /** Group names in display order; the index picks the accent colour. */
  private groupIndex: string[] = [];
  private stageCursor = 0;

  private geo!: Record<string, BufferGeometry>;
  private previewMaterials!: MeshStandardMaterial[];
  private tileIdle!: MeshStandardMaterial;
  private tileWanted!: MeshStandardMaterial;
  private previewWanted!: MeshStandardMaterial;
  private panelMaterial!: MeshStandardMaterial;
  private labelMaterial?: MeshBasicMaterial;
  private labelTexture?: CanvasTexture;

  /** Pitch, column count and width the current panel was actually laid out with. */
  private pitch = SLOT_PITCH;
  private columns = 1;
  private panelSpan = 0;

  // ---------------------------------------------------------------- handoff state

  private grabSystem?: GrabSystem;
  private carriedPart: Entity | null = null;
  /** Parts in a hand as of last frame; the diff against this frame is a drop. */
  private heldParts = new Set<Entity>();
  /** Generation of `carriedPart` when we took it, so a recycled entity index cannot fool us. */
  private carriedGeneration = -1;
  private carriedSlot: Entity | null = null;
  private carryHand: 'left' | 'right' = 'right';

  // ---------------------------------------------------------------- preallocated scratch

  // A per-frame allocation in an XR app is a frame-time bug, so everything update() touches is
  // allocated here, once.
  private readonly reachMin = new Vector3();
  private readonly reachMax = new Vector3();
  private readonly shoulder = new Vector3();
  private readonly handPos = new Vector3();
  private readonly handQuat = new Quaternion();
  private readonly tmpScale = new Vector3();
  private readonly tmp = new Vector3();
  private readonly carryOffset = new Vector3(0, 0, -0.035);
  private benchWidth = 0;
  private benchDepth = 0;

  // ================================================================ lifecycle

  init(): void {
    activeInventory = this;
    this.buildResources();

    // `loadPhysics()` fetches JSON, so it cannot gate init(). The palette is built by whichever of
    // the two prerequisites — knowledge base, bench — arrives last.
    void loadPhysics()
      .then((physics) => {
        if (this.stopped) {
          return;
        }
        this.kb = physics.kb;
        this.tryBuild();
      })
      .catch((error: unknown) => {
        console.error('[FieldForge] inventory has no physics bundle; palette stays empty', error);
      });

    this.grabSystem = this.world.getSystem(GrabSystem);
    if (this.grabSystem === undefined) {
      // Without GrabSystem a slot can never be squeezed, so the palette would be inert furniture.
      console.warn('[FieldForge] inventory needs the grabbing feature; slots will not spawn parts');
    }

    this.cleanupFuncs.push(
      () => {
        this.stopped = true;
        if (activeInventory === this) {
          activeInventory = null;
        }
      },
      this.queries.benches.subscribe(
        'qualify',
        (entity) => {
          if (this.bench === undefined) {
            this.bench = entity;
            this.tryBuild();
          }
        },
        true, // the bench is created in BenchSystem.init(), which may already have run
      ),
      this.queries.benches.subscribe('disqualify', (entity) => {
        if (entity === this.bench) {
          this.bench = undefined;
        }
      }),
      this.queries.grabbed.subscribe('qualify', (entity) => this.onGrabStart(entity)),
      this.queries.grabbed.subscribe('disqualify', (entity) => this.onGrabEnd(entity)),
      () => this.teardown(),
    );
  }

  update(): void {
    const bench = this.bench;
    if (bench === undefined) {
      return;
    }

    // BenchSystem refits the bench when it adopts a detected plane, so the panel placement and the
    // reach clamp are re-derived whenever the dimensions move. Both are arithmetic over
    // preallocated vectors; no geometry is rebuilt here.
    const width = bench.getValue(BenchComponent, 'width') ?? 0;
    const depth = bench.getValue(BenchComponent, 'depth') ?? 0;
    if (width !== this.benchWidth || depth !== this.benchDepth) {
      this.syncToBench(width, depth);
    }

    this.carry();

    // Settle-on-drop: a part that was in a hand last frame and is not now has been
    // let go. It lands flat on the bench (resting height, yaw kept, tilt discarded)
    // and is stamped `snapped`, which is what the guided build verifies against —
    // a step is done when the part has *settled*, not when it was pulled out.
    const stillHeld = new Set<Entity>();
    this.queries.grabbed.entities.forEach((entity) => {
      if (this.slots.has(entity)) {
        return; // a palette slot, not a part
      }
      stillHeld.add(entity);
      if (!this.heldParts.has(entity)) {
        entity.setValue(Part, 'snapped', false); // picked up again: unsettled
      }
    });
    for (const entity of this.heldParts) {
      if (!stillHeld.has(entity) && entity.active) {
        this.settle(entity);
      }
    }
    this.heldParts = stillHeld;
  }

  /**
   * Rest a let-go part on the bench: resting height, upright with its yaw kept.
   * Bench-local, like `stage()` — the bench is the parent, so local flat is flat.
   */
  private settle(entity: Entity): void {
    const object = entity.object3D;
    if (object == null) {
      return;
    }
    const yaw = Math.atan2(
      2 * (object.quaternion.w * object.quaternion.y + object.quaternion.x * object.quaternion.z),
      1 - 2 * (object.quaternion.y * object.quaternion.y + object.quaternion.x * object.quaternion.x),
    );
    object.quaternion.setFromAxisAngle(UP, yaw);
    object.position.y = this.reachMin.y;
    entity.setValue(Part, 'snapped', true);
  }

  // ================================================================ public API

  /** True once the knowledge base and the bench have both arrived and the palette exists. */
  get ready(): boolean {
    return this.built;
  }

  /** The component kinds the palette offers, in display order. Each is a `kb.components` key. */
  get availableKinds(): readonly string[] {
    return this.order;
  }

  /**
   * Make the named component kinds glow in the palette, for the guided mode's "you need these".
   *
   * Unknown kinds are kept rather than dropped, so a call that lands before the physics bundle has
   * loaded still takes effect when the palette builds.
   */
  highlightWanted(kinds: readonly string[]): void {
    this.wantedKinds.clear();
    for (const kind of kinds) {
      this.wantedKinds.add(kind);
    }
    this.refreshWanted();
  }

  /** Drop every highlight and clear `Part.wanted` on parts already on the bench. */
  clearWanted(): void {
    this.wantedKinds.clear();
    this.refreshWanted();
  }

  /**
   * Place a part programmatically, as the trace replayer does when it stages a problem.
   *
   * Returns the new entity, or `null` when the palette is not ready or `kind` is not a placeable
   * component. The part lands on a staging cell near the palette; from then on it is a normal
   * `OneHandGrabbable`, clamped to the same reach box as a hand-spawned one.
   */
  spawn(kind: string): Entity | null {
    const def = this.kb?.components[kind];
    if (def == null || this.bench === undefined) {
      return null;
    }

    const group = new Group();
    group.name = `Part:${kind}`;
    group.add(this.buildProxy(this.shapeFor(def), this.accentFor(kind).clone(), true));
    group.scale.setScalar(PART_SIZE);

    // Progressive enhancement: if a real CAD model exists for this kind (imported
    // from the KiCad libraries by tools/import_cad.py), swap the proxy for it when
    // it arrives. The part is fully usable as a proxy in the meantime, and stays a
    // proxy forever if the model cannot load. See ff/models.ts.
    void this.cad.sceneFor(kind).then((model) => {
      if (model === null || this.stopped || group.parent === null) {
        return;
      }
      for (const child of [...group.children]) {
        group.remove(child);
      }
      group.add(model);
    });

    const entity = this.world.createTransformEntity(group, this.bench);
    entity.addComponent(Part, {
      kind,
      instanceId: this.mintInstanceId(kind),
      snapped: false,
      wanted: this.wantedKinds.has(kind),
    });

    // `rotate` and `translate` stay on: this is a real part the user manipulates. The clamp is what
    // keeps it on the bench. HandleStore reads these as the allowed *local* position range, and the
    // part is parented to the bench, so the box travels with the desk when it re-anchors.
    entity.addComponent(OneHandGrabbable, { rotate: true, translate: true });
    this.applyReachClamp(entity);

    this.stage(group);
    return entity;
  }

  // ================================================================ build

  /**
   * Shared geometry and materials for the palette.
   *
   * Everything here is shared by every slot, which is why slot entities are later released with
   * `disposeResources: false`: `entity.dispose()` traverses and disposes whatever it finds, and one
   * slot taking the shared box geometry with it would blank the rest of the palette. Spawned parts
   * get clones instead, so they own their GPU resources and a plain `dispose()` on them is safe.
   */
  private buildResources(): void {
    this.geo = {
      tile: new BoxGeometry(TILE, TILE, TILE_THICKNESS),
      ribbon: new BoxGeometry(TILE, RIBBON_H, TILE_THICKNESS),
      box: new BoxGeometry(1, 0.45, 0.45),
      cylinder: new CylinderGeometry(0.3, 0.3, 1, 10),
      sphere: new SphereGeometry(0.5, 8, 6),
      slab: new BoxGeometry(1, 0.08, 1),
      rod: new CylinderGeometry(0.06, 0.06, 1, 6),
      plate: new BoxGeometry(1, 0.05, 0.7),
      tip: new SphereGeometry(0.16, 6, 4),
      panel: new BoxGeometry(1, 1, 0.006),
    };

    this.previewMaterials = GROUP_COLORS.map(
      (color) => new MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 }),
    );
    this.tileIdle = new MeshStandardMaterial({ color: 0x142422, roughness: 0.9, metalness: 0.02 });
    this.tileWanted = new MeshStandardMaterial({
      color: 0x1d4b44,
      emissive: 0x3fd8c4,
      emissiveIntensity: 0.9,
      roughness: 0.6,
      metalness: 0.05,
    });
    this.previewWanted = new MeshStandardMaterial({
      color: 0xd8fff7,
      emissive: 0x3fd8c4,
      emissiveIntensity: 1.1,
      roughness: 0.4,
      metalness: 0.1,
    });
    this.panelMaterial = new MeshStandardMaterial({
      color: 0x08110f,
      roughness: 0.95,
      metalness: 0.03,
      transparent: true,
      opacity: 0.8,
    });
  }

  /** Build the palette once both the knowledge base and the bench exist. Idempotent. */
  private tryBuild(): void {
    const bench = this.bench;
    const kb = this.kb;
    if (this.built || this.stopped || kb === undefined || bench === undefined) {
      return;
    }

    const entries = this.placeable(kb);
    if (entries.length === 0) {
      console.warn('[FieldForge] knowledge base declares no placeable components');
      return;
    }

    const width = bench.getValue(BenchComponent, 'width') ?? 0.9;
    const depth = bench.getValue(BenchComponent, 'depth') ?? 0.6;
    this.layoutGrid(entries.length, width, depth);

    const panel = new Group();
    panel.name = 'FieldForgeInventory';
    const rows = Math.ceil(entries.length / this.columns);
    const gridHeight = rows * this.pitch;

    const backdrop = new Mesh(this.geo.panel, this.panelMaterial);
    backdrop.name = 'InventoryBackdrop';
    backdrop.scale.set(this.panelSpan + 0.012, gridHeight + 0.012, 1);
    backdrop.position.set(0, gridHeight / 2 - this.pitch / 2, 0);
    // Decoration must stay invisible to the near-grab pointer, or it could win the intersection
    // against the slot sitting in front of it.
    backdrop.pointerEvents = 'none';
    panel.add(backdrop);

    this.palette = this.world.createTransformEntity(panel, bench);

    const labelMesh = this.buildLabels(
      entries.map(([, def]) => def.label),
      entries.length,
    );
    if (labelMesh != null) {
      panel.add(labelMesh);
    }

    entries.forEach(([kind, def], index) => {
      this.order.push(kind);
      this.buildSlot(kind, def, index);
    });

    this.built = true;
    this.syncToBench(width, depth);
    this.refreshWanted();
  }

  /**
   * The components a user can pick up, grouped and ordered for display.
   *
   * A knowledge-base component with no `model3d` is an abstract relation — a series combination, a
   * parallel combination, a circuit loop — not an object that exists on a desk. Those are produced
   * by wiring real parts together, so they get no inventory slot. Filtering on the kernel's own
   * `model3d` field keeps that judgement in the data instead of in a list here.
   */
  private placeable(kb: KnowledgeBase): Array<[string, ComponentDef]> {
    const groups: string[] = GROUP_TAGS.slice();
    const entries: Array<[string, ComponentDef]> = [];

    for (const kind of Object.keys(kb.components)) {
      const def = kb.components[kind];
      if (def == null || def.model3d == null) {
        continue;
      }
      const group = this.groupOf(def);
      if (!groups.includes(group)) {
        groups.push(group);
      }
      entries.push([kind, def]);
    }

    this.groupIndex = groups;
    entries.sort(([, a], [, b]) => {
      const ga = groups.indexOf(this.groupOf(a));
      const gb = groups.indexOf(this.groupOf(b));
      return ga !== gb ? ga - gb : a.label.localeCompare(b.label);
    });
    return entries;
  }

  /** Which palette group a component belongs to: its first recognised tag, else its first tag. */
  private groupOf(def: ComponentDef): string {
    for (const tag of GROUP_TAGS) {
      if (def.tags.includes(tag)) {
        return tag;
      }
    }
    return def.tags[0] ?? 'other';
  }

  private accentFor(kind: string): MeshStandardMaterial {
    const def = this.kb?.components[kind];
    const group = def == null ? 'other' : this.groupOf(def);
    const index = Math.max(0, this.groupIndex.indexOf(group));
    return this.previewMaterials[index % this.previewMaterials.length];
  }

  /**
   * Choose a column count and pitch that keep the furthest slot inside `REACH_RADIUS`.
   *
   * This loop is the enforcement of the seated-reach requirement: it measures the worst slot of a
   * candidate grid against a shoulder point derived from the bench, and tightens the pitch until it
   * fits — which also widens the grid, moving slots sideways instead of away.
   */
  private layoutGrid(count: number, width: number, depth: number): void {
    this.shoulder.set(0, SHOULDER_RISE, depth / 2 + SEAT_CLEARANCE);
    const usable = Math.min(2 * PANEL_HALF_MAX, Math.max(0.12, width - 0.04));

    let pitch = SLOT_PITCH;
    for (let guard = 0; guard < 12; guard += 1) {
      const columns = Math.max(1, Math.floor(usable / pitch));
      const rows = Math.ceil(count / columns);
      if (this.worstSlotReach(columns, rows, pitch, depth) <= REACH_RADIUS) {
        this.pitch = pitch;
        this.columns = columns;
        this.panelSpan = columns * pitch;
        return;
      }
      if (pitch <= SLOT_PITCH_MIN) {
        break;
      }
      pitch = Math.max(SLOT_PITCH_MIN, pitch * 0.92);
    }

    // Fell through: take the tightest legible pitch and the widest column count it allows, which is
    // as close to the reach budget as a grabbable slot size permits.
    this.pitch = SLOT_PITCH_MIN;
    this.columns = Math.max(1, Math.floor(usable / SLOT_PITCH_MIN));
    this.panelSpan = this.columns * SLOT_PITCH_MIN;
  }

  /** Distance from the shoulder to the far top corner slot of a candidate grid. */
  private worstSlotReach(columns: number, rows: number, pitch: number, depth: number): number {
    const x = ((columns - 1) / 2) * pitch;
    const y = (rows - 1) * pitch;
    this.tmp.set(x, y * Math.cos(PANEL_TILT), depth / 2 - 0.02 + y * Math.sin(PANEL_TILT));
    return this.tmp.distanceTo(this.shoulder);
  }

  private buildSlot(kind: string, def: ComponentDef, index: number): void {
    const palette = this.palette;
    if (palette == null) {
      return;
    }

    const column = index % this.columns;
    const row = Math.floor(index / this.columns);
    const accent = this.accentFor(kind);

    const group = new Group();
    group.name = `Slot:${kind}`;
    group.position.set((column - (this.columns - 1) / 2) * this.pitch, row * this.pitch, 0);

    const tile = new Mesh(this.geo.tile, this.tileIdle);
    tile.name = 'SlotTile';
    tile.position.z = TILE_Z;
    group.add(tile);

    // Slots are already ordered by group, so a colour strip is enough to read the boundaries
    // without spending draw calls and panel height on group headings.
    const ribbon = new Mesh(this.geo.ribbon, accent);
    ribbon.name = 'SlotRibbon';
    ribbon.position.set(0, -TILE / 2 + RIBBON_H / 2 + 0.001, RIBBON_Z);
    group.add(ribbon);

    const proxy = this.buildProxy(this.shapeFor(def), accent, false);
    proxy.position.set(0, TILE / 2 - 0.018, PROXY_Z);
    proxy.scale.setScalar(PREVIEW_SIZE);
    group.add(proxy);

    const entity = this.world.createTransformEntity(group, palette);
    // Infinite stock: both axes of motion are off, so a squeeze tags the slot Grabbed without
    // moving it out of the palette. The spawned part, not the slot, is what travels.
    entity.addComponent(OneHandGrabbable, { rotate: false, translate: false });

    const preview: Mesh[] = [];
    proxy.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh === true) {
        preview.push(mesh);
      }
    });

    this.slots.set(entity, { kind, entity, tile, preview, accent });
  }

  // ---------------------------------------------------------------- proxy meshes

  private shapeFor(def: ComponentDef): ProxyShape {
    const model = def.model3d;
    if (model != null) {
      const byModel = SHAPE_BY_MODEL[model.replace(/\.[^.]+$/, '')];
      if (byModel !== undefined) {
        return byModel;
      }
    }
    for (const [tag, shape] of SHAPE_BY_TAG) {
      if (def.tags.includes(tag)) {
        return shape;
      }
    }
    return 'box';
  }

  /**
   * A unit-sized stand-in, a few dozen triangles at most.
   *
   * `own` decides resource ownership: a palette preview shares the cached geometry, a spawned part
   * clones it so `entity.dispose()` on that part cannot blank the palette.
   */
  private buildProxy(shape: ProxyShape, material: MeshStandardMaterial, own: boolean): Group {
    const group = new Group();
    group.name = `Proxy:${shape}`;
    const take = (key: string): BufferGeometry => (own ? this.geo[key].clone() : this.geo[key]);

    switch (shape) {
      case 'cylinder':
        group.add(new Mesh(take('cylinder'), material));
        break;
      case 'sphere':
        group.add(new Mesh(take('sphere'), material));
        break;
      case 'slab':
        group.add(new Mesh(take('slab'), material));
        break;
      case 'rod': {
        const rod = new Mesh(take('rod'), material);
        rod.rotation.z = Math.PI / 2; // lies flat, like a lead or a ruler
        group.add(rod);
        break;
      }
      case 'plates': {
        const top = new Mesh(take('plate'), material);
        const bottom = new Mesh(take('plate'), material);
        top.position.y = 0.22;
        bottom.position.y = -0.22;
        group.add(top, bottom);
        break;
      }
      case 'probe': {
        const stem = new Mesh(take('rod'), material);
        const tip = new Mesh(take('tip'), material);
        tip.position.y = 0.5;
        group.add(stem, tip);
        break;
      }
      case 'box':
      default:
        group.add(new Mesh(take('box'), material));
        break;
    }
    return group;
  }

  // ---------------------------------------------------------------- labels

  /**
   * Every slot label in one mesh.
   *
   * The labels are rasterised into a single canvas atlas, one 4:1 cell per slot, and drawn as one
   * indexed quad set sharing that texture. That is one draw call for the whole palette instead of
   * one per label, for the same reason BenchSystem draws its grid as a single `LineSegments`.
   *
   * Returns `null` when there is no 2D canvas context (a headless capture, say); the palette then
   * renders without labels rather than failing to build.
   */
  private buildLabels(labels: readonly string[], count: number): Mesh | null {
    const cell = count * 64 <= 4096 ? 64 : Math.max(16, Math.floor(4096 / count));
    const cellWidth = cell * 4;

    const canvas = document.createElement('canvas');
    canvas.width = cellWidth;
    canvas.height = cell * count;
    const ctx = canvas.getContext('2d');
    if (ctx == null) {
      return null;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#dff7f2';
    for (let i = 0; i < count; i += 1) {
      this.drawLabel(ctx, labels[i] ?? '', cellWidth, cell, i * cell);
    }

    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = LinearFilter;
    texture.wrapS = ClampToEdgeWrapping;
    texture.wrapT = ClampToEdgeWrapping;
    this.labelTexture = texture;

    this.labelMaterial = new MeshBasicMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
    });

    const positions = new Float32Array(count * 12);
    const uvs = new Float32Array(count * 8);
    const indices = new Uint16Array(count * 6);

    for (let i = 0; i < count; i += 1) {
      const column = i % this.columns;
      const row = Math.floor(i / this.columns);
      const cx = (column - (this.columns - 1) / 2) * this.pitch;
      const cy = row * this.pitch - TILE / 2 + LABEL_H / 2 + 0.003;
      const hw = LABEL_W / 2;
      const hh = LABEL_H / 2;

      // CanvasTexture keeps flipY, so v = 1 is the top of the canvas and row i owns the band
      // [1 - (i + 1) / count, 1 - i / count].
      const vTop = 1 - i / count;
      const vBottom = 1 - (i + 1) / count;

      const p = i * 12;
      positions[p] = cx - hw;
      positions[p + 1] = cy - hh;
      positions[p + 2] = LABEL_Z;
      positions[p + 3] = cx + hw;
      positions[p + 4] = cy - hh;
      positions[p + 5] = LABEL_Z;
      positions[p + 6] = cx + hw;
      positions[p + 7] = cy + hh;
      positions[p + 8] = LABEL_Z;
      positions[p + 9] = cx - hw;
      positions[p + 10] = cy + hh;
      positions[p + 11] = LABEL_Z;

      const u = i * 8;
      uvs[u] = 0;
      uvs[u + 1] = vBottom;
      uvs[u + 2] = 1;
      uvs[u + 3] = vBottom;
      uvs[u + 4] = 1;
      uvs[u + 5] = vTop;
      uvs[u + 6] = 0;
      uvs[u + 7] = vTop;

      const base = i * 4;
      const t = i * 6;
      indices[t] = base;
      indices[t + 1] = base + 1;
      indices[t + 2] = base + 2;
      indices[t + 3] = base;
      indices[t + 4] = base + 2;
      indices[t + 5] = base + 3;
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
    geometry.setIndex(new Uint16BufferAttribute(indices, 1));

    const mesh = new Mesh(geometry, this.labelMaterial);
    mesh.name = 'InventoryLabels';
    mesh.renderOrder = 1;
    mesh.pointerEvents = 'none';
    return mesh;
  }

  /** Word-wrap a label into at most two lines, shrinking the font until it fits its cell. */
  private drawLabel(
    ctx: CanvasRenderingContext2D,
    label: string,
    width: number,
    height: number,
    top: number,
  ): void {
    const words = label.split(/\s+/).filter((word) => word.length > 0);
    const maxWidth = width * 0.92;

    for (let size = Math.floor(height * 0.42); size >= 8; size -= 2) {
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      const lines: string[] = [];
      let current = '';
      for (const word of words) {
        const candidate = current.length === 0 ? word : `${current} ${word}`;
        if (current.length === 0 || ctx.measureText(candidate).width <= maxWidth) {
          current = candidate;
        } else {
          lines.push(current);
          current = word;
        }
      }
      if (current.length > 0) {
        lines.push(current);
      }
      if (lines.length > 2 || lines.some((line) => ctx.measureText(line).width > maxWidth)) {
        continue;
      }
      const lineHeight = size * 1.12;
      const startY = top + height / 2 - ((lines.length - 1) * lineHeight) / 2;
      lines.forEach((line, i) => ctx.fillText(line, width / 2, startY + i * lineHeight));
      return;
    }

    // Nothing fits: a clipped single line still beats an empty tile.
    ctx.font = `600 ${Math.max(8, Math.floor(height * 0.3))}px system-ui, sans-serif`;
    ctx.fillText(label, width / 2, top + height / 2, maxWidth);
  }

  // ================================================================ bench tracking

  /**
   * Re-place the panel and re-derive the reach clamp for a bench of this size.
   *
   * Allocation-free: the panel is moved, not rebuilt. If the bench turns out narrower than the panel
   * was laid out for, the panel is scaled down uniformly to fit rather than re-flowed, which keeps
   * the rasterised labels from being re-rendered mid-session.
   */
  private syncToBench(width: number, depth: number): void {
    this.benchWidth = width;
    this.benchDepth = depth;
    this.shoulder.set(0, SHOULDER_RISE, depth / 2 + SEAT_CLEARANCE);
    this.computeReachBox(width, depth);

    const panel = this.palette?.object3D;
    if (panel == null) {
      return;
    }
    const fit = this.panelSpan > 0 ? Math.min(1, (width - 0.03) / this.panelSpan) : 1;
    panel.scale.setScalar(Math.max(0.5, fit));
    // The near edge is the +Z side: BenchSystem puts the bench in front of the viewer, so +Z faces
    // the chair. The palette owns that strip and the rest of the surface is the working area.
    panel.position.set(0, 0.006, depth / 2 - 0.02);
    panel.rotation.set(PANEL_TILT, 0, 0);
  }

  /**
   * The box a part is allowed to occupy, in bench-local metres.
   *
   * `OneHandGrabbable` can only express an axis-aligned box, so the box is inscribed in the reach
   * sphere: vertical slack comes off the radius first, and what is left becomes a square in the
   * bench's XZ plane. That is why a large desk is not fully usable — the far edge of a 0.6 m deep
   * bench is genuinely out of reach for a seated user, and pretending otherwise is how parts end up
   * stranded where nobody can get them back.
   */
  private computeReachBox(width: number, depth: number): void {
    const yMin = PART_SIZE * 0.5;
    const yMax = Math.max(yMin + 0.05, LIFT_MAX);
    const dy = Math.max(Math.abs(yMin - this.shoulder.y), Math.abs(yMax - this.shoulder.y));
    const planar = Math.sqrt(Math.max(0, REACH_RADIUS * REACH_RADIUS - dy * dy));
    const half = planar / Math.SQRT2;

    const hx = Math.max(PART_SIZE, Math.min(width / 2, half));
    const zMax = Math.min(depth / 2 + NEAR_OVERHANG, this.shoulder.z + half);
    const zMin = Math.max(-depth / 2, this.shoulder.z - half);

    this.reachMin.set(-hx, yMin, Math.min(zMin, zMax));
    this.reachMax.set(hx, yMax, Math.max(zMin, zMax));
  }

  /** Copy the clamp box into a part's grab limits. Vector fields: views only, never `setValue`. */
  private applyReachClamp(entity: Entity): void {
    const min = entity.getVectorView(OneHandGrabbable, 'translateMin');
    const max = entity.getVectorView(OneHandGrabbable, 'translateMax');
    min[0] = this.reachMin.x;
    min[1] = this.reachMin.y;
    min[2] = this.reachMin.z;
    max[0] = this.reachMax.x;
    max[1] = this.reachMax.y;
    max[2] = this.reachMax.z;
  }

  // ================================================================ spawn and handoff

  private onGrabStart(entity: Entity): void {
    const slot = this.slots.get(entity);
    if (slot === undefined) {
      return; // a real part was grabbed; GrabSystem owns that entirely
    }

    const part = this.spawn(slot.kind);
    if (part == null) {
      return;
    }

    // Which fist is on the slot decides where the part appears. `getHolderHand` returns null for a
    // desktop pointer grab, in which case the part just stays on its staging cell.
    const hand = this.grabSystem?.getHolderHand(entity) ?? null;
    if (hand == null) {
      return;
    }
    this.carriedPart = part;
    this.carriedGeneration = part.generation;
    this.carriedSlot = entity;
    this.carryHand = hand;
  }

  private onGrabEnd(entity: Entity): void {
    if (entity === this.carriedSlot) {
      this.releaseCarry();
    }
  }

  private releaseCarry(): void {
    // A hand-carried part is left wherever the fist opened: settle it there.
    if (this.carriedPart?.active) {
      this.settle(this.carriedPart);
    }
    this.carriedPart = null;
    this.carriedGeneration = -1;
    this.carriedSlot = null;
  }

  /**
   * Keep a just-spawned part in the hand that pulled it out of the palette.
   *
   * There is no public API for transferring a grab from one entity to another, so the part is driven
   * from the grip pose for as long as the slot is held and then left wherever the hand let go. The
   * part already carries `OneHandGrabbable`, so the next squeeze picks it up normally.
   */
  private carry(): void {
    const part = this.carriedPart;
    if (part == null) {
      return;
    }
    // elics recycles entity objects; a generation bump means this part was disposed under us.
    if (!part.active || part.generation !== this.carriedGeneration) {
      this.releaseCarry();
      return;
    }
    const object = part.object3D;
    if (object == null) {
      this.releaseCarry();
      return;
    }

    const grip = this.player.gripSpaces[this.carryHand];
    grip.updateWorldMatrix(true, false);
    grip.matrixWorld.decompose(this.handPos, this.handQuat, this.tmpScale);

    // Sit the part just forward of the fist so it is not buried inside the hand model.
    this.tmp.copy(this.carryOffset).applyQuaternion(this.handQuat);
    this.handPos.add(this.tmp);

    setWorldPosition(object, this.handPos);
    setWorldQuaternion(object, this.handQuat);

    // The grab clamps only act while GrabSystem drives the entity, so reach is enforced here too: a
    // part must never follow a hand somewhere the user cannot get it back from.
    object.position.set(
      clamp(object.position.x, this.reachMin.x, this.reachMax.x),
      clamp(object.position.y, this.reachMin.y, this.reachMax.y),
      clamp(object.position.z, this.reachMin.z, this.reachMax.z),
    );
  }

  /** Drop a programmatically spawned part onto the next staging cell in front of the palette. */
  private stage(group: Group): void {
    const span = Math.max(1, Math.floor((this.reachMax.x - this.reachMin.x) / STAGE_PITCH));
    const cell = this.stageCursor % span;
    const row = Math.floor(this.stageCursor / span) % 3;
    this.stageCursor += 1;

    group.position.set(
      clamp(
        this.reachMin.x + (cell + 0.5) * STAGE_PITCH,
        this.reachMin.x + PART_SIZE,
        this.reachMax.x - PART_SIZE,
      ),
      this.reachMin.y,
      clamp(STAGE_Z - row * STAGE_PITCH, this.reachMin.z, this.reachMax.z),
    );
  }

  /**
   * A fresh scene instance id, in the kernel's own style.
   *
   * The precompiled traces name instances `r1`, `q1`, `c2` — the component's initials plus a
   * counter. Matching that convention means an id minted here reads the same as one the Python side
   * produced, and the issued set guarantees uniqueness when two kinds share initials.
   */
  private mintInstanceId(kind: string): string {
    const prefix =
      kind
        .split('_')
        .map((segment) => segment.charAt(0))
        .join('')
        .toLowerCase() || 'x';
    let n = 1;
    let id = `${prefix}${n}`;
    while (this.issuedIds.has(id)) {
      n += 1;
      id = `${prefix}${n}`;
    }
    this.issuedIds.add(id);
    return id;
  }

  // ================================================================ highlighting

  /** Repaint slot highlights and re-stamp `Part.wanted` on everything already on the bench. */
  private refreshWanted(): void {
    for (const slot of this.slots.values()) {
      const wanted = this.wantedKinds.has(slot.kind);
      slot.tile.material = wanted ? this.tileWanted : this.tileIdle;
      const material = wanted ? this.previewWanted : slot.accent;
      for (const mesh of slot.preview) {
        mesh.material = material;
      }
    }

    for (const entity of this.queries.parts.entities) {
      const kind = entity.getValue(Part, 'kind') ?? '';
      entity.setValue(Part, 'wanted', this.wantedKinds.has(kind));
    }
  }

  // ================================================================ teardown

  /**
   * Give back the palette's GPU memory.
   *
   * Slots and the panel share every geometry and material, so they are released with
   * `disposeResources: false` and the shared caches are disposed exactly once afterwards. Spawned
   * parts are left alone: they own cloned resources and belong to the rest of the app.
   */
  private teardown(): void {
    for (const slot of this.slots.values()) {
      slot.entity.dispose({ disposeResources: false });
    }
    this.slots.clear();
    this.order.length = 0;

    const panel = this.palette;
    if (panel != null) {
      const labels = panel.object3D?.getObjectByName('InventoryLabels') as Mesh | undefined;
      labels?.geometry.dispose();
      panel.dispose({ disposeResources: false });
      this.palette = undefined;
    }

    for (const key of Object.keys(this.geo)) {
      this.geo[key].dispose();
    }
    for (const material of this.previewMaterials) {
      material.dispose();
    }
    this.tileIdle.dispose();
    this.tileWanted.dispose();
    this.previewWanted.dispose();
    this.panelMaterial.dispose();
    this.labelMaterial?.dispose();
    this.labelTexture?.dispose();
    this.labelMaterial = undefined;
    this.labelTexture = undefined;
    this.built = false;
  }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

const UP = new Vector3(0, 1, 0);

// --------------------------------------------------------------------------- module-level API
//
// The experience system holds no reference to this system, so the guide's palette
// highlighting is exported as a plain function delegating to the live instance (the
// same pattern terminals.ts uses). Safe no-ops before start / after teardown.

let activeInventory: InventorySystem | null = null;

/** Light the palette slots for `kinds` (the guide's current need); null clears. */
export function highlightPalette(kinds: readonly string[] | null): void {
  if (activeInventory === null) {
    return;
  }
  if (kinds === null) {
    activeInventory.clearWanted();
  } else {
    activeInventory.highlightWanted(kinds);
  }
}

// --- TEMP TYPE PROBE 2: prove getSystem(GrabSystem) is not 'any' ---
type IsAny<T> = 0 extends 1 & T ? true : false;
declare const _g: GrabSystem | undefined;
type _HandT = ReturnType<GrabSystem['getHolderHand']>;
const _h1: IsAny<_HandT> extends true ? never : _HandT = null;
void _g; void _h1;
