/**
 * Engine A, ported: the backward-chaining chain resolver.
 *
 * Given a scene and a target property, work backwards: find formulas that produce the target, bind
 * their inputs, and recurse on whatever is not yet known. The output is not a number but a
 * *derivation* — an ordered list of steps, each citing the formula, the law and the source that
 * justify it.
 *
 * This is a straight port of `kernel/engine_chain.py` and `kernel/scene.py::build_scene`. Its job
 * is to agree with the Python kernel, not to be prettier than it. Where a comment below says "the
 * Python side", that is the specification, and a difference is a bug in this file.
 *
 * Two things keep the search tractable:
 *
 * - **Components are the index.** `kb.solvers` maps a property to the formulas that produce it, so
 *   the resolver never scans all of physics.
 * - **Alternatives are deduplicated by law, not by shape.** Two derivations are genuinely different
 *   only when they invoke a different set of laws — the energy route versus the kinematics route,
 *   not `V/d` versus `d\V`.
 *
 * Everything numeric reuses `kernel.ts`: `evalAst` for the arithmetic, `Quantity`/`Dim` for the
 * values, `formatQuantity` for display. Only the dimension bookkeeping is added here, because the
 * exported AST carries no types — dimension checking was an authoring-time concern in Python, but
 * the resolver still has to reject a formula whose result contradicts `solvesFor`.
 */

import {
  evalAst,
  formatQuantity,
  type Ast,
  type ComponentDef,
  type Dim,
  type FormulaDef,
  type KnowledgeBase,
  type Quantity,
  type Vec3,
} from './kernel.js';

// --------------------------------------------------------------------------- constants

/** How deep a chain may go before we call it a loop we failed to detect. */
export const MAX_DEPTH = 12;

/** How many complete derivations to keep per target. */
export const MAX_PATHS = 6;

/** The component kind that carries the surroundings, and the id used when one is implied. */
export const ENVIRONMENT_KIND = 'environment';
export const IMPLICIT_ENVIRONMENT_ID = 'env';

/** Fixed by `kernel/kb.py::STATES`. */
export const STATES = ['initial', 'final'] as const;
export type State = (typeof STATES)[number];

const SAME_STATE = 'same';
const SELF = 'self';
const REL = 'rel';

/** SI base order: kg, m, s, A, K, mol, cd. */
export const BASE = ['kg', 'm', 's', 'A', 'K', 'mol', 'cd'] as const;
const N_BASE = BASE.length;
const DIMENSIONLESS: Dim = Object.freeze(Array(N_BASE).fill(0)) as Dim;

// --------------------------------------------------------------------------- quantities

export class UnitError extends Error {}

export class SceneError extends Error {}

/** A quantity known at scene-build time: the parsed shape of a `defaultQuantity` in `kb.json`. */
export interface QuantityLike {
  value: number | Vec3;
  dim: readonly number[];
  rank: 'scalar' | 'vector';
}

interface UnitEntry {
  dim: Dim;
  mult: number;
}

const dimOf = (spec: Partial<Record<(typeof BASE)[number], number>>): Dim => {
  const out = new Array<number>(N_BASE).fill(0);
  for (const [base, exp] of Object.entries(spec)) {
    const i = (BASE as readonly string[]).indexOf(base);
    if (i >= 0) out[i] = exp as number;
  }
  return out;
};

/** symbol -> (dimension, multiplier to SI base units). Mirrors `kernel/units.py::UNITS`. */
const UNITS: Record<string, UnitEntry> = {
  kg: { dim: dimOf({ kg: 1 }), mult: 1 },
  m: { dim: dimOf({ m: 1 }), mult: 1 },
  s: { dim: dimOf({ s: 1 }), mult: 1 },
  A: { dim: dimOf({ A: 1 }), mult: 1 },
  K: { dim: dimOf({ K: 1 }), mult: 1 },
  mol: { dim: dimOf({ mol: 1 }), mult: 1 },
  cd: { dim: dimOf({ cd: 1 }), mult: 1 },

  g: { dim: dimOf({ kg: 1 }), mult: 1e-3 },
  t: { dim: dimOf({ kg: 1 }), mult: 1e3 },
  u: { dim: dimOf({ kg: 1 }), mult: 1.66053906892e-27 },

  angstrom: { dim: dimOf({ m: 1 }), mult: 1e-10 },
  in: { dim: dimOf({ m: 1 }), mult: 0.0254 },
  ft: { dim: dimOf({ m: 1 }), mult: 0.3048 },

  min: { dim: dimOf({ s: 1 }), mult: 60 },
  h: { dim: dimOf({ s: 1 }), mult: 3600 },
  day: { dim: dimOf({ s: 1 }), mult: 86400 },

  N: { dim: dimOf({ kg: 1, m: 1, s: -2 }), mult: 1 },
  J: { dim: dimOf({ kg: 1, m: 2, s: -2 }), mult: 1 },
  W: { dim: dimOf({ kg: 1, m: 2, s: -3 }), mult: 1 },
  Pa: { dim: dimOf({ kg: 1, m: -1, s: -2 }), mult: 1 },
  Hz: { dim: dimOf({ s: -1 }), mult: 1 },
  L: { dim: dimOf({ m: 3 }), mult: 1e-3 },
  eV: { dim: dimOf({ kg: 1, m: 2, s: -2 }), mult: 1.602176634e-19 },

  C: { dim: dimOf({ s: 1, A: 1 }), mult: 1 },
  V: { dim: dimOf({ kg: 1, m: 2, s: -3, A: -1 }), mult: 1 },
  F: { dim: dimOf({ kg: -1, m: -2, s: 4, A: 2 }), mult: 1 },
  ohm: { dim: dimOf({ kg: 1, m: 2, s: -3, A: -2 }), mult: 1 },
  'Ω': { dim: dimOf({ kg: 1, m: 2, s: -3, A: -2 }), mult: 1 },
  S: { dim: dimOf({ kg: -1, m: -2, s: 3, A: 2 }), mult: 1 },
  T: { dim: dimOf({ kg: 1, s: -2, A: -1 }), mult: 1 },
  Wb: { dim: dimOf({ kg: 1, m: 2, s: -2, A: -1 }), mult: 1 },
  H: { dim: dimOf({ kg: 1, m: 2, s: -2, A: -2 }), mult: 1 },

  rad: { dim: DIMENSIONLESS, mult: 1 },
  sr: { dim: DIMENSIONLESS, mult: 1 },
  deg: { dim: DIMENSIONLESS, mult: Math.PI / 180 },
  '°': { dim: DIMENSIONLESS, mult: Math.PI / 180 },
  percent: { dim: DIMENSIONLESS, mult: 0.01 },
};

