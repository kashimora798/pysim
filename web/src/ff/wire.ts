/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Wires: the visible half of a circuit, and deliberately nothing more.
 *
 * `Wire.current` is written by the solver bridge. This file reads it to decide how fast a glow
 * travels along a lead and in which direction, and that is the whole relationship between this
 * system and the physics. Nothing here derives, integrates or guesses an electrical quantity.
 *
 * Two render styles, switchable per wire at runtime via `Wire.style`:
 *
 *   - `Flexible` — a real catenary droop between the two terminals. A lead that hangs is the
 *     single strongest cue that this bench is a physical object and not a diagram.
 *   - `Straight` — Manhattan routing: five axis-aligned legs, with the crossing column and the
 *     run height snapped to the bench's own `gridStep`. Once six parts are on a 0.9 x 0.6 m desk,
 *     sagging leads cross into noise; right angles sharing a grid stay readable.
 *
 * Draw-call budget. Every wire shares ONE `Mesh`. Its geometry is a fixed grid of per-wire slots
 * inside preallocated buffers, so a wire is a byte range rather than an object and all of them
 * cost a single draw call. That is also why the flow animation lives in per-vertex attributes fed
 * to a small `ShaderMaterial`: with one merged mesh there is no per-wire material to offset, so
 * each vertex instead carries its own arc length, pulse rate and amplitude.
 *
 * XR terms, once: an *index tip space* is the pose of the user's fingertip as reported by hand
 * tracking. IWSDK keeps one per hand, and `@iwsdk/xr-input` copies the controller's target-ray
 * pose into it whenever a controller is in use instead of a hand — so reading the index tip is
 * correct for both input modes and needs no fallback of our own.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  ShaderMaterial,
  Vector3,
  VisibilityState,
  createSystem,
  type Entity,
} from '@iwsdk/core';

import {
  Bench as BenchComponent,
  Terminal,
  TerminalKind,
  Wire,
  WireDrag,
  WireStyle,
} from './components.js';

/** The two legal values of `Wire.style`, as a type. The component stores them as plain strings. */
export type WireStyleValue = (typeof WireStyle)[keyof typeof WireStyle];

/** How callers may name a hand. `WireDrag.hand` stores 0 for left and 1 for right. */
export type WireHand = 'left' | 'right' | 0 | 1;

/** Shorthand for whatever Object3D flavour IWSDK hangs off an entity. */
type SceneObject = NonNullable<Entity['object3D']>;

// ---------------------------------------------------------------- geometry budget

/**
 * Hard ceiling on simultaneous wires. Every slot is allocated up front, so this number is a
 * memory decision rather than a limit discovered at runtime: 32 slots is about 270 KB of buffers
 * and 10.8k triangles, which is nothing, while 32 leads on one desk is already past readable.
 */
const MAX_WIRES = 32;

/** Lengthwise samples. 28 is enough for a smooth catenary and keeps straight corners crisp. */
const TUBULAR_SEGMENTS = 28;

/** Cross-section sides. The tube is 6 mm across; a hexagon reads as round at arm's length. */
const RADIAL_SEGMENTS = 6;

const RINGS = TUBULAR_SEGMENTS + 1;
const VERTS_PER_WIRE = RINGS * RADIAL_SEGMENTS;
const INDICES_PER_WIRE = TUBULAR_SEGMENTS * RADIAL_SEGMENTS * 6;

/** Radius in metres. Real banana-plug lead insulation is about this thick. */
const WIRE_RADIUS = 0.003;

/** Endpoint movement below this is sensor jitter, not motion, and must not trigger a rebuild. */
const MOVE_EPSILON_SQ = 2e-4 * 2e-4;

// ---------------------------------------------------------------- shape

/**
 * Catenary profile, normalised: 0 at both ends, 1 at the midpoint.
 *
 * A parabola is the usual shortcut and is visually close, but the real curve of a hanging cable
 * is flatter near the middle and steeper at the clamps, and that is exactly the part the eye
 * reads as "this is hanging under its own weight". Tightness picks where on the cosh family we
 * sit: near 0 it degenerates to the parabola, large values look like a chain.
 */
const CATENARY_TIGHTNESS = 2.2;
const CATENARY_SPAN = Math.cosh(CATENARY_TIGHTNESS);

const catenaryDroop = (t: number): number =>
  (Math.cosh(CATENARY_TIGHTNESS * (2 * t - 1)) - CATENARY_SPAN) / (1 - CATENARY_SPAN);

/**
 * A short lead between adjacent terminals has little slack to give, so droop fades in over the
 * first few centimetres of span. Without this, two neighbouring terminals produce a wire that
 * dives through the bench surface.
 */
const SAG_FADE_SPAN = 0.12;

/** Minimum clearance between the higher terminal and the horizontal part of a straight run. */
const STRAIGHT_LIFT = 0.03;

/** Five legs plus both endpoints, with room to spare for the degenerate-leg compaction pass. */
const MAX_WAYPOINTS = 8;

/** Used when no `Bench` exists yet; matches the component's own default. */
const DEFAULT_GRID_STEP = 0.05;

// ---------------------------------------------------------------- flow animation

/** Pulses per metre of wire. One bright front every ~14 cm. */
const FLOW_CYCLES_PER_METRE = 7;

/**
 * The shared flow clock wraps here, in seconds. Per-wire rates are quantised to a whole number of
 * cycles per wrap (see {@link WireSystem.flowRateFor}), which makes the wrap seamless instead of a
 * visible reseed, and keeps the shader's time term small enough for float32 to stay smooth.
 */
