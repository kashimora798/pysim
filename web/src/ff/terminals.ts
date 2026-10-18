/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Terminals: the small nodes a wire is allowed to land on.
 *
 * A wire never attaches to a part. It attaches to a terminal, and a terminal carries a *kind*, so
 * the illegal connections are impossible rather than merely discouraged: no current can flow into
 * a point charge, so a point charge gets a `Field` node and an electrical wire query can never
 * return it. That single rule is the whole reason `Terminal.kind` exists.
 *
 * Each terminal is its own entity, parented under its part, so it rides along for free when the
 * part is moved or grabbed. There is no per-frame follow code here.
 *
 * Three things in this file are non-obvious and were verified against the installed sources
 * rather than assumed:
 *
 *   1. `entity.dispose()` defaults to `disposeResources: true`, which traverses the entity's
 *      Object3D and disposes its geometry *and* its material
 *      (node_modules/@iwsdk/core/dist/ecs/world.js, `disposeObject3DResources`). Every terminal
 *      here shares one geometry and one of two materials, so a default dispose of a single
 *      terminal would blank every other terminal on the bench. We always pass
 *      `{ disposeResources: false }` and own the shared resources ourselves, releasing them in
 *      `cleanupFuncs`.
 *   2. `Transform` defaults position/orientation/scale to `NaN`
 *      (dist/transform/transform-component.js), and `attachToEntity` reads NaN as "no authored
 *      value" and copies the Object3D's own transform into component storage. So a transform set
 *      on the mesh *before* `createTransformEntity` is preserved, not clobbered. After attachment
 *      `object3D.position` *is* the `getVectorView` onto `Transform.position`, which is why
 *      nothing here calls `getVectorView` by hand: `Terminal` has no vector fields, and the only
 *      vector we write is reached through that synced view.
 *   3. elics recycles `Entity` *objects* from a pool and bumps `generation`
 *      (node_modules/elics/lib/entity-manager.js), so an `Entity` held across frames can quietly
 *      become a different entity. We therefore keep no long-lived part-to-terminal map: ownership
 *      is read back from `Terminal.owner`, a generation-checked packed reference that resolves to
 *      `null` once the owner dies.
 *
 * ECS terms, once: a *query* is a live set of entities matching a component signature, and
 * `subscribe('qualify' | 'disqualify', ...)` fires as entities enter and leave it. That is how
 * terminals appear with their part and are cleaned up when it goes away.
 */

import {
  Box3,
  createSystem,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
  type Entity,
  type Object3D,
} from '@iwsdk/core';

import { Part, Terminal, TerminalKind } from './components.js';

// --------------------------------------------------------------------------- tuning

/**
 * How close a dragged wire end has to come before it snaps. 4 cm is a little under a fingertip:
 * forgiving enough for hand tracking without letting a wire jump to the wrong lead on a crowded
 * bench.
 */
export const DEFAULT_SNAP_RADIUS = 0.04;

/** Node bead radii, in metres. A mount is deliberately the quietest of the three. */
const NODE_RADIUS: Record<string, number> = {
  [TerminalKind.Electrical]: 0.006,
  [TerminalKind.Field]: 0.008,
  [TerminalKind.Mount]: 0.004,
};

/** Fallback radius for a terminal whose kind somehow is not in the table above. */
const DEFAULT_RADIUS = 0.006;

/** A highlighted node grows as well as brightens: colour alone is weak in bright passthrough. */
const HIGHLIGHT_SCALE = 1.7;

/** Shared-material pulse. One float write per frame lights every highlighted node at once. */
const PULSE_HZ = 1.4;
const PULSE_MIN = 0.62;
const PULSE_MAX = 1;

/** Used only when a part has no geometry to measure yet. Half the length of a typical part. */
const FALLBACK_HALF_LENGTH = 0.03;

/**
 * A glTF part's meshes arrive after its `Part` component does, so the first measurement can come
 * back empty. Re-measure a few times a second until it resolves, then stop costing anything.
 */
