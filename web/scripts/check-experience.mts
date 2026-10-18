/**
 * Experience regression check: the bench's two new engines against golden answers.
 *
 *   topology.ts  wire graph -> reduction tree -> Resolver  must reproduce p101/p102/p103/p105
 *   field.ts     per-point kernel scenes                   must reproduce p002 (E and V)
 *   refusals     shorted battery / open loop / bridge      must be refused, never solved wrong
 *
 * Run via `npm run check:experience` (esbuild bundles the TS kernel, then node executes it).
 * A failure here means the bench would teach wrong physics — treat it like `ff audit` failing.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildCircuitScene } from '../src/ff/topology.ts';
import { fieldAt } from '../src/ff/field.ts';
import { Resolver, buildScene } from '../src/physics/resolve.ts';

const kb = JSON.parse(readFileSync(join(process.cwd(), 'public', 'physics', 'kb.json'), 'utf8'));

let failures = 0;
const check = (label: string, got: number, want: number, tol = 1e-9) => {
  const ok = Math.abs(got - want) <= tol * Math.max(1, Math.abs(want));
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: got ${got}, want ${want}`);
  if (!ok) failures++;
};
const checkRefused = (label: string, parts: never[], wires: never[]) => {
  const r = buildCircuitScene(parts as never, wires as never);
  const ok = !r.ok;
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}: ${ok ? `refused ("${(r as { error: string }).error.slice(0, 60)}…")` : 'SOLVED (should refuse!)'}`);
  if (!ok) failures++;
};

const W = (aId: string, aTerm: number, bId: string, bTerm: number) => ({ aId, aTerm, bId, bTerm });
const bat = (v: number) => ({ id: 'bat', kind: 'battery', values: { 'electric.emf': `${v} V` } });
const R = (id: string, ohm: number) => ({ id, kind: 'resistor', values: { 'electric.resistance': `${ohm} ohm` } });

function solve(label: string, parts: never[], wires: never[], want: number) {
  const topo = buildCircuitScene(parts as never, wires as never);
  if (!topo.ok) { console.log(`✗ FAIL ${label}: topology refused: ${topo.error}`); failures++; return; }
  const scene = buildScene(topo.spec, kb);
  const paths = new Resolver(kb, scene).resolve(topo.target);
  const value = paths[0]?.steps[paths[0].steps.length - 1]?.quantity.value;
  check(label, typeof value === 'number' ? value : NaN, want);
}

solve('p101 single loop (12V, 4Ω)', [bat(12), R('r1', 4)], [W('bat', 0, 'r1', 0), W('r1', 1, 'bat', 1)], 3);
solve('p102 series (9V, 10+20Ω)', [bat(9), R('r1', 10), R('r2', 20)],
  [W('bat', 0, 'r1', 0), W('r1', 1, 'r2', 0), W('r2', 1, 'bat', 1)], 0.3);
solve('p103 parallel (12V, 6‖3Ω)', [bat(12), R('r1', 6), R('r2', 3)],
  [W('bat', 0, 'r1', 0), W('r1', 1, 'bat', 1), W('bat', 0, 'r2', 0), W('r2', 1, 'bat', 1)], 6);
solve('p105 nested (30V, (10+20)‖30Ω)', [bat(30), R('r1', 10), R('r2', 20), R('r3', 30)],
  [W('bat', 0, 'r1', 0), W('r1', 1, 'r2', 0), W('r2', 1, 'bat', 1), W('bat', 0, 'r3', 0), W('r3', 1, 'r2', 1)], 2);

checkRefused('shorted battery refused', [bat(12), R('r1', 4)], [W('bat', 0, 'bat', 1), W('bat', 0, 'r1', 0), W('r1', 1, 'bat', 1)]);
checkRefused('open loop refused', [bat(12), R('r1', 4)], [W('bat', 0, 'r1', 0)]);

const f = fieldAt(kb, [{ id: 'q1', charge: 2e-6, position: [0, 0, 0] }], [0.3, 0, 0]);
check('p002 field magnitude (2µC @ 30cm)', f?.magnitude ?? NaN, 199723.37, 1e-4);
check('p002 potential (2µC @ 30cm)', f?.potential ?? NaN, 59917.01, 1e-4);
const neg = fieldAt(kb, [{ id: 'q1', charge: -2e-6, position: [0, 0, 0] }], [0.3, 0, 0]);
check('negative charge points inward (Ex < 0)', Math.sign(neg?.e[0] ?? 0), -1, 0);

if (failures > 0) { console.error(`\n${failures} experience check(s) FAILED`); process.exit(1); }
console.log('\nbench engines reproduce the golden answers; refusals are honest');
