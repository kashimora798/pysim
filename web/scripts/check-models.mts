/**
 * CAD model bundle check: the imported models must be real, small, licensed, and
 * anchored to the kernel's component kinds.
 *
 * For every entry in public/gltf/models/manifest.json this asserts the GLB exists,
 * has a valid glTF binary header, stays under the size budget that keeps the Quest
 * at 60 fps, names a component kind the kernel actually exports, carries licence +
 * attribution, and has at least two footprint pads (a component with one terminal
 * cannot be wired). Run via `npm run check:models`; part of `npm run check`.
 */

import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const webRoot = process.cwd(); // bundled into node_modules/.cache; cwd is web/ (cf. check-experience)
const SIZE_BUDGET = 256 * 1024; // per model; the whole set should cost less than a texture

const kb = JSON.parse(readFileSync(join(webRoot, 'public/physics/kb.json'), 'utf8')) as {
  components: Record<string, unknown>;
};
const manifest = JSON.parse(
  readFileSync(join(webRoot, 'public/gltf/models/manifest.json'), 'utf8'),
) as {
  library: { license: string };
  models: Record<
    string,
    {
      glb: string;
      license: string;
      attribution: string;
      triangles: number;
      pads: Array<{ terminal: string | null; pos: [number, number] }>;
    }
  >,
};

let failures = 0;
const fail = (msg: string): void => {
  failures += 1;
  console.error(`✗ ${msg}`);
};

const kinds = Object.keys(manifest.models);
if (kinds.length === 0) fail('manifest lists no models');

for (const [kind, entry] of Object.entries(manifest.models)) {
  if (!(kind in kb.components)) fail(`${kind}: not a kernel component kind`);
  if (!entry.license || !entry.attribution) fail(`${kind}: missing licence/attribution`);
  const file = join(webRoot, 'public', entry.glb);
  const bytes = readFileSync(file);
  if (bytes.length > SIZE_BUDGET) fail(`${kind}: ${bytes.length} bytes over budget`);
  if (bytes.toString('ascii', 0, 4) !== 'glTF') fail(`${kind}: not a GLB (bad magic)`);
  if (bytes.readUInt32LE(8) !== bytes.length) fail(`${kind}: GLB length header mismatch`);
  // A model with no material or no normals renders as faceted white plastic. That is what
  // shipped once, because the importer merged the scene and dropped both, so check it here.
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.toString('utf8', 20, 20 + jsonLength)) as {
    materials?: unknown[];
    meshes?: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  };
  if ((gltf.materials?.length ?? 0) < 1) fail(`${kind}: GLB has no materials (colours were lost)`);
  const primitives = (gltf.meshes ?? []).flatMap((m) => m.primitives);
  if (primitives.length === 0 || primitives.some((p) => p.attributes.NORMAL === undefined)) {
    fail(`${kind}: GLB is missing vertex normals`);
  }
  const wired = entry.pads.filter((p) => p.terminal !== null);
  if (wired.length < 2) fail(`${kind}: fewer than two mapped footprint terminals`);
  for (const pad of entry.pads) {
    if (Math.abs(pad.pos[0]) > 0.5 + 1e-6 || Math.abs(pad.pos[1]) > 0.5 + 1e-6) {
      fail(`${kind}: pad ${pad.pos} outside the normalized unit box`);
    }
  }
  console.log(
    `✓ ${kind}: ${(statSync(file).size / 1024).toFixed(0)} KiB, ${entry.triangles} tris, ` +
      `${wired.length} wired terminals, ${entry.license}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} CAD model check(s) failed`);
  process.exit(1);
}
console.log(`\nCAD models verified against the kernel bundle (${kinds.length} kinds)`);