const RELAYOUT_INTERVAL = 0.25;
const MAX_LAYOUT_ATTEMPTS = 12;

/** Node meshes are skipped when measuring a part, or the layout would feed back on itself. */
const NODE_NAME = 'FFTerminalNode';

// --------------------------------------------------------------------------- layout table

/** The three values `Terminal.kind` may hold. */
export type TerminalKindValue = (typeof TerminalKind)[keyof typeof TerminalKind];

/** One terminal of a part, in port order. */
export interface TerminalSpec {
  /** Short glyph for labels and the trace caption: `a`/`b`, `+`/`-`, `q`, `m`. */
  readonly label: string;
  readonly kind: TerminalKindValue;
  /** Position along the part's own local X extent: -1 the min face, 0 the centre, +1 the max. */
  readonly along: -1 | 0 | 1;
}

/** Two leads, one at each end. `a` is the -X end. */
const ELECTRICAL_PAIR: readonly TerminalSpec[] = [
  { label: 'a', kind: TerminalKind.Electrical, along: -1 },
  { label: 'b', kind: TerminalKind.Electrical, along: 1 },
];

/**
 * A battery's ports are polarised, so they are labelled rather than lettered, and index 0 is the
 * positive one: the knowledge base describes a battery as the terminal current *leaves*, and a
 * reader looking at port 0 should find the terminal that statement is about.
 */
const BATTERY_PAIR: readonly TerminalSpec[] = [
  { label: '+', kind: TerminalKind.Electrical, along: 1 },
  { label: '-', kind: TerminalKind.Electrical, along: -1 },
];

/** A charge is a field source, not a circuit node: one centre node that refuses wires. */
const FIELD_NODE: readonly TerminalSpec[] = [
  { label: 'q', kind: TerminalKind.Field, along: 0 },
];

/** The default for anything with no electrical or field meaning: structural only. */
const MOUNT_NODE: readonly TerminalSpec[] = [
  { label: 'm', kind: TerminalKind.Mount, along: 0 },
];

/**
 * Terminal layout per `Part.kind`. Exported because the wire and parts systems both need a part's
 * port order and two copies of this table would drift.
 *
 * A kind absent from this table falls through to a single `Mount` node. That is a deliberate
 * default rather than an oversight: a part whose wiring semantics have not been decided must not
 * silently accept a wire.
 */
export const TERMINAL_LAYOUTS: Readonly<Record<string, readonly TerminalSpec[]>> = {
  resistor: ELECTRICAL_PAIR,
  lamp: ELECTRICAL_PAIR,
  capacitor: ELECTRICAL_PAIR,
  battery: BATTERY_PAIR,
  ammeter: ELECTRICAL_PAIR,
  voltmeter_dc: ELECTRICAL_PAIR,
  point_charge: FIELD_NODE,
  charged_particle: FIELD_NODE,
  electron: FIELD_NODE,
};

/** The terminals a part of this kind should carry. Never empty. */
export const terminalLayoutFor = (kind: string): readonly TerminalSpec[] =>
  TERMINAL_LAYOUTS[kind] ?? MOUNT_NODE;

// --------------------------------------------------------------------------- snapping options

/** Options for {@link nearestTerminal}. */
export interface NearestTerminalOptions {
  /** Search radius in metres. Defaults to {@link DEFAULT_SNAP_RADIUS}. */
  within?: number;
  /**
   * Which `TerminalKind` the caller can legally connect. Matching is exact, which is what keeps a
   * `Field` node out of an electrical result and an electrical lead out of a field result.
   * Defaults to `Electrical`, the case the wire system is asking about.
   */
  kind?: string;
  /** Skip every terminal belonging to this part, so a wire cannot short a part to itself. */
  excludeOwner?: Entity;
  /** Offer terminals that already have a wire on them. Off by default. */
  includeOccupied?: boolean;
}

// --------------------------------------------------------------------------- the system

