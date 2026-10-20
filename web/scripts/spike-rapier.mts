/**
 * Rapier evaluation spike -- NOT part of the runtime bench.
 *
 * Proves the two things the 3D plan (docs/3d-asset-pipeline-plan.md) needs from a
 * general physics engine before any of it is wired in:
 *
 *   1. `@dimforge/rapier3d-compat` loads and steps in our toolchain (it inlines its
 *      WASM, so there is no extra asset to serve -- important for the Quest browser),
 *   2. its *queries* work the way the bench would use them: a placement raycast
 *      ("is this spot on the desk free / what does the hand hit first?") and a
 *      sensor overlap test ("would this part intersect that one?").
 *
 * What this deliberately does NOT do is integrate any physics motion. The kernel
 * (Python Engines A-C) is the only thing allowed to move a charged particle or
 * decide a trajectory; a game engine's numbers are plausible, not lawful, and
 * would silently void the verified answers the bench exists to show. Rapier's
 * role, if adopted, is interaction only: hands, props, placement, collision.
 *
 * Run: npx tsx scripts/spike-rapier.mts  (or via esbuild like the other checks)
 */

import RAPIER from '@dimforge/rapier3d-compat';

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });

// A desk surface and one resting prop, as fixed/kinematic colliders.
world.createCollider(RAPIER.ColliderDesc.cuboid(0.3, 0.01, 0.2).setTranslation(0, 0, 0));
const propBody = world.createRigidBody(
  RAPIER.RigidBodyDesc.fixed().setTranslation(0.05, 0.03, 0),
);
world.createCollider(RAPIER.ColliderDesc.cuboid(0.025, 0.025, 0.025), propBody);
world.step(); // queries read the query pipeline, which a step refreshes

// 1. Raycast straight down: the first hit should be the prop top (y = 0.055),
//    not the desk (y = 0.01) -- this is the hand-as-probe query.
const ray = new RAPIER.Ray({ x: 0.05, y: 0.5, z: 0 }, { x: 0, y: -1, z: 0 });
const hit = world.castRay(ray, 1.0, true);
if (hit === null || Math.abs(0.5 - hit.toi - 0.055) > 1e-6) {
  console.error('✗ raycast did not land on the prop top');
  process.exit(1);
}
console.log(`✓ placement raycast hits prop top at y=${(0.5 - hit.toi).toFixed(3)}`);

// 2. Sensor overlap: a candidate part volume overlapping the prop must report it,
//    and a clear volume must not -- the spawn-placement validation query.
const shape = new RAPIER.Cuboid(0.025, 0.025, 0.025);
let overlaps = 0;
world.intersectionsWithShape({ x: 0.05, y: 0.03, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, shape, () => {
  overlaps += 1;
  return true;
});
if (overlaps === 0) {
  console.error('✗ overlap query missed the prop');
  process.exit(1);
}
let clear = 0;
world.intersectionsWithShape({ x: -0.2, y: 0.2, z: 0 }, { w: 1, x: 0, y: 0, z: 0 }, shape, () => {
  clear += 1;
  return true;
});
if (clear !== 0) {
  console.error('✗ overlap query reported a phantom collision');
  process.exit(1);
}
console.log('✓ sensor overlap detects the prop and clears empty desk');

// 3. Determinism spot-check: two identical worlds stepped identically agree
//    bit-for-bit. (Rapier is deterministic per-platform by construction; this
//    guards the claim in our environment before the plan leans on it.)
const drop = (): number => {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const b = w.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(0, 1, 0));
  w.createCollider(RAPIER.ColliderDesc.ball(0.02), b);
  for (let i = 0; i < 120; i += 1) w.step();
  return b.translation().y;
};
const [a, b] = [drop(), drop()];
if (a !== b) {
  console.error(`✗ determinism check diverged: ${a} vs ${b}`);
  process.exit(1);
}
console.log(`✓ deterministic stepping agrees bit-for-bit (y=${a.toFixed(6)} after 120 steps)`);

console.log('\nRapier spike passed: queries + determinism verified, runtime bench untouched');