const PREFIXES: Record<string, number> = {
  y: 1e-24, z: 1e-21, a: 1e-18, f: 1e-15, p: 1e-12,
  n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3,
  c: 1e-2, d: 1e-1, da: 1e1, h: 1e2, k: 1e3,
  M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Z: 1e21, Y: 1e24,
};

/** Units that must never be prefixed, because doing so collides with a real unit. */
const NO_PREFIX = new Set([
  'min', 'day', 'deg', 'rad', 'sr', 'in', 'h', 't', 'percent', 'angstrom',
]);

const FACTOR_RE = /^([A-Za-zΩµμ°]+)(?:\s*\*\*\s*|\s*\^\s*)?(-?\d+(?:\/\d+)?)?$/;
const SCALAR_RE = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*?)\s*$/;
const VECTOR_RE = /^\s*[[(]\s*(.*?)\s*[\])]\s*(.*?)\s*$/;

const scaleDim = (dim: Dim, by: number): Dim => dim.map((x) => x * by);

/**
 * Resolve one unit symbol, trying an exact match before prefix decomposition.
 *
 * Exact-first is what keeps `T` tesla rather than tera, and `min` minutes rather than
 * milli-inches.
 */
function resolveSymbol(sym: string): UnitEntry {
  const exact = UNITS[sym];
  if (exact) return exact;
  // Two-character prefixes ("da") before one-character ones.
  for (const plen of [2, 1]) {
    if (sym.length <= plen) continue;
    const prefix = sym.slice(0, plen);
    const rest = sym.slice(plen);
    const factor = PREFIXES[prefix];
    const entry = UNITS[rest];
    if (factor !== undefined && entry !== undefined && !NO_PREFIX.has(rest)) {
      return { dim: entry.dim, mult: entry.mult * factor };
    }
  }
  throw new UnitError(`unknown unit symbol ${JSON.stringify(sym)}`);
}

/** Parse a unit expression such as `"m/s^2"`, `"kg*m/s**2"` or `"V/m"`. */
export function parseUnit(text: string): { dim: Dim; mult: number } {
  // Normalise `**` to `^` *before* splitting on `*`, or "s**2" would split into "s" and "2".
  const s = text.trim().replace(/·/g, '*').replace(/⋅/g, '*').replace(/\*\*/g, '^');
  if (s === '' || s === '1' || s === '-') return { dim: DIMENSIONLESS, mult: 1 };

  let dim: Dim = DIMENSIONLESS;
  let mult = 1;
  s.split('/').forEach((segment, segIndex) => {
    const sign = segIndex === 0 ? 1 : -1;
    const trimmed = segment.trim();
    if (!trimmed) throw new UnitError(`empty segment in unit ${JSON.stringify(text)}`);
    for (const factor of trimmed.split(/[*\s]+/)) {
      if (!factor) continue;
      const match = FACTOR_RE.exec(factor);
      if (!match) {
        throw new UnitError(`cannot read unit factor ${JSON.stringify(factor)} in ${JSON.stringify(text)}`);
      }
      const sym = match[1]!;
      const expText = match[2];
      let exp = expText ? evalFraction(expText) : 1;
      exp *= sign;
      const entry = resolveSymbol(sym);
      dim = dim.map((x, i) => x + entry.dim[i]! * exp);
      mult *= Math.pow(entry.mult, exp);
    }
  });
  return { dim, mult };
}

/** `"-2"` or `"1/2"` -> a number. Unknown forms are rejected rather than guessed. */
function evalFraction(text: string): number {
  if (!/^-?\d+(?:\/\d+)?$/.test(text)) {
    throw new UnitError(`cannot read exponent ${JSON.stringify(text)}`);
  }
  const [n, d] = text.split('/');
  return Number(n) / (d === undefined ? 1 : Number(d));
}

/**
 * Parse `"100 V"`, `"2 uC"`, `"[0, 0, -9.81] m/s^2"` or a bare number.
 *
 * Mirrors `kernel/units.py::parse_quantity`: everything is normalised to SI base units on the way
 * in, so the resolver only ever does arithmetic in SI.
 */
export function parseQuantity(text: string): Quantity {
  const raw = String(text).trim();

  const vec = VECTOR_RE.exec(raw);
  if (vec) {
    const body = vec[1]!.trim();
    const parts = body.split(/[,\s]+/).filter((p) => p.length > 0);
    if (parts.length !== 3) {
      throw new UnitError(`a vector needs exactly 3 components, got ${parts.length} in ${JSON.stringify(raw)}`);
    }
    const comps = parts.map((p) => {
      const n = Number(p);
      if (!Number.isFinite(n)) {
        throw new UnitError(`non-numeric vector component in ${JSON.stringify(raw)}`);
      }
      return n;
    });
    const { dim, mult } = parseUnit(vec[2]!);
    return {
      value: [comps[0]! * mult, comps[1]! * mult, comps[2]! * mult] as Vec3,
      dim,
      rank: 'vector',
    };
  }

  const scalar = SCALAR_RE.exec(raw);
  if (!scalar) throw new UnitError(`cannot read quantity ${JSON.stringify(raw)}`);
  const number = Number(scalar[1]);
  const { dim, mult } = parseUnit(scalar[2]!);
  return { value: number * mult, dim, rank: 'scalar' };
}

const isQuantityLike = (v: unknown): v is QuantityLike =>
  v !== null &&
  typeof v === 'object' &&
  'value' in v &&
  'dim' in v &&
  'rank' in v &&
  ((v as QuantityLike).rank === 'scalar' || (v as QuantityLike).rank === 'vector');

