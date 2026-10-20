/**
 * The runtime half of the physics kernel.
 *
 * The Python kernel validates the knowledge base, proves every formula dimensionally homogeneous,
 * and serialises each expression to a small JSON AST at build time. Nothing here re-derives or
 * re-checks physics: by the time a formula reaches this file it has already been proved. All this
 * code does is arithmetic, which is why the browser needs ~200 lines instead of a CAS.
 *
 * The one hard rule: this file must agree with the Python evaluator on every value, to the last
 * float. `npm run verify:kernel` replays every precompiled trace (24 specs) through this evaluator and
 * fails if any beat disagrees. Treat a disagreement as a kernel bug, never as a rounding quirk.
 */

// --------------------------------------------------------------------------- quantities

/** SI base order: kg, m, s, A, K, mol, cd. Fixed by the Python side; do not reorder. */
export type Dim = readonly number[];

export type Vec3 = [number, number, number];

/** A value in SI base units, with its dimension and tensor rank. */
export interface Quantity {
  value: number | Vec3;
  dim: Dim;
  rank: 'scalar' | 'vector';
}

export const isVector = (q: Quantity): q is Quantity & { value: Vec3 } =>
  q.rank === 'vector';

export const magnitude = (q: Quantity): number =>
  isVector(q) ? Math.hypot(q.value[0], q.value[1], q.value[2]) : Math.abs(q.value as number);

export const sameDim = (a: Dim, b: Dim): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

// --------------------------------------------------------------------------- the AST

export type Ast =
  | { k: 'num'; v: number }
  | { k: 'sym'; n: string }
  | { k: 'add'; a: Ast[] }
  | { k: 'mul'; a: Ast[] }
  | { k: 'pow'; b: Ast; e: number }
  | { k: 'fn'; f: string; a: Ast[] };

type Val = number | Vec3;

const isVec = (v: Val): v is Vec3 => Array.isArray(v);

export class EvalError extends Error {}

/**
 * Evaluate a verified expression tree.
 *
 * Vector semantics mirror the Python side exactly: `add` is componentwise, `mul` permits at most
 * one vector factor (the validators already rejected anything else), and `pow` is scalar-only.
 */
export function evalAst(node: Ast, env: Record<string, Val>): Val {
  switch (node.k) {
    case 'num':
      return node.v;

    case 'sym': {
      const v = env[node.n];
      if (v === undefined) throw new EvalError(`unbound symbol "${node.n}"`);
      return v;
    }

    case 'add': {
      let acc: Val | null = null;
      for (const child of node.a) {
        const v = evalAst(child, env);
        if (acc === null) {
          acc = isVec(v) ? ([v[0], v[1], v[2]] as Vec3) : v;
        } else if (isVec(acc) && isVec(v)) {
          acc = [acc[0] + v[0], acc[1] + v[1], acc[2] + v[2]];
        } else if (!isVec(acc) && !isVec(v)) {
          acc = acc + v;
        } else {
          throw new EvalError('cannot add a scalar to a vector');
        }
      }
      return acc ?? 0;
    }

    case 'mul': {
      let scale = 1;
      let vec: Vec3 | null = null;
      for (const child of node.a) {
        const v = evalAst(child, env);
        if (isVec(v)) {
          if (vec !== null) throw new EvalError('cannot multiply two vectors; use dot or cross');
          vec = v;
        } else {
          scale *= v;
        }
      }
      return vec === null ? scale : [vec[0] * scale, vec[1] * scale, vec[2] * scale];
    }

    case 'pow': {
      const base = evalAst(node.b, env);
      if (isVec(base)) throw new EvalError('cannot raise a vector to a power; use mag() first');
      if (base === 0 && node.e < 0) throw new EvalError('division by zero');
      return Math.pow(base, node.e);
    }

    case 'fn':
      return evalFn(node, env);
  }
}

