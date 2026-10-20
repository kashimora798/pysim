/**
 * The guided build: a problem, turned into hand-sized steps.
 *
 * This module is pure (no DOM, no XR, no three.js) so the check script can test it in
 * node. It reads a verified SimSpec and produces the sequence a learner performs with
 * their hands in the headset:
 *
 *   place    — grab a component from the palette, turn it in your hand, drop it on
 *              the bench (verified when the right kind has *settled*, not merely been
 *              spawned into a fist);
 *   wire     — pinch a terminal and stretch the wire to another component (verified
 *              against the actual wire graph: the two component *kinds* the solution
 *              topology joins, counted against a per-step baseline);
 *   position — move one part near another (the physical meaning of non-wiring
 *              relations like `inside` / `acts_on`);
 *   observe  — a given/resolution/answer beat: watch the value arrive, with its
 *              formula and citation on the trust card.
 *
 * Abstract scene instances (a `circuit_loop`, a `series_pair`, an `environment`) are
 * not things a hand can hold, so they never become place steps. A wiring relation
 * that mentions one is re-expressed between the physical parts it connects: a loop
 * `driven_by` a battery and `loads`-ing a resistor becomes "wire the battery to the
 * resistor" — twice, because closing a loop takes two leads, which the per-step
 * baseline counting enforces naturally.
 */

import type { Beat, SimSpec } from '../physics/kernel.js';

export type GuideAction = 'place' | 'wire' | 'position' | 'observe';

export interface GuideStep {
  /** 1-based position in the guide. */
  index: number;
  total: number;
  action: GuideAction;
  /** The timeline beat this step was derived from. */
  beat: Beat;
  /** Short imperative headline, e.g. "Place the resistor". */
  title: string;
  /** The full hand-first instruction shown on the guide panel. */
  instruction: string;
  /** Component kind for `place` steps. */
  component?: string;
  /** Component kinds for `wire` / `position` steps. */
  fromKind?: string;
  toKind?: string;
  /** True for the final answer beat. */
  final?: boolean;
}

/** Relations a wire can physically express. Everything else is positioning. */
const WIRING_RELATIONS = new Set([
  'driven_by', 'loads', 'series_a', 'series_b', 'parallel_a', 'parallel_b',
  'terminal_a', 'terminal_b', 'positive_terminal', 'negative_terminal',
  'charged_through',
]);

export interface GuideContext {
  /** kind -> human label ("Resistor"). */
  labels: ReadonlyMap<string, string>;
  /** Kinds a hand can hold (kernel components with a model). */
  placeable: ReadonlySet<string>;
}

const label = (ctx: GuideContext, kind: string | undefined): string =>
  (kind !== undefined && ctx.labels.get(kind)) || kind || 'part';

export function buildGuideSteps(spec: SimSpec, ctx: GuideContext): GuideStep[] {
  const kindOf = new Map(spec.scene.instances.map((i) => [i.id, i.kind]));
  const placeableKindOf = (id: string | undefined): string | null => {
    if (id === undefined) return null;
    const kind = kindOf.get(id);
    return kind !== undefined && ctx.placeable.has(kind) ? kind : null;
  };
  /** Physical kinds a scene instance resolves to (itself, or its wired neighbours). */
  const physicalKinds = (id: string | undefined): string[] => {
    const own = placeableKindOf(id);
    if (own !== null) return [own];
    if (id === undefined) return [];
    const out: string[] = [];
    for (const rel of spec.scene.relations) {
      const other = rel.from === id ? rel.to : rel.to === id ? rel.from : undefined;
      const kind = placeableKindOf(other);
      if (kind !== null && !out.includes(kind)) out.push(kind);
    }
    return out;
  };

  const steps: GuideStep[] = [];
  const placed = new Set<string>();
  const push = (step: Omit<GuideStep, 'index' | 'total'>): void => {
    steps.push({ ...step, index: steps.length + 1, total: 0 });
  };

  for (const beat of spec.timeline) {
    if (beat.kind === 'place' && beat.instance !== undefined && beat.component !== undefined) {
      if (!ctx.placeable.has(beat.component) || placed.has(beat.instance)) continue;
      placed.add(beat.instance);
      const name = label(ctx, beat.component);
      push({
        action: 'place',
        beat,
        component: beat.component,
        title: `Place the ${name.toLowerCase()}`,
        instruction:
          `🤚 Palm up for the palette, pinch the ${name} and pull it out. ` +
          `Turn it in your hand to look at it, then open your hand over the bench — ` +
          `it settles flat where you drop it. (${beat.instance})`,
      });
    } else if (beat.kind === 'relate' && beat.from !== undefined && beat.to !== undefined) {
      const relation = beat.relation ?? '';
      if (WIRING_RELATIONS.has(relation)) {
        const fromKinds = physicalKinds(beat.from);
        const toKinds = physicalKinds(beat.to);
        const toKind = toKinds[0];
        const fromKind = fromKinds.find((k) => k !== toKind) ?? fromKinds[0];
        if (fromKind === undefined || toKind === undefined) continue;
        push({
          action: 'wire',
          beat,
          fromKind,
          toKind,
          title: `Wire the ${label(ctx, fromKind).toLowerCase()} to the ${label(ctx, toKind).toLowerCase()}`,
          instruction:
            `🔌 Pinch the glowing terminal on the ${label(ctx, fromKind)} and stretch ` +
            `the wire across to the glowing terminal on the ${label(ctx, toKind)}. ` +
            `Let go to connect it.`,
        });
      } else {
        const fromKind = placeableKindOf(beat.from) ?? physicalKinds(beat.from)[0];
        const toKind = placeableKindOf(beat.to) ?? physicalKinds(beat.to)[0];
        if (fromKind === undefined || toKind === undefined || fromKind === toKind) continue;
        push({
          action: 'position',
          beat,
          fromKind,
          toKind,
          title: `Bring the ${label(ctx, fromKind).toLowerCase()} to the ${label(ctx, toKind).toLowerCase()}`,
          instruction:
            `✋ Pick up the ${label(ctx, fromKind)} and hold it right next to the ` +
            `${label(ctx, toKind)} — close enough to interact (${relation}).`,
        });
      }
    } else {
      // given / resolve / answer: nothing to build, something to see.
      push({
        action: 'observe',
        beat,
        title: beat.kind === 'answer' ? 'The answer' : 'Watch',
        instruction: beat.narrate,
        final: beat.kind === 'answer',
      });
    }
  }

  for (const step of steps) step.total = steps.length;
  return steps;
}

/** Order-free key for a wired pair of kinds ("battery|resistor"). */
export const wirePairKey = (a: string, b: string): string => [a, b].sort().join('|');

/** Does a wire between parts of kinds `a` and `b` satisfy this wire step? */
export function wireMatchesStep(step: GuideStep, a: string, b: string): boolean {
  return (
    step.action === 'wire' &&
    step.fromKind !== undefined &&
    step.toKind !== undefined &&
    wirePairKey(a, b) === wirePairKey(step.fromKind, step.toKind)
  );
}