/** Accept an authored string, or a quantity the exporter already normalised. */
function parseSceneValue(raw: unknown): Quantity {
  if (typeof raw === 'string') return parseQuantity(raw);
  if (typeof raw === 'number') return { value: raw, dim: DIMENSIONLESS, rank: 'scalar' };
  if (isQuantityLike(raw)) {
    const dim = Array.from({ length: N_BASE }, (_, i) => Number(raw.dim[i] ?? 0));
    return { value: raw.value, dim, rank: raw.rank };
  }
  throw new UnitError(`cannot read quantity ${JSON.stringify(raw)}`);
}

// --------------------------------------------------------------------------- dimensions

const dimsEqual = (a: Dim, b: Dim): boolean => {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (Math.abs((a[i] ?? 0) - (b[i] ?? 0)) > 1e-9) return false;
  }
  return true;
};

const isZeroAst = (node: Ast): boolean => node.k === 'num' && node.v === 0;

const isVec3 = (v: number | Vec3): v is Vec3 => Array.isArray(v);

// --------------------------------------------------------------------------- scene

/** One property of one instance at one state — what the resolver resolves. */
export interface Ref {
  instance: string;
  prop: string;
  state?: State | null;
}

/** `p.kinematics.speed@final`, the form the kernel prints (`Ref.__str__`). */
export const formatRef = (ref: Ref): string =>
  `${ref.instance}.${ref.prop}${ref.state ? `@${ref.state}` : ''}`;

export const refKey = (ref: Ref): string => formatRef(ref);

export const sameRef = (a: Ref, b: Ref): boolean =>
  a.instance === b.instance && a.prop === b.prop && (a.state ?? null) === (b.state ?? null);

export interface Instance {
  id: string;
  kind: string;
  /** Keyed by `refKey`, so a state-agnostic value and a stated `@initial` value coexist. */
  values: Map<string, Quantity>;
  label: string;
  note: string;
}

export interface Relation {
  kind: string;
  frm: string;
  to: string;
  /** Keyed `"prop@state"` or `"prop"`; `get` reproduces `Relation.get`. */
  values: Map<string, Quantity>;
  get(prop: string, state?: State | null): Quantity | undefined;
}

export interface Scene {
  instances: Record<string, Instance>;
  relations: Relation[];
  instance(iid: string): Instance;
  /** A value the problem supplied, or a component default. See the fallback rule below. */
  given(ref: Ref): Quantity | undefined;
  relationsFrom(iid: string, kind: string): Relation[];
  relationsInto(iid: string, kind: string): Relation[];
}

/** What `buildScene` eats. The same shape the corpus YAML authors by hand. */
export interface SceneSpec {
  instances: SceneInstanceSpec[];
  relations: SceneRelationSpec[];
}

export interface SceneInstanceSpec {
  id: string;
  kind: string;
  label?: string;
  note?: string;
  /** `"prop"` or `"prop@initial"` -> a quantity string (or an already-normalised quantity). */
  set: Record<string, unknown>;
}

export interface SceneRelationSpec {
  kind: string;
  from: string;
  to: string;
  set: Record<string, unknown>;
}

export interface SceneOptions {
  /** Prefix for error messages; the corpus uses the problem's file name. */
  where?: string;
}

const valueKey = (prop: string, state: State | null): string =>
  state ? `${prop}@${state}` : prop;

function splitPropState(key: string): { prop: string; state: State | null } {
  const at = key.lastIndexOf('@');
  if (at === -1) return { prop: key, state: null };
  const prop = key.slice(0, at);
  const state = key.slice(at + 1);
  if (state !== 'initial' && state !== 'final') {
    throw new SceneError(
      `unknown state ${JSON.stringify(state)} in ${JSON.stringify(key)}; expected one of [final, initial]`,
    );
  }
  return { prop, state };
}

function makeInstance(id: string, kind: string, label: string, note: string): Instance {
  return { id, kind, values: new Map(), label, note };
}

/**
 * Build and structurally validate a scene against the knowledge base.
 *
 * Mirrors `kernel/scene.py::build_scene`, check for check, message for message:
 *
 * - Unknown instance kind -> error naming it.
 * - Setting an `observable` slot is an error UNLESS state is `initial`.
 * - Unknown property, or a property the component does not carry -> error naming what it does.
 * - Wrong dim or rank -> error naming expected versus got.
 * - Intrinsic/settable defaults are applied first, so components arrive stocked.
 * - An implicit `environment` instance with id `env` is injected when the scene declares none.
 */
