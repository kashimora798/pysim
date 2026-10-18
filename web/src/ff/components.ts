/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * FieldForge ECS component declarations.
 *
 * System-free by contract: the editor imports this module to build its inspector, so it must not
 * reach for World, the DOM, or any system. Systems import these declarations; never the reverse.
 */

import { createComponent, Types } from '@iwsdk/core';

/** How a wire is drawn. Reality sags; a schematic does not. */
export const WireStyle = {
  /** Hangs in a catenary between its terminals, like a real lead on a bench. */
  Flexible: 'Flexible',
  /** Orthogonal routing, snapped to the bench grid, for when the bench gets busy. */
  Straight: 'Straight',
} as const;

/** What a terminal will accept. */
export const TerminalKind = {
  /** Carries current; can be wired. */
  Electrical: 'Electrical',
  /** A field source or test point; carries no current. */
  Field: 'Field',
  /** Structural only — holds a part in place. */
  Mount: 'Mount',
} as const;

/**
 * The lab surface, anchored to the user's real desk.
 *
 * `source` records how it got there, because the distinction matters to the user: a bench on a
 * detected plane sits on their actual table, while a fallback bench floats at a guessed height.
 */
export const Bench = createComponent(
  'Bench',
  {
    width: { type: Types.Float32, default: 0.9, min: 0.3, max: 2, label: 'Width (m)' },
    depth: { type: Types.Float32, default: 0.6, min: 0.2, max: 1.5, label: 'Depth (m)' },
    /** Grid pitch for snapping parts and routing straight wires. */
    gridStep: { type: Types.Float32, default: 0.05, min: 0.01, max: 0.2 },
    /** True once a WebXR anchor holds it in place. */
    anchored: { type: Types.Boolean, default: false },
    /** 'plane' when sitting on detected geometry, 'fallback' when guessed. */
    source: { type: Types.String, default: 'fallback' },
    /** Candidacy score of the plane it chose, for debugging the picker. */
    planeScore: { type: Types.Float32, default: 0 },
  },
  'The anchored physics lab surface',
);

/**
 * A physics component instance standing on the bench.
 *
 * `kind` is a key into the exported knowledge base (`resistor`, `point_charge`, …) and
 * `instanceId` is the scene instance id the kernel will solve for (`r1`, `q1`). Keeping both means
 * the renderer can look up a part's verified properties without duplicating any physics here.
 */
export const Part = createComponent(
  'Part',
  {
    kind: { type: Types.String, default: '' },
    instanceId: { type: Types.String, default: '' },
    /** True once it has settled onto the bench grid. */
    snapped: { type: Types.Boolean, default: false },
    /** Highlight state while the guided mode is asking for this part. */
    wanted: { type: Types.Boolean, default: false },
  },
  'A physics component placed in the world',
);

/** A connection point on a part. Wires attach to these, never to the part itself. */
export const Terminal = createComponent(
  'Terminal',
  {
    /** The part this terminal belongs to. */
    owner: { type: Types.Entity, default: null },
    /** Which terminal of that part (0, 1, …), matching the component's port order. */
    index: { type: Types.Int8, default: 0 },
    label: { type: Types.String, default: '' },
    kind: { type: Types.Enum, enum: TerminalKind, default: TerminalKind.Electrical },
    /** True while a wire is attached. */
    occupied: { type: Types.Boolean, default: false },
  },
  'A connection point on a part',
);

/**
 * A wire between two terminals.
 *
 * The wire carries no physics of its own — `current` is written by the solver bridge purely to
 * drive the flow animation. Nothing here computes it.
 */
export const Wire = createComponent(
  'Wire',
  {
    from: { type: Types.Entity, default: null },
    to: { type: Types.Entity, default: null },
    style: { type: Types.Enum, enum: WireStyle, default: WireStyle.Flexible },
    /** How far a flexible wire droops at its midpoint, in metres. */
    sag: { type: Types.Float32, default: 0.05, min: 0, max: 0.3 },
    /** Solver-written, for the current-flow animation only. Amps. */
    current: { type: Types.Float32, default: 0 },
    /** True while the user is still dragging the loose end. */
    dangling: { type: Types.Boolean, default: false },
  },
  'A wire connecting two terminals',
);

/** A spatial transport button (NEXT / PLAY) for the lesson player. Pressed is added by interaction. */
export const ExperienceButton = createComponent(
  'ExperienceButton',
  {
    /** 'next' | 'play' */
    action: { type: Types.String, default: 'next' },
  },
  'A pressable transport control for the FieldForge lesson player',
);

/** A loose wire end following a pinch, before it has found its second terminal. */
export const WireDrag = createComponent(
  'WireDrag',
  {
    wire: { type: Types.Entity, default: null },
    /** Which hand is pulling it: 0 left, 1 right. */
    hand: { type: Types.Int8, default: 1 },
  },
  'A wire end currently being pulled by a hand',
);

/**
 * The surroundings — and genuinely part of the physics, not decoration.
 *
 * Every field here is bound into the kernel as a scene-level property, so changing gravity or the
 * medium changes the derived answer and the trace that explains it. Defaults describe an idealised
 * vacuum with no gravity, which is exactly what the electrostatics problems assume; making that
 * assumption an editable value rather than a footnote is the point.
 */
export const Environment = createComponent(
  'Environment',
  {
    /** m/s^2, +Y up. [0,0,0] is the idealised no-gravity case. */
    gravity: { type: Types.Vec3, default: [0, 0, 0], label: 'Gravity (m/s²)' },
    /** m/s. Only acts on a body with a drag area. */
    windVelocity: { type: Types.Vec3, default: [0, 0, 0], label: 'Wind (m/s)' },
    /** Relative permittivity of the medium. 1 is vacuum; water is ~80. */
    relativePermittivity: {
      type: Types.Float32,
      default: 1,
      min: 1,
      max: 100,
      label: 'Medium ε_r',
    },
    /** kg/m^3. 0 means no drag; air at sea level is 1.225. */
    airDensity: { type: Types.Float32, default: 0, min: 0, max: 2, label: 'Air density' },
    temperature: { type: Types.Float32, default: 293.15, min: 1, max: 1000, label: 'T (K)' },
    /** Named preset the user picked, for the panel and the trace caption. */
    preset: { type: Types.String, default: 'vacuum' },
    /** Set after any edit so the solver bridge knows to re-derive. */
    _needsUpdate: { type: Types.Boolean, default: true },
  },
  'The changeable surroundings: gravity, wind, medium',
);
