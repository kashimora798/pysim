/**
 * Cross-language kernel check.
 *
 * The Python kernel computed every value in every precompiled trace. This script replays each
 * derived step through the TypeScript evaluator and compares. A disagreement means the two halves
 * of the kernel have drifted, which would make the browser show numbers the validators never
 * proved — so this runs in CI and fails the build, exactly like `ff audit`.
 *
 *   node --experimental-strip-types scripts/verify-kernel.mts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { evalAst, type Ast } from '../src/physics/kernel.ts';

const PHYSICS = join(import.meta.dirname, '..', 'public', 'physics');

type Val = number | [number, number, number];

interface Formula {
  ast: Ast;
  exprText: string;
  bindings: Record<string, unknown>;
}

const kb = JSON.parse(readFileSync(join(PHYSICS, 'kb.json'), 'utf8')) as {
  contentHash: string;
  formulas: Record<string, Formula>;
  audit: { coverage: { total: number } };
};

/** Relative comparison, with an absolute floor so exact zeros (the shielded cavity) pass. */
const agrees = (got: Val, want: Val): boolean => {
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-30);
  if (Array.isArray(got) !== Array.isArray(want)) return false;
  if (Array.isArray(got) && Array.isArray(want)) {
    return got.every((c, i) => close(c, want[i]));
  }
  return close(got as number, want as number);
};

const fmt = (v: Val): string =>
  Array.isArray(v) ? `[${v.map((x) => x.toPrecision(8)).join(', ')}]` : (v as number).toPrecision(8);

let specs = 0;
let checked = 0;
let skipped = 0;
const failures: string[] = [];

for (const file of readdirSync(join(PHYSICS, 'specs')).sort()) {
  if (!file.endsWith('.json')) continue;
  specs += 1;
  const spec = JSON.parse(readFileSync(join(PHYSICS, 'specs', file), 'utf8')) as {
    problem: { id: string };
    timeline: Array<{
      beat: number;
      kind: string;
      value?: Val;
      because: {
        kind: string;
        formula?: string;
        inputs?: Array<{ symbol: string; value: Val }>;
      };
    }>;
  };

  for (const beat of spec.timeline) {
    if (beat.kind !== 'resolve' || beat.because.kind !== 'derived') continue;

    const key = beat.because.formula!;
    const formula = kb.formulas[key];
    if (!formula) {
      failures.push(`${spec.problem.id} beat ${beat.beat}: kb.json has no formula "${key}"`);
      continue;
    }

    const env: Record<string, Val> = {};
    for (const input of beat.because.inputs ?? []) env[input.symbol] = input.value;

    // A formula with no inputs (the shielded cavity is `0`) still evaluates; nothing to skip.
    let got: Val;
    try {
      got = evalAst(formula.ast, env) as Val;
    } catch (err) {
      failures.push(
        `${spec.problem.id} beat ${beat.beat} (${key}): threw ${(err as Error).message}`,
      );
      continue;
    }

    if (beat.value === undefined) {
      skipped += 1;
      continue;
    }

    checked += 1;
    if (!agrees(got, beat.value)) {
      failures.push(
        `${spec.problem.id} beat ${beat.beat} (${key}: ${formula.exprText})\n` +
          `    python: ${fmt(beat.value)}\n` +
          `    typescript: ${fmt(got)}`,
      );
    }
  }
}

console.log(`knowledge base  ${kb.contentHash}`);
console.log(`specs           ${specs}`);
console.log(`derived steps   ${checked} compared${skipped ? `, ${skipped} without a value` : ''}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} DISAGREEMENT(S) between the Python and TypeScript kernels:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

console.log('\nthe TypeScript evaluator reproduces every Python value to 1e-9 relative');