export function buildScene(
  spec: SceneSpec,
  kb: KnowledgeBase,
  options: SceneOptions = {},
): Scene {
  const where = options.where ?? 'scene';
  const instances: Record<string, Instance> = {};

  for (const raw of spec?.instances ?? []) {
    const iid = String(raw.id ?? '');
    if (!iid) throw new SceneError(`${where}: an instance is missing its \`id\``);
    if (instances[iid]) throw new SceneError(`${where}: duplicate instance id ${JSON.stringify(iid)}`);

    const kind = String(raw.kind ?? '');
    const component: ComponentDef | undefined = kb.components[kind];
    if (!component) throw new SceneError(`${where}:${iid}: unknown component kind ${JSON.stringify(kind)}`);

    const inst = makeInstance(
      iid,
      kind,
      String(raw.label ?? component.label),
      String(raw.note ?? ''),
    );

    // Components arrive stocked: intrinsic defaults first, so the problem can override nothing it
    // does not mention.
    for (const [prop, slot] of Object.entries(component.slots)) {
      if (slot.defaultQuantity) {
        inst.values.set(prop, parseSceneValue(slot.defaultQuantity));
      } else if (slot.default !== null && slot.default !== undefined) {
        inst.values.set(prop, parseQuantity(slot.default));
      }
    }

    for (const [key, rawValue] of Object.entries(raw.set ?? {})) {
      const { prop, state } = splitPropState(key);
      const propDef = kb.properties[prop];
      if (!propDef) throw new SceneError(`${where}:${iid}: unknown property ${JSON.stringify(prop)}`);

      const slot = component.slots[prop];
      if (!slot) {
        const carried = Object.keys(component.slots).sort().join(', ') || '(none)';
        throw new SceneError(
          `${where}:${iid}: a ${JSON.stringify(kind)} does not carry ${JSON.stringify(prop)}. ` +
            `It carries: ${carried}`,
        );
      }
      if (slot.role === 'observable' && state !== 'initial') {
        throw new SceneError(
          `${where}:${iid}: ${JSON.stringify(prop)} is observable on a ${JSON.stringify(kind)} — ` +
            'it is produced by solving, so setting it would be asserting the answer. An initial ' +
            `condition is a legitimate given: write \`${prop}@initial\` if that is what you mean.`,
        );
      }

      const quantity = parseSceneValue(rawValue);
      if (!dimsEqual(quantity.dim, propDef.dim)) {
        throw new SceneError(
          `${where}:${iid}: ${JSON.stringify(prop)} expects ${dimText(propDef.dim)}, ` +
            `but ${JSON.stringify(rawValue)} is ${dimText(quantity.dim)}`,
        );
      }
      if (quantity.rank !== propDef.rank) {
        throw new SceneError(
          `${where}:${iid}: ${JSON.stringify(prop)} is a ${propDef.rank}, ` +
            `but ${JSON.stringify(rawValue)} is a ${quantity.rank}`,
        );
      }

      inst.values.set(valueKey(prop, state), quantity);
    }

    instances[iid] = inst;
  }

  // Every scene has surroundings, whether or not the problem mentions them. A declared
  // environment wins; otherwise the idealised defaults stand in.
  if (
    kb.components[ENVIRONMENT_KIND] &&
    !Object.values(instances).some((i) => i.kind === ENVIRONMENT_KIND)
  ) {
    const component = kb.components[ENVIRONMENT_KIND]!;
    const implicit = makeInstance(
      IMPLICIT_ENVIRONMENT_ID,
      ENVIRONMENT_KIND,
      component.label,
      'implicit: no environment was declared, so the idealised defaults apply',
    );
    for (const [prop, slot] of Object.entries(component.slots)) {
      if (slot.defaultQuantity) {
        implicit.values.set(prop, parseSceneValue(slot.defaultQuantity));
      } else if (slot.default !== null && slot.default !== undefined) {
        implicit.values.set(prop, parseQuantity(slot.default));
      }
    }
    instances[implicit.id] = implicit;
  }

  const relations: Relation[] = [];
  for (const raw of spec?.relations ?? []) {
    const kind = String(raw.kind ?? '');
    const frm = String(raw.from ?? '');
    const to = String(raw.to ?? '');
    if (!kind || !frm || !to) {
      throw new SceneError(`${where}: a relation needs \`kind\`, \`from\` and \`to\``);
    }
    for (const end of [frm, to]) {
      if (!instances[end]) {
        throw new SceneError(`${where}: relation ${JSON.stringify(kind)} references unknown instance ${JSON.stringify(end)}`);
      }
    }

    const values = new Map<string, Quantity>();
    const relation: Relation = {
      kind,
      frm,
      to,
      values,
      get(prop, state = null) {
        return values.get(valueKey(prop, state)) ?? values.get(valueKey(prop, null));
      },
    };

    for (const [key, rawValue] of Object.entries(raw.set ?? {})) {
      const { prop, state } = splitPropState(key);
      const propDef = kb.properties[prop];
      if (!propDef) {
        throw new SceneError(
          `${where}: relation ${JSON.stringify(kind)} sets unknown property ${JSON.stringify(prop)}`,
        );
      }
      const quantity = parseSceneValue(rawValue);
      // Relations check dimension only, exactly as the Python side does; rank is the instance's
      // contract.
      if (!dimsEqual(quantity.dim, propDef.dim)) {
        throw new SceneError(
          `${where}: relation ${JSON.stringify(kind)} property ${JSON.stringify(prop)} expects ` +
            `${dimText(propDef.dim)}, got ${dimText(quantity.dim)}`,
        );
      }
      values.set(valueKey(prop, state), quantity);
    }

    relations.push(relation);
  }

  const scene: Scene = {
    instances,
    relations,
    instance(iid) {
      const inst = instances[iid];
      if (!inst) throw new SceneError(`no instance ${JSON.stringify(iid)} in scene`);
      return inst;
    },
    given(ref) {
      const inst = instances[ref.instance];
      if (!inst) return undefined;
      const exact = inst.values.get(valueKey(ref.prop, ref.state ?? null));
      if (exact !== undefined) return exact;
      // A value stated without an instant describes the *starting* (or steady) condition, so a
      // lookup for `initial` may fall back to it. A lookup for `final` may NOT: the final value is
      // what solving is for, and letting it default would answer "how fast is it going when it
      // arrives?" with the speed it started at.
      if (ref.state === 'final') return undefined;
      if (ref.state) return inst.values.get(valueKey(ref.prop, null));
      return undefined;
    },
    relationsFrom(iid, kind) {
      return relations.filter((r) => r.frm === iid && r.kind === kind);
    },
    relationsInto(iid, kind) {
      return relations.filter((r) => r.to === iid && r.kind === kind);
    },
  };
  return scene;
}

// --------------------------------------------------------------------------- derivation types

/** One resolved input to a step: the symbol, where it came from, and its value. */
export interface Input {
  symbol: string;
  /** `null` for a constant or a relation property. */
  ref: Ref | null;
  const: string | null;
  quantity: Quantity;
}

/** One justified move: either a given, or a formula application. */
export interface Step {
  ref: Ref;
  quantity: Quantity;
  formula: FormulaDef | null;
  inputs: Input[];
  /** Which instance each of the formula's roles bound to, for the trace and the storyboard. */
  roles: Array<[string, string]>;
}

export const isGiven = (step: Step): boolean => step.formula === null;
export const stepLaw = (step: Step): string | null => step.formula?.law ?? null;
export const stepCite = (step: Step): string =>
  step.formula ? step.formula.cite || step.formula.key : 'stated in the problem';