function evalFn(node: Extract<Ast, { k: 'fn' }>, env: Record<string, Val>): Val {
  const args = node.a.map((a) => evalAst(a, env));
  const needVec = (i: number): Vec3 => {
    const v = args[i];
    if (!isVec(v)) throw new EvalError(`${node.f}() argument ${i + 1} must be a vector`);
    return v;
  };
  const needNum = (i: number): number => {
    const v = args[i];
    if (isVec(v)) throw new EvalError(`${node.f}() argument ${i + 1} must be a scalar`);
    return v;
  };

  switch (node.f) {
    case 'mag': {
      const v = needVec(0);
      return Math.hypot(v[0], v[1], v[2]);
    }
    case 'unit': {
      const v = needVec(0);
      const n = Math.hypot(v[0], v[1], v[2]);
      if (n === 0) throw new EvalError('unit() of a zero vector');
      return [v[0] / n, v[1] / n, v[2] / n];
    }
    case 'dot': {
      const a = needVec(0);
      const b = needVec(1);
      return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    }
    case 'cross': {
      const a = needVec(0);
      const b = needVec(1);
      return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
    }
    case 'sqrt':
      return Math.sqrt(needNum(0));
    case 'abs':
      return Math.abs(needNum(0));
    case 'sign': {
      const x = needNum(0);
      return x === 0 ? 0 : Math.sign(x);
    }
    case 'atan2':
      return Math.atan2(needNum(0), needNum(1));
    case 'sin':
      return Math.sin(needNum(0));
    case 'cos':
      return Math.cos(needNum(0));
    case 'tan':
      return Math.tan(needNum(0));
    case 'asin':
      return Math.asin(needNum(0));
    case 'acos':
      return Math.acos(needNum(0));
    case 'atan':
      return Math.atan(needNum(0));
    case 'sinh':
      return Math.sinh(needNum(0));
    case 'cosh':
      return Math.cosh(needNum(0));
    case 'tanh':
      return Math.tanh(needNum(0));
    case 'exp':
      return Math.exp(needNum(0));
    case 'log':
      return Math.log(needNum(0));
    default:
      throw new EvalError(`unknown function "${node.f}"`);
  }
}

// --------------------------------------------------------------------------- bundle shapes

export interface PropertyDef {
  symbol: string;
  dim: Dim;
  dimKey: string;
  dimText: string;
  rank: 'scalar' | 'vector';
  kind: 'lumped' | 'field' | 'pair';
  siUnit: string;
  unit: string;
  domain: string;
  description: string;
}

export interface BindingDef {
  prop: string | null;
  const: string | null;
  from: string;
  state: string | null;
}

export interface FormulaDef {
  solvesFor: string;
  producesState: string | null;
  scope: 'self' | 'pair' | 'scene';
  roles: Record<string, { via: string; kinds: string[] }>;
  exprText: string;
  ast: Ast;
  bindings: Record<string, BindingDef>;
  law: string | null;
  assumes: string[];
  cite: string;
  cost: number;
  note: string;
}

export interface ComponentDef {
  label: string;
  tags: string[];
  laws: string[];
  model3d: string | null;
  description: string;
  slots: Record<
    string,
    {
      role: 'intrinsic' | 'settable' | 'observable';
      required: boolean;
      default: string | null;
      defaultQuantity: (Quantity & { unit: string; display: string }) | null;
      note: string;
    }
  >;
}

export interface LawDef {
  label: string;
  statement: string;
  governs: string[];
  cite: string;
}

export interface KnowledgeBase {
  schema: string;
  contentHash: string;
  audit: {
    errors: number;
    warnings: number;
    backlog: string[];
    counts: Record<string, number>;
    coverage: { total: number; resolved: number; agreeing: number; multipath: number };
  };
  base: string[];
  properties: Record<string, PropertyDef>;
  constants: Record<string, Quantity & { symbol: string; unit: string; display: string }>;
  components: Record<string, ComponentDef>;
  formulas: Record<string, FormulaDef>;
  laws: Record<string, LawDef>;
  solvers: Record<string, string[]>;
  displayUnits: Record<string, string>;
}

/** One beat of a precompiled trace — simultaneously a proof step and an animation cue. */
export interface Beat {
  beat: number;
  kind: 'place' | 'relate' | 'given' | 'resolve' | 'answer';
  instance?: string;
  component?: string;
  model3d?: string | null;
  relation?: string;
  from?: string;
  to?: string;
  ref?: string;
  property?: string;
  channel?: string | null;
  value?: number | Vec3;
  unit?: string;
  dimension?: Record<string, string>;
  rank?: 'scalar' | 'vector';
  display?: string;
  narrate: string;
  because: {
    kind: 'given' | 'derived' | 'scene' | 'summary';
    detail?: string;
    formula?: string;
    expression?: string;
    substituted?: string;
    law?: string | null;
    law_label?: string | null;
    law_statement?: string | null;
    assumes?: string[];
    cite?: string;
    inputs?: Array<{ symbol: string; from: string; value: number | Vec3; display: string }>;
    laws?: string[];
    paths_found?: number;
  };
}