const FLOW_WRAP_SECONDS = 60;

/** Current at which the pulse rate saturates. Beyond this, more amps only brighten. */
const FLOW_SATURATION_AMPS = 0.5;

/** Current above which the pulse is at full brightness. */
const FLOW_FULL_BRIGHT_AMPS = 0.05;

const FLOW_MIN_CYCLES_PER_SECOND = 0.35;
const FLOW_MAX_CYCLES_PER_SECOND = 3.5;

/** Below this the solver is reporting "no current", and the wire must sit perfectly still. */
const CURRENT_DEADBAND = 1e-7;

// ---------------------------------------------------------------- palette

/** Copper-red insulation: reads as a lab lead against both a dark bench and real passthrough. */
const COLOR_CONNECTED = 0xd4663a;

/** Amber while the user is still holding the loose end, so an unfinished wire is obvious. */
const COLOR_DANGLING = 0xf2b63c;

/** Cold blue-white for the travelling charge pulse — clearly not part of the insulation. */
const COLOR_PULSE = 0x9ef7ff;

// ---------------------------------------------------------------- material

/**
 * Per-vertex `aFlow` is `(arcMetres, signedCyclesPerSecond, pulseAmplitude)` and `aTint` is the
 * linear base colour. Shading is a cheap wrapped-Lambert key computed per vertex: on a 6 mm tube
 * per-pixel lighting is indistinguishable, and staying off three's light uniforms keeps this
 * material self-contained, so nothing here breaks when the scene's lighting changes.
 */