/** A complete, ordered justification for one target value. */
export interface Derivation {
  target: Ref;
  steps: Step[];
}

export const derivationValue = (d: Derivation): Quantity => d.steps[d.steps.length - 1]!.quantity;

/** Formula applications only; a given costs nothing. */
export const derivationCost = (d: Derivation): number =>
  d.steps.reduce((n, s) => n + (s.formula ? 1 : 0), 0);

export const derivationLaws = (d: Derivation): Set<string> => {
  const laws = new Set<string>();
  for (const s of d.steps) if (s.formula?.law) laws.add(s.formula.law);
  return laws;
};

export const derivationFormulas = (d: Derivation): string[] =>
  d.steps.filter((s) => s.formula).map((s) => s.formula!.key);

export const derivationAssumptions = (d: Derivation): string[] => {
  const seen = new Set<string>();
  for (const s of d.steps) for (const a of s.formula?.assumes ?? []) seen.add(a);
  return [...seen];
};

export const derivationCitations = (d: Derivation): string[] => {
  const seen = new Set<string>();
  for (const s of d.steps) if (s.formula?.cite) seen.add(s.formula.cite);
  return [...seen];
};

/**
 * What makes two derivations the *same* path: the set of laws they invoke.
 *
 * Keying on formulas as well would let algebraic rearrangements masquerade as alternatives —
 * taking a magnitude before dividing by mass rather than after is the same physics twice. Two
 * derivations are genuinely different only when they appeal to different laws.
 */
export const signature = (d: Derivation): string =>
  [...derivationLaws(d)].sort().join('\u0000');

/** Why a target could not be reached — the audit's most useful output. */
export class Failure {
  readonly ref: Ref;
  readonly reasons: string[];

  constructor(ref: Ref, reasons: string[]) {
    this.ref = ref;
    this.reasons = reasons;
  }

  get message(): string {
    const head = `cannot resolve ${formatRef(this.ref)}`;
    if (this.reasons.length === 0) {
      return `${head}: no formula in the knowledge base produces it`;
    }
    return `${head}:\n  - ${[...new Set(this.reasons)].join('\n  - ')}`;
  }

  toString(): string {
    return this.message;
  }
}

// --------------------------------------------------------------------------- typed evaluation

interface TypedValue {
  value: number | Vec3;
  dim: Dim;
  rank: 'scalar' | 'vector';
}

const VECTOR = 'vector' as const;
const SCALAR = 'scalar' as const;

const mulDim = (a: Dim, b: Dim): Dim => a.map((x, i) => x + (b[i] ?? 0));

/**
 * Evaluate an AST and carry its dimension and rank alongside the value.
 *
 * The arithmetic is `evalAst`'s, unchanged — this wrapper only re-walks the tree to infer the
 * types the exported AST does not carry. If the two ever disagree the expression was not
 * dimensionally homogeneous, which is exactly what `_assemble` must reject.
 */
function evalTyped(node: Ast, env: Record<string, Quantity>): TypedValue {
  const child = (a: Ast) => evalTyped(a, env);

  switch (node.k) {
    case 'num':
      return { value: node.v, dim: DIMENSIONLESS, rank: SCALAR };

    case 'sym': {
      const q = env[node.n];
      if (!q) throw new Error(`unbound symbol "${node.n}"`);
      return { value: evalAst(node, env) as number | Vec3, dim: q.dim, rank: q.rank };
    }

    case 'add': {
      const types = node.a.map(child);
      const first = types[0]!;
      for (const t of types.slice(1)) {
        if (!dimsEqual(t.dim, first.dim)) {
          throw new Error(
            `cannot add ${dimText(first.dim)} to ${dimText(t.dim)} — every term of a sum must ` +
              'share one dimension',
          );
        }
        if (t.rank !== first.rank) {
          throw new Error(`cannot add a ${first.rank} to a ${t.rank}`);
        }
      }
      return { value: evalAst(node, env) as number | Vec3, dim: first.dim, rank: first.rank };
    }

    case 'mul': {
      let dim: Dim = DIMENSIONLESS;
      let rank: 'scalar' | 'vector' = SCALAR;
      for (const a of node.a) {
        const t = child(a);
        dim = mulDim(dim, t.dim);
        if (t.rank === VECTOR) {
          if (rank === VECTOR) {
            throw new Error('multiplies two vectors directly; say dot(a, b) or cross(a, b)');
          }
          rank = VECTOR;
        }
      }
      return { value: evalAst(node, env) as number | Vec3, dim, rank };
    }

    case 'pow': {
      const base = child(node.b);
      if (base.rank === VECTOR) {
        throw new Error('cannot raise a vector to a power; use mag() first');
      }
      const value = evalAst(node, env) as number;
      return { value, dim: scaleDim(base.dim, node.e), rank: SCALAR };
    }

    case 'fn': {
      const args = node.a.map(child);
      const value = evalAst(node, env);
      switch (node.f) {
        case 'mag':
          return { value, dim: args[0]!.dim, rank: SCALAR };
        case 'unit':
          return { value, dim: DIMENSIONLESS, rank: VECTOR };
        case 'dot':
          return { value, dim: mulDim(args[0]!.dim, args[1]!.dim), rank: SCALAR };
        case 'cross':
          return { value, dim: mulDim(args[0]!.dim, args[1]!.dim), rank: VECTOR };
        case 'abs':
          return { value, dim: args[0]!.dim, rank: SCALAR };
        case 'sqrt':
          return { value, dim: scaleDim(args[0]!.dim, 0.5), rank: SCALAR };
        case 'sign':
        case 'atan2':
        case 'sin':
        case 'cos':
        case 'tan':
        case 'asin':
        case 'acos':
        case 'atan':
        case 'sinh':
        case 'cosh':
        case 'tanh':
        case 'exp':
        case 'log':
          return { value, dim: DIMENSIONLESS, rank: SCALAR };
        default:
          throw new Error(`unknown function "${node.f}"`);
      }
    }
  }
}