export class TerminalSystem extends createSystem({
  parts: { required: [Part] },
  terminals: { required: [Terminal] },
}) {
  /**
   * One geometry and one material per visual state for the whole bench. A material per terminal
   * would mean a separate program binding per node; against an 11-14 ms frame budget that is not
   * a micro-optimisation. The geometry is a *unit* sphere so per-kind sizing is a scale on the
   * node rather than a second geometry.
   */
  private nodeGeometry!: SphereGeometry;
  private idleMaterial!: MeshBasicMaterial;
  private activeMaterial!: MeshBasicMaterial;

  /** Terminals currently lit as valid targets, so the pulse and `clearHighlights` stay cheap. */
  private highlighted!: Set<Entity>;

  /** Parts whose terminals came from fallback bounds, with their remaining retry budget. */
  private pending!: Entity[];
  private pendingAttempts!: number[];
  private relayoutTimer = 0;

  // Allocated once: a per-frame allocation in an XR app is a frame-time bug.
  private probe!: Vector3;
  private slot!: Vector3;
  private centre!: Vector3;
  private bounds!: Box3;
  private childBounds!: Box3;
  private invRoot!: Matrix4;
  private childMatrix!: Matrix4;
  /** Hoisted out of `measure` so the traversal callback is not rebuilt on every measurement. */
  private accumulate!: (child: Object3D) => void;
  /** Collects terminals before disposal, so we never mutate a query set mid-iteration. */
  private doomed!: Entity[];

  init(): void {
    this.probe = new Vector3();
    this.slot = new Vector3();
    this.centre = new Vector3();
    this.bounds = new Box3();
    this.childBounds = new Box3();
    this.invRoot = new Matrix4();
    this.childMatrix = new Matrix4();
    this.highlighted = new Set();
    this.pending = [];
    this.pendingAttempts = [];
    this.doomed = [];

    this.accumulate = (child: Object3D): void => {
      // Our own nodes hang under the part, so measuring them would grow the part every pass.
      if (child.name === NODE_NAME || child.visible === false) {
        return;
      }
      const geometry = (child as Object3D & GeometryBearing).geometry;
      if (geometry == null) {
        return;
      }
      if (geometry.boundingBox === null) {
        geometry.computeBoundingBox();
      }
      const box = geometry.boundingBox;
      if (box == null) {
        return;
      }
      // invRoot * childWorld is the child's transform relative to the part, so the union below
      // lands in the part's own local space however the part itself is placed in the room.
      this.childMatrix.multiplyMatrices(this.invRoot, child.matrixWorld);
      this.childBounds.copy(box).applyMatrix4(this.childMatrix);
      this.bounds.union(this.childBounds);
    };

    // A 10x6 sphere is about 100 triangles. Nobody will ever count them, and the low segment
    // count keeps twenty of these off the frame budget.
    this.nodeGeometry = new SphereGeometry(1, 10, 6);

    // Unlit on purpose: these are affordances, not objects in the scene, and must read the same
    // whichever way the user's real room happens to be lit. `depthWrite: false` keeps a bead from
    // z-fighting the surface it sits on, and `toneMapped: false` stops AR tone mapping from
    // washing the highlight back down towards the idle colour.
    this.idleMaterial = new MeshBasicMaterial({
      color: 0xc8a24a,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      toneMapped: false,
    });
    this.activeMaterial = new MeshBasicMaterial({
      color: 0x6cffd0,
      transparent: true,
      opacity: PULSE_MAX,
      depthWrite: false,
      toneMapped: false,
    });

    // Subscribe only once the shared resources exist: `replayExisting` runs the qualify callback
    // synchronously for parts that were already in the world when this system started.
    this.cleanupFuncs.push(
      this.queries.parts.subscribe('qualify', (part) => this.adopt(part), true),
      this.queries.parts.subscribe('disqualify', (part) => this.release(part)),
      this.queries.terminals.subscribe('disqualify', (terminal) => {
        this.highlighted.delete(terminal);
      }),
    );

    // We opted out of per-entity resource disposal, so the shared resources are ours to release.
    this.cleanupFuncs.push(() => {
      this.clearHighlights();
      this.pending.length = 0;
      this.pendingAttempts.length = 0;
      this.nodeGeometry.dispose();
      this.idleMaterial.dispose();
      this.activeMaterial.dispose();
      if (active === this) {
        active = null;
      }
    });

    active = this;
  }

  // ------------------------------------------------------------------ attach and detach

  /**
   * A part appeared: give it the terminals its kind calls for. Returns false when the part could
   * not be measured yet, in which case it has been queued for another pass.
   */
  private adopt(part: Entity): boolean {
    const object = part.object3D;
    if (object == null) {
      // Nothing to parent to yet. Retry rather than dropping the part on the floor.
      this.queue(part);
      return false;
    }
    const specs = terminalLayoutFor(part.getValue(Part, 'kind') ?? '');
    const measured = this.measure(object);

    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const mesh = new Mesh(this.nodeGeometry, this.idleMaterial);
      mesh.name = NODE_NAME;
      mesh.renderOrder = 1; // draw the bead over the part surface it is sitting on
      mesh.scale.setScalar(NODE_RADIUS[spec.kind] ?? DEFAULT_RADIUS);
      this.slotPosition(spec, measured);
      mesh.position.copy(this.slot);

      // Parented to the part, so moving the part moves its terminals with no code at all. The
      // transform set above survives because Transform's defaults are the NaN "unauthored"
      // sentinel; see the file header.
      const terminal = this.world.createTransformEntity(mesh, part);
      terminal.addComponent(Terminal, {
        owner: part,
        index: i,
        label: spec.label,
        kind: spec.kind,
        occupied: false,
      });
    }

    if (!measured) {
      this.queue(part);
    }
    return measured;
  }

  /**
   * A part went away: take its terminals with it.
   *
   * Reading `Terminal.owner` is safe here. `Entity.destroy` clears the bitmask and calls
   * `queryManager.resetEntity` (which is what fires this callback) *before*
   * `releaseEntityInstance`, so the owner's pooled slot and generation are still intact and its
   * packed reference still resolves to the entity we were handed.
   */
  private release(part: Entity): void {
    this.unqueue(part);

    this.doomed.length = 0;
    for (const terminal of this.queries.terminals.entities) {
      if (terminal.getValue(Terminal, 'owner') === part) {
        this.doomed.push(terminal);
      }
    }
    for (const terminal of this.doomed) {
      this.highlighted.delete(terminal);
      // `disposeResources: false` is load-bearing: the default would dispose the geometry and
      // material this terminal shares with every other terminal on the bench.
      terminal.dispose({ disposeResources: false });
    }
    this.doomed.length = 0;
  }

  /** Re-seat an existing part's terminals against freshly measured bounds. */
  private relayout(part: Entity): boolean {
    const object = part.object3D;
    if (object == null) {
      return false;
    }
    const specs = terminalLayoutFor(part.getValue(Part, 'kind') ?? '');
    const measured = this.measure(object);

    for (const terminal of this.queries.terminals.entities) {
      if (terminal.getValue(Terminal, 'owner') !== part) {
        continue;
      }
      const spec = specs[terminal.getValue(Terminal, 'index') ?? 0];
      if (spec == null) {
        continue;
      }
      this.slotPosition(spec, measured);
      terminal.object3D?.position.copy(this.slot);
    }
    return measured;
  }

  // ------------------------------------------------------------------ measurement

  /**
   * Fill `this.bounds` with the part's bounds in its *own* local space.
   *
   * Deriving the layout from the part rather than hard-coding offsets is what keeps the leads on
   * the ends of a resistor after someone re-models it. Returns false when the part has no
   * geometry to measure yet, which is the normal state for a moment after a glTF part spawns.
   */
  private measure(root: Object3D): boolean {
    root.updateWorldMatrix(true, true);
    this.invRoot.copy(root.matrixWorld).invert();
    this.bounds.makeEmpty();
    root.traverse(this.accumulate);
    return !this.bounds.isEmpty();
  }

  /** Write one terminal's local position into `this.slot`. */
  private slotPosition(spec: TerminalSpec, measured: boolean): void {
    if (!measured) {
      this.slot.set(spec.along * FALLBACK_HALF_LENGTH, 0, 0);
      return;
    }
    this.bounds.getCenter(this.centre);
    const x =
      spec.along < 0 ? this.bounds.min.x : spec.along > 0 ? this.bounds.max.x : this.centre.x;
    // The bead sits centred on the end face, so half of it reads as proud of the part.
    this.slot.set(x, this.centre.y, this.centre.z);
  }

  // ------------------------------------------------------------------ snapping

  /**
   * The closest terminal a connection of `opts.kind` could legally land on, or null.
   *
   * Kind matching is exact, and that is the point of the whole component: an electrical query
   * cannot return a `Field` node, a field query cannot return an electrical lead, and a `Mount` is
   * only ever returned to a caller that asked for one.
   */
  nearestTerminal(worldPoint: Vector3, opts?: NearestTerminalOptions): Entity | null {
    const within = opts?.within ?? DEFAULT_SNAP_RADIUS;
    const kind = opts?.kind ?? TerminalKind.Electrical;
    const excludeOwner = opts?.excludeOwner;
    const includeOccupied = opts?.includeOccupied ?? false;

    let best: Entity | null = null;
    let bestDistance = within * within; // compare squared, so no square roots in the loop

    for (const terminal of this.queries.terminals.entities) {
      if (!this.isCandidate(terminal, kind, includeOccupied, excludeOwner)) {
        continue;
      }
      const object = terminal.object3D;
      if (object == null) {
        continue;
      }
      object.updateWorldMatrix(true, false);
      this.probe.setFromMatrixPosition(object.matrixWorld);
      const distance = this.probe.distanceToSquared(worldPoint);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = terminal;
      }
    }
    return best;
  }

  /** Shared by snapping and highlighting, so the lit nodes are exactly the reachable ones. */
  private isCandidate(
    terminal: Entity,
    kind: string,
    includeOccupied: boolean,
    excludeOwner?: Entity,
  ): boolean {
    if (terminal.getValue(Terminal, 'kind') !== kind) {
      return false;
    }
    if (!includeOccupied && terminal.getValue(Terminal, 'occupied') === true) {
      return false;
    }
    const owner = terminal.getValue(Terminal, 'owner');
    if (owner == null) {
      // An orphan outlived its part. Never offer it; a wire to nothing is worse than no wire.
      return false;
    }
    return !(excludeOwner != null && owner === excludeOwner);
  }

  // ------------------------------------------------------------------ highlighting

  /** Light or unlight one terminal. Swaps to a shared material; allocates nothing. */
  setHighlight(terminal: Entity, on: boolean): void {
    const mesh = terminal.object3D as Mesh | undefined;
    if (mesh == null) {
      return;
    }
    const radius = NODE_RADIUS[terminal.getValue(Terminal, 'kind') ?? ''] ?? DEFAULT_RADIUS;
    mesh.material = on ? this.activeMaterial : this.idleMaterial;
    mesh.scale.setScalar(on ? radius * HIGHLIGHT_SCALE : radius);
    if (on) {
      this.highlighted.add(terminal);
    } else {
      this.highlighted.delete(terminal);
    }
  }

  /**
   * Light every terminal a connection of `kind` could legally land on. Pass null when the drag
   * ends. The same predicate decides the glow and the snap, so a lit node can always be landed on.
   */
  highlightCompatible(kind: string | null): void {
    this.clearHighlights();
    if (kind == null) {
      return;
    }
    for (const terminal of this.queries.terminals.entities) {
      if (this.isCandidate(terminal, kind, false, undefined)) {
        this.setHighlight(terminal, true);
      }
    }
  }

  /** Return every terminal to its idle appearance. */
  clearHighlights(): void {
    if (this.highlighted.size === 0) {
      return;
    }
    for (const terminal of this.highlighted) {
      const mesh = terminal.object3D as Mesh | undefined;
      if (mesh == null) {
        continue;
      }
      mesh.material = this.idleMaterial;
      mesh.scale.setScalar(
        NODE_RADIUS[terminal.getValue(Terminal, 'kind') ?? ''] ?? DEFAULT_RADIUS,
      );
    }
    this.highlighted.clear();
    this.activeMaterial.opacity = PULSE_MAX;
  }

  // ------------------------------------------------------------------ pending re-layout

  private queue(part: Entity): void {
    if (this.pending.indexOf(part) === -1) {
      this.pending.push(part);
      this.pendingAttempts.push(MAX_LAYOUT_ATTEMPTS);
    }
  }

  private unqueue(part: Entity): void {
    const i = this.pending.indexOf(part);
    if (i !== -1) {
      this.drop(i);
    }
  }

  /** Swap-with-last removal, kept in lockstep across both arrays and allocating nothing. */
  private drop(i: number): void {
    const last = this.pending.length - 1;
    this.pending[i] = this.pending[last];
    this.pendingAttempts[i] = this.pendingAttempts[last];
    this.pending.length = last;
    this.pendingAttempts.length = last;
  }

  update(delta: number, time: number): void {
    // One write per frame lights every highlighted node, because the material is shared.
    if (this.highlighted.size > 0) {
      const wave = 0.5 + 0.5 * Math.sin(time * PULSE_HZ * Math.PI * 2);
      this.activeMaterial.opacity = PULSE_MIN + (PULSE_MAX - PULSE_MIN) * wave;
    }

    // Everything below costs nothing once every part has measurable geometry.
    if (this.pending.length === 0) {
      return;
    }
    this.relayoutTimer += delta;
    if (this.relayoutTimer < RELAYOUT_INTERVAL) {
      return;
    }
    this.relayoutTimer = 0;

    // Walk backwards so a removal never disturbs the indices still to be visited.
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const part = this.pending[i];
      const resolved = this.hasTerminals(part) ? this.relayout(part) : this.adopt(part);
      this.pendingAttempts[i] -= 1;
      if (resolved || this.pendingAttempts[i] <= 0) {
        // Either the geometry arrived, or we accept the fallback layout and stop paying for it.
        this.drop(i);
      }
    }
  }

  private hasTerminals(part: Entity): boolean {
    for (const terminal of this.queries.terminals.entities) {
      if (terminal.getValue(Terminal, 'owner') === part) {
        return true;
      }
    }
    return false;
  }
}