export interface SimSpec {
  fieldforge: string;
  problem: { id: string; title: string; text: string; source: string; tags: string[] };
  target: string;
  answer: { value: number | Vec3; unit: string; rank: string; display: string };
  scene: {
    instances: Array<{
      id: string;
      kind: string;
      label: string;
      model3d: string | null;
      tags: string[];
      given: Record<string, { value: number | Vec3; unit: string; display: string }>;
    }>;
    relations: Array<{ kind: string; from: string; to: string; given: Record<string, unknown> }>;
  };
  assumptions: string[];
  citations: string[];
  /** Engine C sampled motion (RK4), when the problem declares `simulate:`. */
  trajectory: {
    instance: string;
    mode: string;
    laws: string[];
    integrator: string;
    t: number[];
    position: number[][];
    velocity: number[][];
    speed: number[];
  } | null;
  checks: {
    dimensions: string;
    engines: string[];
    paths_found: number;
    paths_agree: boolean;
    path_spread: number;
  };
  timeline: Beat[];
  paths: Array<{
    cost: number;
    laws: string[];
    formulas: string[];
    value: Quantity & { display: string };
    assumptions: string[];
    citations: string[];
    steps: unknown[];
  }>;
}

export interface ProblemIndex {
  schema: string;
  contentHash: string;
  problems: Array<{
    id: string;
    title: string;
    text: string;
    source: string;
    tags: string[];
    target: string;
    answer: string;
    beats: number;
    paths: number;
    laws: string[];
    components: string[];
    spec: string;
  }>;
}

// --------------------------------------------------------------------------- loading

const base = (): string => {
  // Vite rewrites BASE_URL per deployment; GitHub Pages serves under a subpath.
  const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return b.endsWith('/') ? b : `${b}/`;
};

async function getJson<T>(path: string): Promise<T> {
  const url = `${base()}physics/${path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cannot load ${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Everything the app needs, loaded once. */
export interface Physics {
  kb: KnowledgeBase;
  index: ProblemIndex;
  spec(id: string): Promise<SimSpec>;
}

export async function loadPhysics(): Promise<Physics> {
  const [kb, index] = await Promise.all([
    getJson<KnowledgeBase>('kb.json'),
    getJson<ProblemIndex>('problems.json'),
  ]);

  if (kb.contentHash !== index.contentHash) {
    throw new Error(
      `physics bundle is inconsistent: kb.json is ${kb.contentHash} but problems.json is ` +
        `${index.contentHash}. Re-run \`ff export\`.`,
    );
  }
  if (kb.audit.errors !== 0) {
    throw new Error(`refusing to run on a knowledge base with ${kb.audit.errors} validator errors`);
  }

  const cache = new Map<string, Promise<SimSpec>>();
  return {
    kb,
    index,
    spec(id: string) {
      let hit = cache.get(id);
      if (!hit) {
        hit = getJson<SimSpec>(`specs/${id}.json`);
        cache.set(id, hit);
      }
      return hit;
    },
  };
}

// --------------------------------------------------------------------------- formatting

/** Format a value the way the kernel does, so captions match the trace exactly. */
export function formatNumber(x: number, sig = 4): string {
  if (x === 0) return '0';
  if (!Number.isFinite(x)) return String(x);
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp >= -4 && exp < 6) {
    const text = x.toFixed(Math.max(0, sig - 1 - exp));
    return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
  }
  return x.toExponential(sig - 1).replace('e+', 'e');
}

export function formatQuantity(q: Quantity, unit: string, sig = 4): string {
  if (isVector(q)) {
    return `[${q.value.map((c) => formatNumber(c, sig)).join(', ')}] ${unit}`.trim();
  }
  return `${formatNumber(q.value as number, sig)} ${unit}`.trim();
}