// --------------------------------------------------------------------------- display helpers

const SUPERSCRIPT: Record<string, string> = {
  '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
  '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹',
};

/** `kernel/dims.py::Dim.__str__` — "1", "N", "kg·m²·s⁻³·A⁻²". */
export function dimText(dim: Dim): string {
  const parts: string[] = [];
  BASE.forEach((base, i) => {
    const exp = dim[i] ?? 0;
    if (Math.abs(exp) < 1e-9) return;
    if (Math.abs(exp - 1) < 1e-9) parts.push(base);
    else {
      const shown = Number.isInteger(exp) ? String(exp) : String(exp);
      parts.push(base + [...shown].map((c) => SUPERSCRIPT[c] ?? c).join(''));
    }
  });
  return parts.length === 0 ? '1' : parts.join('·');
}

const substituteText = (exprText: string, env: Record<string, Quantity>): string =>
  exprText.replace(/[A-Za-z_]\w*/g, (name) => {
    const q = env[name];
    return q ? `(${formatQuantity(q, '')})` : name;
  });

// --------------------------------------------------------------------------- the resolver

/** The role shape the exporter writes: `via` is `null` for a scene-scoped role. */
interface RoleDef {
  via: string | null;
  kinds: string[];
}

interface BindingDef {
  prop: string | null;
  const: string | null;
  from: string;
  state: string | null;
}

type RoleBinding = { instance: string; relation: Relation | null };
type BindingMap = Record<string, RoleBinding>;

const compareKeys = (a: string[], b: string[]): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return a.length - b.length;
};

/** `sorted(results, key=(cost, formulas))`, stable, exactly as the Python side orders them. */
const byCostThenFormulas = (a: Derivation, b: Derivation): number =>
  derivationCost(a) - derivationCost(b) ||
  compareKeys(derivationFormulas(a), derivationFormulas(b));

/** Deduplicate by law set, keep the cheapest of each, cap at `maxPaths`. */
const dedupe = (found: Derivation[], maxPaths: number): Derivation[] => {
  const unique = new Map<string, Derivation>();
  for (const d of [...found].sort(byCostThenFormulas)) {
    const key = signature(d);
    if (!unique.has(key)) unique.set(key, d);
  }
  return [...unique.values()].slice(0, maxPaths);
};

export interface ResolverOptions {
  maxPaths?: number;
}

/**
 * Backward-chaining resolution over one scene.
 *
 * ```ts
 * const scene = buildScene(spec, kb);
 * const resolver = new Resolver(kb, scene);
 * const paths = resolver.resolve({ instance: 'p', prop: 'kinematics.speed', state: 'final' });
 * ```
 */
export class Resolver {
  readonly kb: KnowledgeBase;
  readonly scene: Scene;
  readonly maxPaths: number;

  private readonly memo = new Map<string, Derivation[]>();
  private readonly notes = new Map<string, string[]>();
  private readonly formulas: Record<string, FormulaDef & { roles: Record<string, RoleDef>; bindings: Record<string, BindingDef> }>;

  constructor(kb: KnowledgeBase, scene: Scene, options: ResolverOptions = {}) {
    this.kb = kb;
    this.scene = scene;
    this.maxPaths = options.maxPaths ?? MAX_PATHS;
    // The exported `FormulaDef` types `roles` as `{via: string}`, but a scene-scoped role serialises
    // `via: null`. Widen once here rather than casting at every use.
    this.formulas = kb.formulas as unknown as Resolver['formulas'];
  }

  // ------------------------------------------------------------------ public

  /** Every genuinely distinct derivation of `target`, cheapest first. */
  resolve(target: Ref): Derivation[] {
    const found = this.resolveRef(target, new Set(), 0);
    return dedupe(found, this.maxPaths);
  }

  /** Why `target` could not be reached: the notes collected while trying. */
  failure(target: Ref): Failure {
    return new Failure(target, [...(this.notes.get(refKey(target)) ?? [])]);
  }

  // ------------------------------------------------------------------ internals

  private note(ref: Ref, reason: string): void {
    const key = refKey(ref);
    const list = this.notes.get(key);
    if (list) list.push(reason);
    else this.notes.set(key, [reason]);
  }

  private solversFor(prop: string): FormulaDef[] {
    return (this.kb.solvers[prop] ?? [])
      .map((key) => this.kb.formulas[key])
      .filter((f): f is FormulaDef => f !== undefined);
  }

  private resolveRef(ref: Ref, visited: Set<string>, depth: number): Derivation[] {
    const key = refKey(ref);

    // Successes only are memoised (see the write-back at the bottom). A cached hit is a known
    // answer for this exact ref, independent of the path that asked.
    const hit = this.memo.get(key);
    if (hit) return hit;

    if (visited.has(key)) return []; // cycle: this branch cannot close
    if (depth > MAX_DEPTH) {
      this.note(ref, `gave up past depth ${MAX_DEPTH}`);
      return [];
    }

    const results: Derivation[] = [];

    const given = this.scene.given(ref);
    if (given !== undefined) {
      results.push({
        target: ref,
        steps: [{ ref, quantity: given, formula: null, inputs: [], roles: [] }],
      });
    }

    const candidates = this.solversFor(ref.prop);
    if (candidates.length === 0 && given === undefined) {
      this.note(ref, `no formula in the knowledge base solves for ${ref.prop}`);
    }

    const nextVisited = new Set(visited);
    nextVisited.add(key);

    for (const formula of candidates) {
      if (!this.stateMatches(formula, ref)) continue;
      results.push(...this.applyFormula(formula, ref, nextVisited, depth));
    }

    const out = dedupe(results, this.maxPaths);

    // Cache successes only. A failure here may be an artefact of `visited` rather than a real dead
    // end: once two properties are mutually derivable — a field vector from its magnitude and the
    // magnitude back from the vector — a branch that happens to recurse through the pair gets cut
    // by cycle detection and returns nothing. Caching that would poison the memo, and a later
    // branch that could legitimately resolve it would read the empty result and fail. Recomputing
    // a miss costs a little; remembering a false one is a wrong answer.
    if (out.length > 0) this.memo.set(key, out);
    return out;
  }

