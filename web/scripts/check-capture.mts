/**
 * Capture pipeline check: page splitting and corpus matching (ff/capture.ts).
 *
 * The OCR itself is exercised separately (`npm run check:ocr`, slow and WASM-heavy);
 * what must never regress here is the judgement after OCR: a numbered page becomes
 * the right list of questions, noise does not shred a question, and a textbook
 * question about a 12 V battery and a 4 ohm resistor is recognised as the verified
 * corpus problem it is — while an unrelated question is not force-matched.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { matchCorpus, splitQuestions, type CorpusCandidate } from '../src/ff/capture.ts';

let failures = 0;
const ok = (label: string, cond: boolean, detail: string) => {
  console.log(`${cond ? '✓' : '✗ FAIL'} ${label}: ${detail}`);
  if (!cond) failures++;
};

const page = [
  'EXERCISE 4.2',
  '1. A 12 V battery is connected to a 4 ohm resistor. What current flows through it?',
  '2. Two resistors 10 ohm and 20 ohm are in series across 9 V. Find the current.',
  '3. A point charge of 2 uC sits in vacuum. What is the electric field 30 cm away?',
].join('\n');
const qs = splitQuestions(page);
ok('numbered page splits into 3 questions', qs.length === 3, qs.map((q) => q.marker).join(', '));
ok('question bodies keep their physics', qs[0]?.text.includes('4 ohm') === true && qs[2]?.text.includes('30 cm') === true,
  qs.map((q) => q.text.slice(0, 28)).join(' | '));

const single = splitQuestions('An electron is released from rest across 100 V. How fast is it moving?');
ok('unnumbered text stays one question', single.length === 1, single[0]?.marker ?? '');

const noisy = splitQuestions('The 3.5 mm jack costs 2.50 and the value 1.5 appears twice in the table.');
ok('numbers inside prose do not shred the question', noisy.length === 1, `${noisy.length} question(s)`);

const corpus: CorpusCandidate[] = [
  { id: 'p101', haystack: 'Current in a single-resistor loop\nA 12 V battery is connected by ideal wires to a single 4.0 ohm resistor. What current flows around the loop?' },
  { id: 'p002', haystack: 'Field of a point charge\nA point charge of +2.0 uC sits in vacuum. What is the magnitude of the electric field at 30 cm?' },
];
const m1 = matchCorpus(qs[0]!.text, corpus);
ok('textbook loop question matches p101', m1?.id === 'p101', `score ${m1?.score.toFixed(2)}`);
const m2 = matchCorpus(qs[2]!.text, corpus);
ok('textbook field question matches p002', m2?.id === 'p002', `score ${m2?.score.toFixed(2)}`);
ok('unrelated question is not force-matched',
  matchCorpus('Describe the process of photosynthesis in a leaf and its stages', corpus) === null, 'null as required');

if (failures > 0) { console.error(`\n${failures} capture check(s) FAILED`); process.exit(1); }
console.log('\ncapture splitting + corpus matching behave');
