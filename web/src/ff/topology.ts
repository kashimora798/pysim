/**
 * Wire graph -> Scene: the topology translation (ADR-1).
 *
 * The bench speaks in terminal-to-terminal wires. The kernel speaks in reified relations:
 * a `circuit_loop` `driven_by` a battery and `loads`-ing a `series_pair`/`parallel_pair`
 * reduction tree. This pure module translates one into the other:
 *
 *   1. Union-find merges terminals joined by wires into electrical nodes.
 *   2. Every two-terminal load (resistor, lamp) becomes an edge between two nodes.
 *   3. Series nodes (degree 2, not a supply terminal) and parallel edge pairs are
 *      repeatedly reduced into `series_pair` / `parallel_pair` instances — the same
 *      reduction tree the corpus problems author by hand, and the same tree the
 *      student physically built.
 *   4. What remains is one edge between the battery's terminals: that is the loop load.
 *
 * A graph that is neither series- nor parallel-reducible is refused honestly
 * ("needs the system solver") — it is never silently solved as a different circuit.
 * Nothing here computes a number; `buildScene` + `Resolver` do that, or nobody does.
 */

import type { SceneSpec } from '../physics/resolve.js';

export interface BenchPart {
  /** Scene instance id, e.g. `r1`. */
  id: string;
  /** Knowledge-base component kind, e.g. `resistor`. */
  kind: string;
  /** Settable property values as quantity strings, e.g. `{ "electric.resistance": "10 ohm" }`. */
  values: Record<string, string>;
}

export interface BenchWire {
  aId: string;
  aTerm: number;
  bId: string;
  bTerm: number;
}

export type TopologyResult =
  | {
      ok: true;
      spec: SceneSpec;
      target: { instance: string; prop: string };
      rootId: string;
      batteryId: string;
      loadIds: string[];
      summary: string;
    }
  | { ok: false; error: string };

const LOADS = new Set(['resistor', 'lamp']);

/** Values a fresh part carries on the bench until the student edits them. Stated, never hidden. */
export function benchDefaults(kind: string): Record<string, string> {
  switch (kind) {
    case 'battery':
      return { 'electric.emf': '12 V' };
    case 'resistor':
    case 'lamp':
      return { 'electric.resistance': '10 ohm' };
    case 'capacitor':
      return { 'electric.capacitance': '100 uF' };
    default:
      return {};
  }
}