  /** A formula that declares `producesState` only answers for that state. */
  private stateMatches(formula: FormulaDef, ref: Ref): boolean {
    if (formula.producesState === null || formula.producesState === undefined) return true;
    return (ref.state ?? null) === formula.producesState;
  }

  /** Try one formula: bind its roles, resolve its inputs, build derivations. */
  private applyFormula(
    formula: FormulaDef,
    ref: Ref,
    visited: Set<string>,
    depth: number,
  ): Derivation[] {
    // A row that names the components it is a law of is not a row for anything else. The
    // kernel enforces this for Engine B; the browser port enforces it here, or the two would
    // answer the same scene differently.
    const appliesTo = formula.appliesTo ?? [];
    if (appliesTo.length > 0) {
      const owner = this.scene.instances[ref.instance];
      if (!owner || !appliesTo.includes(owner.kind)) return [];
    }
    const out: Derivation[] = [];
    for (const bindingMap of this.roleBindings(formula, ref)) {
      const resolved = this.resolveInputs(formula, ref, bindingMap, visited, depth);
      if (resolved === null) continue;
      for (const combination of resolved) {
        const derivation = this.assemble(formula, ref, bindingMap, combination);
        if (derivation !== null) out.push(derivation);
      }
    }
    return out;
  }

  /**
   * Every way this formula's roles can be bound to instances in the scene.
   *
   * Returns one map per combination, mapping role name to `{instance, relation}`. Two roles yield
   * the cartesian product, which is what lets a series pair find both of its members; a
   * `self`-scope formula yields a single empty binding.
   */
  private roleBindings(formula: FormulaDef, ref: Ref): BindingMap[] {
    const typed = this.formulas[formulaKey(this.kb, formula)];
    const roles = typed?.roles ?? {};

    if (formula.scope === 'self') return [{}];

    const perRole: Array<Array<[string, RoleBinding]>> = [];

    for (const [name, role] of Object.entries(roles)) {
      const options: Array<[string, RoleBinding]> = [];
      const kinds = role.kinds ?? [];

      if (role.via === null || role.via === undefined) {
        // `scene: true` — any instance whose kind is in `kinds`.
        for (const [iid, inst] of Object.entries(this.scene.instances)) {
          if (kinds.length === 0 || kinds.includes(inst.kind)) options.push([name, { instance: iid, relation: null }]);
        }
        if (options.length === 0) {
          this.note(
            ref,
            `${formulaKey(this.kb, formula)}: the scene has no ${kinds.join(' or ') || 'instance'} ` +
              `for role ${JSON.stringify(name)}`,
          );
          return [];
        }
      } else {
        // Search both directions: a relation reads the same physics whichever way it was written.
        for (const relation of this.scene.relationsFrom(ref.instance, role.via)) {
          if (this.kindOk(relation.to, kinds)) options.push([name, { instance: relation.to, relation }]);
        }
        for (const relation of this.scene.relationsInto(ref.instance, role.via)) {
          if (this.kindOk(relation.frm, kinds)) options.push([name, { instance: relation.frm, relation }]);
        }
        if (options.length === 0) {
          this.note(
            ref,
            `${formulaKey(this.kb, formula)}: needs a ${JSON.stringify(role.via)} relation to a ` +
              `${kinds.join(' or ') || 'component'}`,
          );
          return [];
        }
      }

      perRole.push(options);
    }

    // Cartesian product over roles.
    let combos: BindingMap[] = [{}];
    for (const options of perRole) {
      const next: BindingMap[] = [];
      for (const base of combos) {
        for (const [name, binding] of options) next.push({ ...base, [name]: binding });
      }
      combos = next;
    }

    // Two roles must not bind the same instance: a resistor is not in series with itself.
    return combos.filter((c) => {
      const ids = Object.values(c).map((b) => b.instance);
      return new Set(ids).size === ids.length;
    });
  }

  private kindOk(iid: string, kinds: string[]): boolean {
    if (kinds.length === 0) return true;
    return this.scene.instance(iid).kind !== undefined && kinds.includes(this.scene.instance(iid).kind);
  }

  /**
   * Resolve every binding. Returns one list of Inputs per combination of sub-derivations, or
   * `null` if any binding is unreachable.
   */
  private resolveInputs(
    formula: FormulaDef,
    ref: Ref,
    bindingMap: BindingMap,
    visited: Set<string>,
    depth: number,
  ): Input[][] | null {
    const typed = this.formulas[formulaKey(this.kb, formula)];
    const perBinding: Input[][] = [];

    for (const binding of Object.values(typed?.bindings ?? {})) {
      const options = this.resolveBinding(formula, binding, ref, bindingMap, visited, depth);
      if (options.length === 0) return null;
      perBinding.push(options);
    }

    if (perBinding.length === 0) return [[]]; // a formula with no inputs, e.g. the shielded cavity

    let product: Input[][] = [[]];
    for (const options of perBinding) {
      const next: Input[][] = [];
      for (const base of product) for (const option of options) next.push([...base, option]);
      product = next;
    }
    return product;
  }