// --------------------------------------------------------------------------- module-level API
//
// The wire system holds no reference to this system, so the calls it needs are exported as plain
// functions that delegate to the live instance. All scratch state stays inside the class, where it
// is allocated once in `init()`. Before the system starts, or after the world is torn down, every
// call here is a safe no-op rather than a crash.
//
// Writing `Terminal.occupied` is the wire system's job, not ours: we only read it. A terminal is
// marked with `terminal.setValue(Terminal, 'occupied', true)` by whoever owns the wire.

let active: TerminalSystem | null = null;

/**
 * The closest terminal a dragged connection could legally land on, or null if nothing compatible
 * is in range. Defaults: a {@link DEFAULT_SNAP_RADIUS} radius, `Electrical` kind, occupied
 * terminals excluded.
 */
export function nearestTerminal(
  worldPoint: Vector3,
  opts?: NearestTerminalOptions,
): Entity | null {
  return active?.nearestTerminal(worldPoint, opts) ?? null;
}

/** Light or unlight a single terminal. */
export function setHighlight(terminal: Entity, on: boolean): void {
  active?.setHighlight(terminal, on);
}

/** Light every terminal that accepts a connection of `kind`; pass null when the drag ends. */
export function highlightCompatible(kind: string | null): void {
  active?.highlightCompatible(kind);
}

/** Return every terminal to its idle appearance. */
export function clearHighlights(): void {
  active?.clearHighlights();
}

/** The subset of a renderable child we read when measuring a part's own bounds. */
interface GeometryBearing {
  geometry?: BufferGeometry;
}