const WIRE_VERTEX_SHADER = /* glsl */ `
attribute vec3 aFlow;
attribute vec3 aTint;

uniform float uDensity;

varying vec3 vFlow;
varying vec3 vTint;
varying float vShade;

void main() {
  vec3 viewNormal = normalize(normalMatrix * normal);
  float key = dot(viewNormal, normalize(vec3(0.35, 0.78, 0.52)));
  vShade = 0.45 + 0.55 * (key * 0.5 + 0.5);

  // Fold the spatial frequency in here so the fragment stage only has to scroll it.
  vFlow = vec3(aFlow.x * uDensity, aFlow.y, aFlow.z);
  vTint = aTint;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * A travelling front rather than a dash train: `pow` on the sawtooth gives a bright head with a
 * fading tail, which reads as charge moving. A positive rate carries it from `from` towards `to`,
 * a negative rate reverses it, and zero amplitude leaves plain insulation with nothing moving.
 */
const WIRE_FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
uniform vec3 uPulse;

varying vec3 vFlow;
varying vec3 vTint;
varying float vShade;

void main() {
  float phase = fract(vFlow.x - uTime * vFlow.y);
  float pulse = pow(phase, 7.0) * vFlow.z;

  gl_FragColor = vec4(vTint * vShade + uPulse * pulse, 1.0);

  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------- slots

/**
 * One wire's reservation in the shared buffers, plus everything needed to answer "has anything
 * actually changed?" without touching the GPU. The cached endpoint positions are the reason a
 * still bench costs zero buffer traffic.
 */
interface WireSlot {
  readonly index: number;
  entity: Entity | null;
  /** Terminals as of the last build, so occupancy can be released even once the wire is gone. */
  fromTerminal: Entity | null;
  toTerminal: Entity | null;
  /** Last built endpoints, in the batch mesh's local space. */
  readonly fromPos: Vector3;
  readonly toPos: Vector3;
  /** Loose end written by the drag pass, consumed by the refresh pass in the same frame. */
  readonly dragEnd: Vector3;
  hasDragEnd: boolean;
  style: string;
  sag: number;
  gridStep: number;
  current: number;
  flowRate: number;
  flowAmplitude: number;
  tintHex: number;
  built: boolean;
}

/**
 * The live system instance, so the module-level API at the bottom of this file can be imported by
 * sibling systems without each of them having to fight `world.getSystem`'s generics for a handle.
 */
let active: WireSystem | undefined;

export class WireSystem extends createSystem({
  wires: { required: [Wire] },
  drags: { required: [WireDrag] },
  benches: { required: [BenchComponent] },
}) {
  // --- the single batched mesh -------------------------------------------------
  private batchEntity?: Entity;
  private batchMesh!: Mesh;
  private geometry!: BufferGeometry;
  private material!: ShaderMaterial;

  private positions!: Float32Array;
  private normals!: Float32Array;
  private flows!: Float32Array;
  private tints!: Float32Array;

  private positionAttr!: BufferAttribute;
  private normalAttr!: BufferAttribute;
  private flowAttr!: BufferAttribute;
  private tintAttr!: BufferAttribute;

  private positionsDirty = false;
  private flowsDirty = false;
  private tintsDirty = false;

  // --- slot bookkeeping --------------------------------------------------------
  private readonly slots: WireSlot[] = [];
  private readonly freeSlots: number[] = [];
  private readonly slotFor = new Map<Entity, WireSlot>();
  private warnedFull = false;

  // --- the bench whose grid straight routes snap to ----------------------------
  private benchEntity?: Entity;

  // --- flow clock --------------------------------------------------------------
  private flowClock = 0;

  // Everything below is allocated once. A per-frame allocation in an XR app is a frame-time bug,
  // and a wire being dragged rebuilds its geometry on every single frame.
  private readonly fromPoint = new Vector3();
  private readonly toPoint = new Vector3();
  private readonly scratch = new Vector3();
  private readonly tangent = new Vector3();
  private readonly lastTangent = new Vector3(0, 0, 1);
  private readonly helper = new Vector3();
  private readonly axisU = new Vector3();
  private readonly axisV = new Vector3();
  private readonly tintColor = new Color();
  private readonly ringPoints: Vector3[] = [];
  private readonly waypoints: Vector3[] = [];
  private ringArc!: Float32Array;
  private radialCos!: Float32Array;
  private radialSin!: Float32Array;
  private waypointCount = 0;

  // Bound once, so the per-frame `Set.forEach` walks do not allocate a closure each tick.
  private readonly pullDraggedEnd = (entity: Entity): void => this.onDrag(entity);
  private readonly refreshWire = (entity: Entity): void => this.onWire(entity);

  init(): void {
    this.allocateScratch();
    this.buildBatch();
    this.allocateSlots();

    active = this;

    this.cleanupFuncs.push(
      // Slot allocation lives on the query rather than in `createWire`, so a wire authored in
      // scene JSON gets its slot on exactly the same path as one created at runtime.
      this.queries.wires.subscribe('qualify', (entity) => this.attachSlot(entity), true),
      this.queries.wires.subscribe('disqualify', (entity) => this.releaseSlot(entity)),
      this.queries.benches.subscribe(
        'qualify',
        (entity) => {
          this.benchEntity = entity;
        },
        true,
      ),
      this.queries.benches.subscribe('disqualify', (entity) => {
        if (entity === this.benchEntity) {
          this.benchEntity = undefined;
        }
      }),
      () => {
        // `dispose()`, never `destroy()`: it frees the shared geometry and material with the
        // entity instead of leaking them.
        this.batchEntity?.dispose();
        this.batchEntity = undefined;
        this.slotFor.clear();
        this.freeSlots.length = 0;
        this.slots.length = 0;
        if (active === this) {
          active = undefined;
        }
      },
    );
  }

  // ------------------------------------------------------------------ setup

  private allocateScratch(): void {
    this.ringArc = new Float32Array(RINGS);
    for (let i = 0; i < RINGS; i++) {
      this.ringPoints.push(new Vector3());
    }
    for (let i = 0; i < MAX_WAYPOINTS; i++) {
      this.waypoints.push(new Vector3());
    }

    // The cross-section never changes, so its trig is a table rather than work done per rebuild.
    this.radialCos = new Float32Array(RADIAL_SEGMENTS);
    this.radialSin = new Float32Array(RADIAL_SEGMENTS);
    for (let j = 0; j < RADIAL_SEGMENTS; j++) {
      const theta = (j / RADIAL_SEGMENTS) * Math.PI * 2;
      this.radialCos[j] = Math.cos(theta);
      this.radialSin[j] = Math.sin(theta);
    }
  }

  private buildBatch(): void {
    const vertexCount = MAX_WIRES * VERTS_PER_WIRE;

    this.positions = new Float32Array(vertexCount * 3);
    this.normals = new Float32Array(vertexCount * 3);
    this.flows = new Float32Array(vertexCount * 3);
    this.tints = new Float32Array(vertexCount * 3);

    this.positionAttr = new BufferAttribute(this.positions, 3).setUsage(DynamicDrawUsage);
    this.normalAttr = new BufferAttribute(this.normals, 3).setUsage(DynamicDrawUsage);
    this.flowAttr = new BufferAttribute(this.flows, 3).setUsage(DynamicDrawUsage);
    this.tintAttr = new BufferAttribute(this.tints, 3).setUsage(DynamicDrawUsage);

    this.geometry = new BufferGeometry();
    this.geometry.setAttribute('position', this.positionAttr);
    this.geometry.setAttribute('normal', this.normalAttr);
    this.geometry.setAttribute('aFlow', this.flowAttr);
    this.geometry.setAttribute('aTint', this.tintAttr);
    this.geometry.setIndex(new BufferAttribute(this.buildIndices(), 1));

    this.material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uDensity: { value: FLOW_CYCLES_PER_METRE },
        uPulse: { value: new Color(COLOR_PULSE) },
      },
      vertexShader: WIRE_VERTEX_SHADER,
      fragmentShader: WIRE_FRAGMENT_SHADER,
      // A 6 mm tube costs nothing to shade twice, and in AR the camera routinely passes through a
      // lead on its way to the bench — double-siding keeps it from vanishing from the inside.
      side: DoubleSide,
    });

    this.batchMesh = new Mesh(this.geometry, this.material);
    this.batchMesh.name = 'FieldForgeWires';
    // A bounding volume would be stale the moment any wire moves, and one mesh is not worth a
    // per-frame recompute just to cull it.
    this.batchMesh.frustumCulled = false;

    // Persistent: this batch is system-owned infrastructure and must outlive a level swap, even
    // though the wire entities drawn inside it are level-scoped and released with their level.
    this.batchEntity = this.world.createTransformEntity(this.batchMesh, { persistent: true });
  }

  /**
   * Topology is identical for every slot and never changes, so the index buffer is written once.
   *
   * Winding is `(a, b, c)` / `(b, d, c)` against the ring frame built as `u = helper x tangent`
   * and `v = tangent x u`, which puts the geometric normal on the outside of the tube.
   */
  private buildIndices(): Uint16Array {
    // MAX_WIRES * VERTS_PER_WIRE is 5568, comfortably inside Uint16's 65536 vertex ceiling.
    const indices = new Uint16Array(MAX_WIRES * INDICES_PER_WIRE);
    let write = 0;
    for (let slot = 0; slot < MAX_WIRES; slot++) {
      const base = slot * VERTS_PER_WIRE;
      for (let i = 0; i < TUBULAR_SEGMENTS; i++) {
        const ring = base + i * RADIAL_SEGMENTS;
        for (let j = 0; j < RADIAL_SEGMENTS; j++) {
          const a = ring + j;
          const b = ring + ((j + 1) % RADIAL_SEGMENTS);
          const c = a + RADIAL_SEGMENTS;
          const d = b + RADIAL_SEGMENTS;
          indices[write++] = a;
          indices[write++] = b;
          indices[write++] = c;
          indices[write++] = b;
          indices[write++] = d;
          indices[write++] = c;
        }
      }
    }
    return indices;
  }

  private allocateSlots(): void {
    for (let index = 0; index < MAX_WIRES; index++) {
      this.slots.push({
        index,
        entity: null,
        fromTerminal: null,
        toTerminal: null,
        fromPos: new Vector3(),
        toPos: new Vector3(),
        dragEnd: new Vector3(),
        hasDragEnd: false,
        style: '',
        sag: -1,
        gridStep: -1,
        current: 0,
        flowRate: 0,
        flowAmplitude: 0,
        tintHex: 0,
        built: false,
      });
      // Hand them out lowest-index-first, so a lightly used bench keeps its vertices contiguous.
      this.freeSlots.push(MAX_WIRES - 1 - index);
    }
  }

  // ------------------------------------------------------------------ slot lifecycle

  private attachSlot(entity: Entity): void {
    if (this.slotFor.has(entity)) {
      return;
    }
    const index = this.freeSlots.pop();
    if (index === undefined) {
      if (!this.warnedFull) {
        this.warnedFull = true;
        console.warn(
          `[WireSystem] all ${MAX_WIRES} wire slots are in use; further wires will not render.`,
        );
      }
      return;
    }
    const slot = this.slots[index];
    slot.entity = entity;
    slot.fromTerminal = null;
    slot.toTerminal = null;
    slot.style = '';
    slot.sag = -1;
    slot.gridStep = -1;
    slot.current = 0;
    slot.flowRate = 0;
    slot.flowAmplitude = 0;
    slot.tintHex = 0;
    slot.hasDragEnd = false;
    slot.built = false;
    this.slotFor.set(entity, slot);
    this.hideSlot(slot);
  }

  /**
   * Called when a `Wire` component goes away for any reason, including another system disposing
   * the entity. Component data is no longer safe to read at that point, so occupancy is released
   * from the terminals cached on the slot instead of from the component.
   */
  private releaseSlot(entity: Entity): void {
    const slot = this.slotFor.get(entity);
    if (slot == null) {
      return;
    }
    this.slotFor.delete(entity);
    slot.entity = null;
    const from = slot.fromTerminal;
    const to = slot.toTerminal;
    slot.fromTerminal = null;
    slot.toTerminal = null;
    slot.built = false;
    this.hideSlot(slot);
    this.freeSlots.push(slot.index);
    this.warnedFull = false;
    // Only after the slot is cleared, or these would see this wire still holding the terminals.
    this.freeTerminal(from);
    this.freeTerminal(to);
  }

  /** Collapse a slot's vertices onto a point: zero-area triangles rasterise nothing. */
  private hideSlot(slot: WireSlot): void {
    const start = slot.index * VERTS_PER_WIRE * 3;
    const end = start + VERTS_PER_WIRE * 3;
    this.positions.fill(0, start, end);
    this.flows.fill(0, start, end);
    this.positionsDirty = true;
    this.flowsDirty = true;
  }

  // ------------------------------------------------------------------ per frame

  update(delta: number): void {
    // A blurred or hidden session is not presenting frames; spending time on it is pure waste.
    const visibility = this.visibilityState.peek();
    if (visibility === VisibilityState.VisibleBlurred || visibility === VisibilityState.Hidden) {
      return;
    }

    this.flowClock = (this.flowClock + delta) % FLOW_WRAP_SECONDS;
    this.material.uniforms.uTime.value = this.flowClock;

    // Everything is built in the batch mesh's own space, so its world matrix has to be current
    // before any `worldToLocal` below.
    this.batchMesh.updateWorldMatrix(true, false);

    // Drags first: they publish a loose end that the refresh pass consumes in the same frame.
    this.queries.drags.entities.forEach(this.pullDraggedEnd);
    this.queries.wires.entities.forEach(this.refreshWire);

    this.flush();
  }

  /** Upload only what actually changed. A still bench uploads nothing at all. */
  private flush(): void {
    if (this.positionsDirty) {
      this.positionAttr.needsUpdate = true;
      this.normalAttr.needsUpdate = true;
      this.positionsDirty = false;
    }
    if (this.flowsDirty) {
      this.flowAttr.needsUpdate = true;
      this.flowsDirty = false;
    }
    if (this.tintsDirty) {
      this.tintAttr.needsUpdate = true;
      this.tintsDirty = false;
    }
  }

  /**
   * Park the loose end of a dragged wire on that hand's index fingertip.
   *
   * `WireDrag` carries a `wire` field, which reads as "this component lives on a separate drag
   * entity", while the loose-end behaviour is described as belonging to the wire itself. Both
   * conventions are accepted here, so whichever system adds `WireDrag` is right either way.
   */
  private onDrag(entity: Entity): void {
    const referenced = entity.getValue(WireDrag, 'wire');
    const wire =
      referenced != null && referenced.active && referenced.hasComponent(Wire)
        ? referenced
        : entity.hasComponent(Wire)
          ? entity
          : null;
    const slot = wire == null ? undefined : this.slotFor.get(wire);
    if (slot == null) {
      return;
    }

    const hand = entity.getValue(WireDrag, 'hand') ?? 1;
    if (!this.fingertipPosition(hand, slot.dragEnd)) {
      return;
    }
    slot.hasDragEnd = true;
  }

  private onWire(entity: Entity): void {
    const slot = this.slotFor.get(entity);
    if (slot == null) {
      return;
    }

    const fromTerminal = entity.getValue(Wire, 'from');
    const toTerminal = entity.getValue(Wire, 'to');
    const dragging = slot.hasDragEnd;
    slot.hasDragEnd = false;

    const hasFrom = this.terminalPosition(fromTerminal, this.fromPoint);
    const hasTo = dragging
      ? (this.toPoint.copy(slot.dragEnd), true)
      : this.terminalPosition(toTerminal, this.toPoint);

    if (!hasFrom || !hasTo) {
      // A wire with only one end placed yet has nothing honest to draw.
      if (slot.built) {
        this.hideSlot(slot);
        slot.built = false;
      }
      return;
    }

    slot.fromTerminal = fromTerminal;
    slot.toTerminal = toTerminal;

    this.batchMesh.worldToLocal(this.fromPoint);
    this.batchMesh.worldToLocal(this.toPoint);

    // A lead held in the hand hangs, whatever the wire's configured style says: right-angled
    // routing to a fingertip in mid-air reads as a bug, not as a schematic.
    const requested = entity.getValue(Wire, 'style') ?? WireStyle.Flexible;
    const style = dragging ? WireStyle.Flexible : requested;
    const sag = entity.getValue(Wire, 'sag') ?? 0.05;
    const gridStep = this.gridStep();

    const moved =
      this.fromPoint.distanceToSquared(slot.fromPos) > MOVE_EPSILON_SQ ||
      this.toPoint.distanceToSquared(slot.toPos) > MOVE_EPSILON_SQ;

    if (
      !slot.built ||
      moved ||
      style !== slot.style ||
      Math.abs(sag - slot.sag) > 1e-4 ||
      Math.abs(gridStep - slot.gridStep) > 1e-5
    ) {
      slot.style = style;
      slot.sag = sag;
      slot.gridStep = gridStep;
      this.rebuild(slot, entity);
    }

    const dangling = (entity.getValue(Wire, 'dangling') ?? false) || dragging;
    const tintHex = dangling ? COLOR_DANGLING : COLOR_CONNECTED;
    if (tintHex !== slot.tintHex) {
      this.writeTint(slot, tintHex);
    }

    // The solver owns `current`. All this does is read it.
    const current = entity.getValue(Wire, 'current') ?? 0;
    if (Math.abs(current - slot.current) > CURRENT_DEADBAND) {
      slot.current = current;
      this.writeFlow(slot, this.flowRateFor(current), this.flowAmplitudeFor(current));
    }
  }

  // ------------------------------------------------------------------ path construction

  private rebuild(slot: WireSlot, entity: Entity): void {
    const sampled =
      slot.style === WireStyle.Straight
        ? this.sampleStraight(slot.gridStep)
        : this.sampleFlexible(slot.sag);

    if (!sampled) {
      this.hideSlot(slot);
      slot.built = false;
      return;
    }

    this.writeTube(slot);
    slot.fromPos.copy(this.fromPoint);
    slot.toPos.copy(this.toPoint);
    slot.built = true;

    // Give the wire entity's own transform a sensible home at the path midpoint, so labels, ray
    // picking and selection highlights have something to attach to later.
    const object = entity.object3D;
    if (object != null) {
      this.scratch.copy(this.ringPoints[TUBULAR_SEGMENTS >> 1]);
      this.batchMesh.localToWorld(this.scratch);
      if (object.parent != null) {
        object.parent.updateWorldMatrix(true, false);
        object.parent.worldToLocal(this.scratch);
      }
      object.position.copy(this.scratch);
    }
  }

  /** Hang a catenary between the endpoints, recording true arc length as we go. */
  private sampleFlexible(sag: number): boolean {
    const span = this.fromPoint.distanceTo(this.toPoint);
    if (span < 1e-5) {
      return false;
    }
    const droop = sag * Math.min(1, span / SAG_FADE_SPAN);

    let arc = 0;
    for (let i = 0; i < RINGS; i++) {
      const t = i / TUBULAR_SEGMENTS;
      const point = this.ringPoints[i];
      point.lerpVectors(this.fromPoint, this.toPoint, t);
      point.y -= droop * catenaryDroop(t);
      if (i > 0) {
        arc += point.distanceTo(this.ringPoints[i - 1]);
      }
      this.ringArc[i] = arc;
    }
    return true;
  }

  /**
   * Manhattan routing, resampled onto the fixed ring count.
   *
   * The five legs are: rise out of `from`, run in X, cross in Z, run in X again, drop into `to`.
   * The crossing column and the run height are snapped to the bench grid *in the bench's own
   * frame*, which is what makes neighbouring wires share lines instead of near-missing each
   * other — a bench anchored to a real desk is rarely axis-aligned with the world.
   */
  private sampleStraight(gridStep: number): boolean {
    const bench = this.benchEntity?.object3D;
    if (bench != null) {
      bench.updateWorldMatrix(true, false);
      bench.worldToLocal(this.batchMesh.localToWorld(this.fromPoint));
      bench.worldToLocal(this.batchMesh.localToWorld(this.toPoint));
    }

    const a = this.fromPoint;
    const b = this.toPoint;
    // Horizontal runs stack on half-grid levels above the bench surface. Snapping to the full
    // grid would jump a run a whole 5 cm the moment a terminal crept past a cell boundary.
    const level = gridStep * 0.5;
    const height = Math.ceil((Math.max(a.y, b.y) + STRAIGHT_LIFT) / level) * level;
    const column = Math.round((a.x + b.x) / (2 * gridStep)) * gridStep;

    this.waypointCount = 0;
    this.pushWaypoint(a.x, a.y, a.z);
    this.pushWaypoint(a.x, height, a.z);
    this.pushWaypoint(column, height, a.z);
    this.pushWaypoint(column, height, b.z);
    this.pushWaypoint(b.x, height, b.z);
    this.pushWaypoint(b.x, b.y, b.z);

    if (bench != null) {
      // Back into the batch mesh's space, and restore the endpoints the caller cached against.
      for (let i = 0; i < this.waypointCount; i++) {
        this.batchMesh.worldToLocal(bench.localToWorld(this.waypoints[i]));
      }
      this.batchMesh.worldToLocal(bench.localToWorld(a));
      this.batchMesh.worldToLocal(bench.localToWorld(b));
    }

    return this.resampleWaypoints();
  }

  /** Append a waypoint, dropping legs too short to survive the arc-length walk. */
  private pushWaypoint(x: number, y: number, z: number): void {
    if (this.waypointCount > 0) {
      const previous = this.waypoints[this.waypointCount - 1];
      if (
        Math.abs(previous.x - x) < 1e-5 &&
        Math.abs(previous.y - y) < 1e-5 &&
        Math.abs(previous.z - z) < 1e-5
      ) {
        return;
      }
    }
    if (this.waypointCount >= MAX_WAYPOINTS) {
      return;
    }
    this.waypoints[this.waypointCount++].set(x, y, z);
  }

  /** Walk the polyline once, emitting evenly spaced ring centres and their arc lengths. */
  private resampleWaypoints(): boolean {
    if (this.waypointCount < 2) {
      return false;
    }

    let total = 0;
    for (let i = 1; i < this.waypointCount; i++) {
      total += this.waypoints[i].distanceTo(this.waypoints[i - 1]);
    }
    if (total < 1e-5) {
      return false;
    }

    let leg = 0;
    let legStart = 0;
    let legLength = this.waypoints[1].distanceTo(this.waypoints[0]);

    for (let i = 0; i < RINGS; i++) {
      const distance = (total * i) / TUBULAR_SEGMENTS;
      while (leg < this.waypointCount - 2 && distance > legStart + legLength) {
        legStart += legLength;
        leg++;
        legLength = this.waypoints[leg + 1].distanceTo(this.waypoints[leg]);
      }
      const t = legLength > 1e-9 ? Math.min(1, Math.max(0, (distance - legStart) / legLength)) : 0;
      this.ringPoints[i].lerpVectors(this.waypoints[leg], this.waypoints[leg + 1], t);
      this.ringArc[i] = distance;
    }
    return true;
  }

  // ------------------------------------------------------------------ buffer writes

  /**
   * Sweep the hexagonal cross-section along the sampled ring centres.
   *
   * The frame is built from a fixed helper axis rather than parallel-transported, so it flips
   * where a run turns vertical. That is deliberate and invisible: the tube carries no UVs and is
   * radially symmetric, so only the normals matter and those stay correct through the flip.
   */
  private writeTube(slot: WireSlot): void {
    const base = slot.index * VERTS_PER_WIRE;
    const rate = slot.flowRate;
    const amplitude = slot.flowAmplitude;

    for (let i = 0; i < RINGS; i++) {
      const centre = this.ringPoints[i];
      const previous = this.ringPoints[i > 0 ? i - 1 : 0];
      const next = this.ringPoints[i < RINGS - 1 ? i + 1 : RINGS - 1];

      // Central difference: at a hard corner this rounds the frame over one segment instead of
      // pinching the tube, which is exactly what a real bent lead does.
      this.tangent.copy(next).sub(previous);
      if (this.tangent.lengthSq() < 1e-12) {
        this.tangent.copy(this.lastTangent);
      } else {
        this.tangent.normalize();
      }
      this.lastTangent.copy(this.tangent);

      this.helper.set(0, 1, 0);
      if (Math.abs(this.tangent.y) > 0.99) {
        this.helper.set(0, 0, 1);
      }
      this.axisU.crossVectors(this.helper, this.tangent).normalize();
      this.axisV.crossVectors(this.tangent, this.axisU).normalize();

      const arc = this.ringArc[i];
      const ring = (base + i * RADIAL_SEGMENTS) * 3;

      for (let j = 0; j < RADIAL_SEGMENTS; j++) {
        const c = this.radialCos[j];
        const s = this.radialSin[j];
        const nx = this.axisU.x * c + this.axisV.x * s;
        const ny = this.axisU.y * c + this.axisV.y * s;
        const nz = this.axisU.z * c + this.axisV.z * s;

        const offset = ring + j * 3;
        this.positions[offset] = centre.x + nx * WIRE_RADIUS;
        this.positions[offset + 1] = centre.y + ny * WIRE_RADIUS;
        this.positions[offset + 2] = centre.z + nz * WIRE_RADIUS;
        this.normals[offset] = nx;
        this.normals[offset + 1] = ny;
        this.normals[offset + 2] = nz;
        this.flows[offset] = arc;
        this.flows[offset + 1] = rate;
        this.flows[offset + 2] = amplitude;
      }
    }

    this.positionsDirty = true;
    this.flowsDirty = true;
  }

  private writeFlow(slot: WireSlot, rate: number, amplitude: number): void {
    slot.flowRate = rate;
    slot.flowAmplitude = amplitude;
    const start = slot.index * VERTS_PER_WIRE * 3;
    for (let i = 0; i < VERTS_PER_WIRE; i++) {
      const offset = start + i * 3;
      this.flows[offset + 1] = rate;
      this.flows[offset + 2] = amplitude;
    }
    this.flowsDirty = true;
  }

  private writeTint(slot: WireSlot, hex: number): void {
    slot.tintHex = hex;
    // Three's colour management reads a hex literal as sRGB and stores it linear, which is the
    // space the shader works in before `colorspace_fragment` converts back on output.
    this.tintColor.setHex(hex);
    const start = slot.index * VERTS_PER_WIRE * 3;
    for (let i = 0; i < VERTS_PER_WIRE; i++) {
      const offset = start + i * 3;
      this.tints[offset] = this.tintColor.r;
      this.tints[offset + 1] = this.tintColor.g;
      this.tints[offset + 2] = this.tintColor.b;
    }
    this.tintsDirty = true;
  }

  // ------------------------------------------------------------------ current to animation

  /**
   * Signed pulses per second for a given current, quantised so a whole number of cycles fits in
   * {@link FLOW_WRAP_SECONDS}. That quantisation is what lets the shared flow clock wrap without
   * any wire visibly jumping, and the error is under 2% even at the slowest rate.
   *
   * Direction follows the sign: positive current carries the pulse from `from` towards `to`.
   */
  private flowRateFor(current: number): number {
    const magnitude = Math.abs(current);
    if (magnitude <= CURRENT_DEADBAND) {
      return 0;
    }
    const t = Math.min(1, magnitude / FLOW_SATURATION_AMPS);
    const rate =
      FLOW_MIN_CYCLES_PER_SECOND + (FLOW_MAX_CYCLES_PER_SECOND - FLOW_MIN_CYCLES_PER_SECOND) * t;
    const quantised = Math.round(rate * FLOW_WRAP_SECONDS) / FLOW_WRAP_SECONDS;
    return current < 0 ? -quantised : quantised;
  }

  /** Zero current means a plain, still wire. Any current at all is visible; more is brighter. */
  private flowAmplitudeFor(current: number): number {
    const magnitude = Math.abs(current);
    if (magnitude <= CURRENT_DEADBAND) {
      return 0;
    }
    return 0.35 + 0.65 * Math.min(1, magnitude / FLOW_FULL_BRIGHT_AMPS);
  }

  // ------------------------------------------------------------------ lookups

  private gridStep(): number {
    const step = this.benchEntity?.getValue(BenchComponent, 'gridStep');
    return step != null && step > 1e-4 ? step : DEFAULT_GRID_STEP;
  }

  /** World position of a terminal, falling back to its owning part if it has no object of its own. */
  private terminalPosition(terminal: Entity | null, out: Vector3): boolean {
    if (terminal == null || !terminal.active) {
      return false;
    }
    let object: SceneObject | undefined = terminal.object3D;
    if (object == null && terminal.hasComponent(Terminal)) {
      object = terminal.getValue(Terminal, 'owner')?.object3D;
    }
    if (object == null) {
      return false;
    }
    object.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(object.matrixWorld);
    return true;
  }

  /**
   * World position of a hand's index fingertip.
   *
   * Read through `world.playerSpaceEntities.indexTipSpaces`, which is `{ left: Entity; right:
   * Entity }` — each entity wrapping the matching `Group` on the XR rig. `@iwsdk/xr-input` writes
   * the hand-tracked fingertip joint into these while hands are active, and copies the
   * controller's target-ray pose into them otherwise, so no controller fallback is needed here.
   * Outside an XR session they sit at the rig origin.
   */
  private fingertipPosition(hand: number, out: Vector3): boolean {
    const spaces = this.world.playerSpaceEntities.indexTipSpaces;
    const entity = hand === 0 ? spaces.left : spaces.right;
    const object =
      entity.object3D ??
      (hand === 0 ? this.player.indexTipSpaces.left : this.player.indexTipSpaces.right);
    if (object == null) {
      return false;
    }
    object.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(object.matrixWorld);
    return true;
  }

  // ------------------------------------------------------------------ public API

  /**
   * Wire two terminals together.
   *
   * Returns `null` rather than a half-made wire when the pair cannot be connected: the same
   * terminal twice, a `Mount` (structural terminals hold parts, not current), a pair that is
   * already wired, or no free slot left. Callers get to tell the user which.
   */
  createWire(from: Entity, to: Entity, style?: WireStyleValue): Entity | null {
    if (from === to || !this.connectable(from) || !this.connectable(to)) {
      return null;
    }
    if (this.findWireBetween(from, to) != null) {
      return null;
    }

    const entity = this.world.createTransformEntity();
    if (entity.object3D != null) {
      entity.object3D.name = 'FieldForgeWire';
    }
    entity.addComponent(Wire, {
      from,
      to,
      style: style ?? WireStyle.Flexible,
      dangling: false,
    });
    this.occupy(from);
    this.occupy(to);
    return entity;
  }

  /** Switch a wire between catenary and grid-routed. The rebuild happens on the next frame. */
  setStyle(wire: Entity, style: WireStyleValue): void {
    if (!wire.active || !wire.hasComponent(Wire)) {
      return;
    }
    wire.setValue(Wire, 'style', style);
  }

  /**
   * Start pulling a new lead out of a terminal. The returned wire has no `to` yet; its loose end
   * follows the given hand's fingertip until {@link completeDrag} or {@link cancelDrag}.
   */
  beginDrag(fromTerminal: Entity, hand: WireHand): Entity | null {
    if (!this.connectable(fromTerminal)) {
      return null;
    }

    const entity = this.world.createTransformEntity();
    if (entity.object3D != null) {
      entity.object3D.name = 'FieldForgeWire';
    }
    entity.addComponent(Wire, {
      from: fromTerminal,
      to: null,
      style: WireStyle.Flexible,
      dangling: true,
    });
    entity.addComponent(WireDrag, { wire: entity, hand: normaliseHand(hand) });
    this.occupy(fromTerminal);
    return entity;
  }

  /** Land a dragged lead on its second terminal. False if that terminal cannot take it. */
  completeDrag(wire: Entity, toTerminal: Entity): boolean {
    if (!wire.active || !wire.hasComponent(Wire)) {
      return false;
    }
    const from = wire.getValue(Wire, 'from');
    if (toTerminal === from || !this.connectable(toTerminal)) {
      return false;
    }
    if (from != null && this.findWireBetween(from, toTerminal) != null) {
      return false;
    }

    wire.setValue(Wire, 'to', toTerminal);
    wire.setValue(Wire, 'dangling', false);
    if (wire.hasComponent(WireDrag)) {
      wire.removeComponent(WireDrag);
    }
    this.occupy(toTerminal);
    return true;
  }

  /** Abandon a drag: the half-made wire goes away and its terminal is freed. */
  cancelDrag(wire: Entity): void {
    this.removeWire(wire);
  }

  /** Remove a wire and release both of its terminals. */
  removeWire(wire: Entity): void {
    if (!wire.active) {
      return;
    }
    if (wire.hasComponent(WireDrag)) {
      wire.removeComponent(WireDrag);
    }
    // `dispose()`, never `destroy()`: the latter leaks the entity's GPU resources. Removing the
    // `Wire` component (or disposing) fires the query's `disqualify`, which frees the slot and
    // releases both terminals.
    wire.dispose();
  }

  // ------------------------------------------------------------------ terminal bookkeeping

  /**
   * Only an `Electrical` terminal can take a wire.
   *
   * Checking "not Mount" would also accept `Field` nodes — the probe point at the centre of a
   * charge — which carry no current by definition. The kind field exists so this can be stated
   * rather than inferred, and terminals.ts matches kinds exactly in the same way when it decides
   * what to highlight.
   */
  private connectable(terminal: Entity | null): boolean {
    if (terminal == null || !terminal.active || !terminal.hasComponent(Terminal)) {
      return false;
    }
    return terminal.getValue(Terminal, 'kind') === TerminalKind.Electrical;
  }

  private occupy(terminal: Entity): void {
    if (terminal.active && terminal.hasComponent(Terminal)) {
      terminal.setValue(Terminal, 'occupied', true);
    }
  }

  /** Clear `occupied` only once no other wire is still attached — jacks can stack. */
  private freeTerminal(terminal: Entity | null): void {
    if (terminal == null || !terminal.active || !terminal.hasComponent(Terminal)) {
      return;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const entity = this.slots[i].entity;
      if (entity == null || !entity.active || !entity.hasComponent(Wire)) {
        continue;
      }
      if (entity.getValue(Wire, 'from') === terminal || entity.getValue(Wire, 'to') === terminal) {
        return;
      }
    }
    terminal.setValue(Terminal, 'occupied', false);
  }

  private findWireBetween(a: Entity, b: Entity): Entity | null {
    for (let i = 0; i < this.slots.length; i++) {
      const entity = this.slots[i].entity;
      if (entity == null || !entity.active || !entity.hasComponent(Wire)) {
        continue;
      }
      const from = entity.getValue(Wire, 'from');
      const to = entity.getValue(Wire, 'to');
      if ((from === a && to === b) || (from === b && to === a)) {
        return entity;
      }
    }
    return null;
  }
}

/** `WireDrag.hand` is stored as 0 for left and 1 for right; accept the friendlier spellings too. */
const normaliseHand = (hand: WireHand): number => (hand === 'left' || hand === 0 ? 0 : 1);

// ---------------------------------------------------------------- module-level API
//
// Sibling systems import these rather than reaching for the instance: `world.getSystem` is generic
// over a system's query and schema types, which makes a plain handle awkward to type at every call
// site. Each one is a no-op until `WireSystem` has been registered in `src/index.ts`.

/** See {@link WireSystem.createWire}. */
export function createWire(from: Entity, to: Entity, style?: WireStyleValue): Entity | null {
  return active?.createWire(from, to, style) ?? null;
}

/** See {@link WireSystem.setStyle}. */
export function setStyle(wire: Entity, style: WireStyleValue): void {
  active?.setStyle(wire, style);
}

/** See {@link WireSystem.beginDrag}. */
export function beginDrag(fromTerminal: Entity, hand: WireHand): Entity | null {
  return active?.beginDrag(fromTerminal, hand) ?? null;
}

/** See {@link WireSystem.completeDrag}. */
export function completeDrag(wire: Entity, toTerminal: Entity): boolean {
  return active?.completeDrag(wire, toTerminal) ?? false;
}

/** See {@link WireSystem.cancelDrag}. */
export function cancelDrag(wire: Entity): void {
  active?.cancelDrag(wire);
}

/** See {@link WireSystem.removeWire}. */
export function removeWire(wire: Entity): void {
  active?.removeWire(wire);
}