  private resolveBinding(
    formula: FormulaDef,
    binding: BindingDef,
    ref: Ref,
    bindingMap: BindingMap,
    visited: Set<string>,
    depth: number,
  ): Input[] {
    const key = formulaKey(this.kb, formula);

    if (binding.const !== null && binding.const !== undefined) {
      const constant = this.kb.constants[binding.const];
      if (!constant) {
        this.note(ref, `${key}: unknown constant ${JSON.stringify(binding.const)}`);
        return [];
      }
      return [
        {
          symbol: symbolOf(formula, binding),
          ref: null,
          const: binding.const,
          quantity: { value: constant.value, dim: constant.dim, rank: constant.rank },
        },
      ];
    }

    const relationRole = relationRoleOf(binding.from);
    if (relationRole !== null) {
      // `rel` is the single-role shorthand; `rel.<name>` names one explicitly.
      const name = relationRole === REL ? Object.keys(bindingMap)[0] : relationRole;
      const entry = name === undefined ? undefined : bindingMap[name];
      if (!entry || !entry.relation) return [];
      const value = entry.relation.get(
        binding.prop!,
        binding.state === SAME_STATE ? null : (binding.state as State | null),
      );
      if (value === undefined) {
        this.note(
          ref,
          `${key}: the ${JSON.stringify(entry.relation.kind)} relation does not state ` +
            `${JSON.stringify(binding.prop)}`,
        );
        return [];
      }
      return [{ symbol: symbolOf(formula, binding), ref: null, const: null, quantity: value }];
    }

    let owner: string;
    if (binding.from === SELF) {
      owner = ref.instance;
    } else {
      const entry = bindingMap[binding.from];
      if (!entry) return [];
      owner = entry.instance;
    }

    // `state: same` follows the target's instant, so asking for the speed at the end resolves the
    // velocity at the end rather than the state-agnostic default.
    const state: State | null =
      binding.state === SAME_STATE ? (ref.state ?? null) : (binding.state as State | null);
    const subRef: Ref = { instance: owner, prop: binding.prop!, state };
    const derivations = this.resolveRef(subRef, visited, depth + 1);
    if (derivations.length === 0) {
      this.note(ref, `${key}: could not resolve ${formatRef(subRef)}`);
      return [];
    }

    return derivations.map((d) => ({
      symbol: symbolOf(formula, binding),
      ref: subRef,
      const: null,
      quantity: derivationValue(d),
    }));
  }

  /** Evaluate the formula and splice sub-derivations into one ordered trace. */
  private assemble(
    formula: FormulaDef,
    ref: Ref,
    bindingMap: BindingMap,
    inputs: Input[],
  ): Derivation | null {
    const key = formulaKey(this.kb, formula);
    const env: Record<string, Quantity> = {};
    for (const input of inputs) env[input.symbol] = input.quantity;

    let evaluated: TypedValue;
    try {
      evaluated = evalTyped(formula.ast, env);
    } catch (err) {
      const message = (err as Error).message;
      this.note(
        ref,
        /division by zero/i.test(message)
          ? `${key}: division by zero with the given values`
          : `${key}: ${message}`,
      );
      return null;
    }

    const declared = this.kb.properties[formula.solvesFor];
    if (!declared) {
      this.note(ref, `${key}: unknown property ${JSON.stringify(formula.solvesFor)}`);
      return null;
    }

    let quantity: Quantity;
    if (!isZeroAst(formula.ast)) {
      if (!dimsEqual(evaluated.dim, declared.dim) || evaluated.rank !== declared.rank) {
        this.note(
          ref,
          `${key}: produced ${dimText(evaluated.dim)} (${evaluated.rank}) but ` +
            `${formula.solvesFor} is ${dimText(declared.dim)} (${declared.rank})`,
        );
        return null;
      }
      quantity = { value: evaluated.value, dim: evaluated.dim, rank: evaluated.rank };
    } else {
      // A literal zero is dimensionally polymorphic: give it the declared property's dim and rank.
      quantity = { value: evaluated.value, dim: declared.dim, rank: declared.rank };
    }

    const steps: Step[] = [];
    const seen = new Set<string>();
    for (const input of inputs) {
      if (input.ref === null) continue;
      for (const sub of (this.memo.get(refKey(input.ref)) ?? []).slice(0, 1)) {
        for (const step of sub.steps) {
          const stepKey = refKey(step.ref);
          if (!seen.has(stepKey)) {
            seen.add(stepKey);
            steps.push(step);
          }
        }
      }
    }

    steps.push({
      ref,
      quantity,
      formula,
      inputs,
      roles: Object.entries(bindingMap)
        .map(([name, b]) => [name, b.instance] as [string, string])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    });

    return { target: ref, steps };
  }
}

// --------------------------------------------------------------------------- formula helpers

/**
 * The bundle keys formulas by name, but `FormulaDef` carries no `key`. Recover it from the table
 * identity so notes and dedup order can name the formula the way the Python kernel does.
 */
const KEY_BY_FORMULA = new WeakMap<FormulaDef, string>();

function formulaKey(kb: KnowledgeBase, formula: FormulaDef): string {
  const cached = KEY_BY_FORMULA.get(formula);
  if (cached !== undefined) return cached;
  for (const [key, value] of Object.entries(kb.formulas)) {
    if (value === formula) {
      KEY_BY_FORMULA.set(formula, key);
      return key;
    }
  }
  // Not in this table: fall back to the solved-for property so a message still says something.
  return formula.solvesFor;
}

/** The binding keeps its symbol in Python; the export folds it into the map key. */
const SYMBOL_BY_BINDING = new WeakMap<BindingDef, string>();

function symbolOf(formula: FormulaDef, binding: BindingDef): string {
  const cached = SYMBOL_BY_BINDING.get(binding);
  if (cached !== undefined) return cached;
  for (const [symbol, value] of Object.entries(formula.bindings ?? {})) {
    if (value === binding) {
      SYMBOL_BY_BINDING.set(binding, symbol);
      return symbol;
    }
  }
  return '';
}

/** `rel` or `rel.<role>`; anything else is not a relation source. */
function relationRoleOf(from: string): string | null {
  if (from === REL) return REL;
  if (from.startsWith(`${REL}.`)) return from.slice(REL.length + 1);
  return null;
}

// --------------------------------------------------------------------------- presentation

/** `Input.describe()` — `"Q = 2 C  (charged_particle)"`. */
export function describeInput(input: Input): string {
  const origin = input.const ?? (input.ref ? formatRef(input.ref) : '');
  return `${input.symbol} = ${formatQuantity(input.quantity, '')}  (${origin})`;
}

/** `Step.substituted()` — the expression with every input replaced by its value. */
export function substitutedText(step: Step): string {
  if (!step.formula) return formatQuantity(step.quantity, '');
  const env: Record<string, Quantity> = {};
  for (const input of step.inputs) env[input.symbol] = input.quantity;
  return substituteText(step.formula.exprText, env);
}
