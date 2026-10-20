/**
 * Field sampling: what your hand (and the arrow grid) reads.
 *
 * The magnitude at every sample point is *resolved by the kernel*: for each source we build the
 * smallest scene that asks the question — source + `field_probe`, joined by an `acts_on`
 * relation carrying the separation — and run `Resolver` on `em.electric_field_magnitude`.
 * The direction is geometry, not physics-by-hand: away from a positive charge, toward a
 * negative one, along the source->point line. Superposition is the sum over sources, exactly
 * as the law the trace cites (`superposition_electric`) states.
 *
 * If the resolver cannot produce a magnitude, this module returns `null`. It never invents one.
 */

import type { KnowledgeBase, Vec3 } from '../physics/kernel.js';
import { Resolver, buildScene } from '../physics/resolve.js';

export interface FieldSource {
  id: string;
  /** Signed charge in coulombs. */
  charge: number;
  /** Bench/world position of the source, metres. Only relative offsets are used. */
  position: Vec3;
}

export interface FieldSample {
  /** Electric field vector, V/m. */
  e: Vec3;
  magnitude: number;
  /** Electric potential, V (zero at infinity), summed over sources. */
  potential: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v: Vec3): number => Math.hypot(v[0], v[1], v[2]);

/**
 * Resolve `prop` for a probe at `point` relative to one source, or return null.
 * One tiny scene per query keeps this honest: it is the corpus p002 scene with a new `r`.
 */
function resolveForSource(
  kb: KnowledgeBase,
  source: FieldSource,
  point: Vec3,
  prop: 'em.electric_field_magnitude' | 'em.electric_potential',
): number | null {
  const offset = sub(point, source.position);
  const r = Math.max(len(offset), 1e-6);
  try {
    const scene = buildScene(
      {
        instances: [
          { id: 'src', kind: 'point_charge', set: { 'em.charge': `${source.charge} C` } },
          { id: 'probe', kind: 'field_probe', set: {} },
        ],
        relations: [
          { kind: 'acts_on', from: 'src', to: 'probe', set: { 'geometry.separation': `${r} m` } },
        ],
      },
      kb,
      { where: 'field-sample' },
    );
    const paths = new Resolver(kb, scene).resolve({ instance: 'probe', prop });
    if (paths.length === 0) return null;
    const value = paths[0]!.steps[paths[0]!.steps.length - 1]!.quantity.value;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

/** The superposed field at `point`, or null if no source could be resolved. */
export function fieldAt(kb: KnowledgeBase, sources: FieldSource[], point: Vec3): FieldSample | null {
  if (sources.length === 0) return null;
  const e: Vec3 = [0, 0, 0];
  let potential = 0;
  let any = false;

  for (const source of sources) {
    const offset = sub(point, source.position);
    const r = len(offset);
    if (r < 1e-9) continue;
    const mag = resolveForSource(kb, source, point, 'em.electric_field_magnitude');
    if (mag === null) continue;
    any = true;
    const dir = (Math.sign(source.charge) || 1) / r;
    e[0] += mag * offset[0] * dir;
    e[1] += mag * offset[1] * dir;
    e[2] += mag * offset[2] * dir;
    const v = resolveForSource(kb, source, point, 'em.electric_potential');
    if (v !== null) potential += v;
  }
  if (!any) return null;
  return { e, magnitude: len(e), potential };
}

/**
 * Log-scaled display length for an arrow: field magnitudes span decades (a microcoulomb at
 * 5 cm is ~10^7 V/m), so a linear arrow would be invisible or room-sized. The *readout*
 * always shows the true resolved value; only the arrow's length is compressed, and the
 * trust card says so.
 */
export function arrowLength(magnitude: number): number {
  if (!(magnitude > 0)) return 0;
  const t = Math.min(1, Math.max(0, (Math.log10(magnitude) - 2) / 6)); // 10^2 .. 10^8 V/m
  return 0.02 + t * 0.11;
}

/** Charges that can act as field sources, with their scene charge in coulombs. */
export function sourceCharge(kind: string, givenCharge: number | undefined): number | null {
  if (givenCharge !== undefined) return givenCharge;
  if (kind === 'electron') return -1.602176634e-19;
  return null;
}