class UnionFind {
  private readonly parent = new Map<string, string>();
  find(x: string): string {
    let root = x;
    while (this.parent.get(root) !== undefined && this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    let cur = x;
    while (this.parent.get(cur) !== undefined && this.parent.get(cur) !== cur) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    if (!this.parent.has(x)) this.parent.set(x, x);
    return this.parent.get(x) ?? x;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

interface Edge {
  id: string;
  n1: string;
  n2: string;
}

/** The scenespec's values for one part: bench defaults overlaid with the student's edits. */
function valuesFor(part: BenchPart): Record<string, string> {
  return { ...benchDefaults(part.kind), ...part.values };
}

export function buildCircuitScene(parts: BenchPart[], wires: BenchWire[]): TopologyResult {
  const battery = parts.find((p) => p.kind === 'battery');
  if (!battery) return { ok: false, error: 'No battery on the bench — every loop needs a source.' };
  const loads = parts.filter((p) => LOADS.has(p.kind));
  if (loads.length === 0)
    return { ok: false, error: 'No resistor or lamp wired in — there is nothing to drive.' };
  for (const part of [battery, ...loads]) {
    const v = valuesFor(part);
    if (part.kind === 'battery' && !v['electric.emf'])
      return { ok: false, error: `${part.id}: the battery has no emf set.` };
    if (LOADS.has(part.kind) && !v['electric.resistance'])
      return { ok: false, error: `${part.id}: this ${part.kind} has no resistance set.` };
  }
  if (wires.length === 0)
    return { ok: false, error: 'No wires yet — pinch a terminal and pull a lead to close the loop.' };

  // 1. Wires merge terminals into electrical nodes.
  const uf = new UnionFind();
  const nodeOf = (id: string, term: number) => uf.find(`${id}:${term}`);
  for (const w of wires) uf.union(`${w.aId}:${w.aTerm}`, `${w.bId}:${w.bTerm}`);
  const supplyA = nodeOf(battery.id, 0);
  const supplyB = nodeOf(battery.id, 1);
  if (supplyA === supplyB)
    return { ok: false, error: 'The battery is shorted: both terminals land on the same node.' };

  // 2. Loads become edges between nodes.
  const edges: Edge[] = [];
  for (const load of loads) {
    const n1 = nodeOf(load.id, 0);
    const n2 = nodeOf(load.id, 1);
    if (n1 === n2)
      return { ok: false, error: `${load.id} is wired to itself — its two terminals are one node.` };
    edges.push({ id: load.id, n1, n2 });
  }

  // 3. Reduce: series nodes first (they are how students chain parts), then parallel pairs.
  const instances: SceneSpec['instances'] = [
    { id: battery.id, kind: 'battery', set: valuesFor(battery) },
    ...loads.map((l) => ({ id: l.id, kind: l.kind, set: valuesFor(l) })),
  ];
  const relations: SceneSpec['relations'] = [];
  let pairCount = 0;

  const combine = (kind: 'series_pair' | 'parallel_pair', a: Edge, b: Edge, n1: string, n2: string): Edge => {
    pairCount += 1;
    const id = `${kind === 'series_pair' ? 'sp' : 'pp'}${pairCount}`;
    instances.push({ id, kind, set: {} });
    const prefix = kind === 'series_pair' ? 'series' : 'parallel';
    relations.push({ kind: `${prefix}_a`, from: id, to: a.id, set: {} });
    relations.push({ kind: `${prefix}_b`, from: id, to: b.id, set: {} });
    return { id, n1, n2 };
  };

  let guard = 0;
  while (edges.length > 1 && guard++ < 64) {
    // Parallel: two edges sharing both endpoints.
    let reduced = false;
    for (let i = 0; i < edges.length && !reduced; i++) {
      for (let j = i + 1; j < edges.length; j++) {
        const a = edges[i]!;
        const b = edges[j]!;
        const same =
          (a.n1 === b.n1 && a.n2 === b.n2) || (a.n1 === b.n2 && a.n2 === b.n1);
        if (same) {
          const merged = combine('parallel_pair', a, b, a.n1, a.n2);
          edges.splice(j, 1);
          edges.splice(i, 1);
          edges.push(merged);
          reduced = true;
          break;
        }
      }
    }
    if (reduced) continue;

    // Series: a non-supply node touching exactly two edges.
    const incidence = new Map<string, Edge[]>();
    for (const e of edges) {
      for (const n of [e.n1, e.n2]) {
        const list = incidence.get(n) ?? [];
        list.push(e);
        incidence.set(n, list);
      }
    }
    for (const [node, incident] of incidence) {
      if (node === supplyA || node === supplyB) continue;
      if (incident.length !== 2) continue;
      const [a, b] = incident as [Edge, Edge];
      if (a === b) continue;
      const other = (e: Edge) => (e.n1 === node ? e.n2 : e.n1);
      const merged = combine('series_pair', a, b, other(a), other(b));
      edges.splice(edges.indexOf(b), 1);
      edges.splice(edges.indexOf(a), 1);
      edges.push(merged);
      reduced = true;
      break;
    }
    if (!reduced) {
      return {
        ok: false,
        error:
          'This network is not series/parallel-reducible, so the chain solver honestly ' +
          'refuses it. It needs the system solver (Engine B) — try chaining or pairing the parts.',
      };
    }
  }

  if (edges.length !== 1) return { ok: false, error: 'The wiring does not form a single network yet.' };
  const root = edges[0]!;
  const touchesSupply =
    (root.n1 === supplyA && root.n2 === supplyB) || (root.n1 === supplyB && root.n2 === supplyA);
  if (!touchesSupply)
    return {
      ok: false,
      error: 'The loop is not closed: the network does not reach both battery terminals.',
    };

  instances.push({ id: 'loop', kind: 'circuit_loop', set: {} });
  relations.push({ kind: 'driven_by', from: 'loop', to: battery.id, set: {} });
  relations.push({ kind: 'loads', from: 'loop', to: root.id, set: {} });

  return {
    ok: true,
    spec: { instances, relations },
    target: { instance: 'loop', prop: 'electric.current' },
    rootId: root.id,
    batteryId: battery.id,
    loadIds: loads.map((l) => l.id),
    summary:
      pairCount === 0
        ? `${battery.id} drives ${root.id} directly`
        : `${battery.id} drives a network reduced through ${pairCount} combination(s) to ${root.id}`,
  };
}
