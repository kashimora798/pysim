/**
 * One part-visual factory for the whole bench — the palette (inventory.ts) and the
 * staged lesson parts (experience.ts) must never disagree about what a resistor
 * looks like. They used to: the palette swapped in the real KiCad CAD models while
 * guided/auto modes drew their own unlit boxes, which is why screenshots of the
 * lessons showed blocks next to a palette that had real parts all along.
 *
 * What a part visual is now, everywhere:
 *
 *   1. an instant fallback shape in a *lit* material (also the permanent visual for
 *      idealized physics things — point charges, electrons, probes — which are
 *      generated from the kernel's own scene, with a glow for charges), and
 *   2. for the kinds that have one, the real CAD model from `ff/models.ts`, swapped
 *      in when it arrives. A model that fails to load leaves the fallback; the
 *      bench never depends on the GLB files existing.
 *
 * Abstract kinds (`circuit_loop`, `environment`) are NOT parts: they get a small
 * floating annotation instead of a prop. `createPartVisual` returns that too, so
 * callers have exactly one door to walk through.
 */

import {
  BoxGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  CanvasTexture,
} from '@iwsdk/core';

import { CadModels } from './models.js';

/** World-space maximum extent of a staged part visual, metres. */
export const PART_VISUAL_SIZE = 0.055;

const cad = new CadModels();

/** Kinds that are ideas, not objects. Shown as annotations, never as props. */
export const ANNOTATION_KINDS = new Set(['circuit_loop', 'environment']);

/** Colour by what the kind *is* (substring rules cover the kernel's kind ids). */
export function kindColor(kind: string): number {
  if (kind.includes('battery')) return 0xd97706;
  if (kind.includes('resistor') || kind.includes('series') || kind.includes('parallel_pair')) return 0xb45309;
  if (kind.includes('capacitor')) return 0x2563eb;
  if (kind.includes('lamp')) return 0xfacc15;
  if (kind.includes('electron') || kind.includes('particle')) return 0x38bdf8;
  if (kind.includes('probe')) return 0xe2e8f0;
  if (kind.includes('plane')) return 0x2dd4bf;
  if (kind.includes('magnetic')) return 0x818cf8;
  if (kind.includes('sphere') || kind.includes('shell') || kind.includes('cavity')) return 0xf97316;
  if (kind.includes('charge')) return 0xef4444;
  return 0x94a3b8;
}

function isChargeLike(kind: string): boolean {
  return (
    kind.includes('charge') ||
    kind === 'electron' ||
    kind === 'particle' ||
    kind.includes('sphere') ||
    kind.includes('shell')
  );
}

/**
 * The lit fallback visual for `kind`, built at unit maximum extent with its base
 * at y=0 (the holder's scale turns units into metres). Charges glow; everything
 * shades under the bench lights, because MeshStandardMaterial is lit — the old
 * staging used the same family but flat colours on unlit-looking proxies.
 */
export function fallbackVisual(kind: string): Mesh {
  const color = kindColor(kind);
  let geo: BoxGeometry | SphereGeometry | CylinderGeometry;
  let y = 0.28;
  if (isChargeLike(kind) || kind === 'field_probe' || kind === 'lamp') {
    geo = new SphereGeometry(kind === 'electron' || kind === 'particle' ? 0.26 : 0.34, 24, 18);
    y = 0.36;
  } else if (kind === 'resistor' || kind === 'capacitor') {
    geo = new CylinderGeometry(0.2, 0.2, 0.95, 20);
  } else if (kind.includes('plane')) {
    geo = new BoxGeometry(0.95, 0.06, 0.95);
    y = 0.2;
  } else {
    geo = new BoxGeometry(0.9, 0.55, 0.65);
  }
  const charge = isChargeLike(kind);
  const mat = new MeshStandardMaterial({
    color,
    roughness: 0.38,
    metalness: 0.12,
    emissive: color,
    emissiveIntensity: kind === 'lamp' ? 0.65 : charge ? 0.45 : 0.05,
    transparent: kind.includes('shell'),
    opacity: kind.includes('shell') ? 0.75 : 1,
  });
  const mesh = new Mesh(geo, mat);
  if (geo instanceof CylinderGeometry) mesh.rotation.z = Math.PI / 2;
  mesh.position.y = y;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = `Fallback:${kind}`;
  return mesh;
}

/** A small floating text annotation for an abstract kind (loop, environment). */
export function annotationVisual(kind: string, label: string): Group {
  const group = new Group();
  group.name = `Annotation:${kind}`;
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 160;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'rgba(6,32,28,0.88)';
    ctx.beginPath();
    ctx.roundRect(6, 6, 1012, 148, 26);
    ctx.fill();
    ctx.strokeStyle = '#2dd4bf';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.font = '600 52px system-ui, sans-serif';
    ctx.fillStyle = '#a7f3ea';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.slice(0, 44), 512, 82);
  }
  const tex = new CanvasTexture(canvas);
  const plane = new Mesh(
    new PlaneGeometry(0.19, 0.03),
    new MeshBasicMaterial({ map: tex, transparent: true }),
  );
  plane.rotation.x = -0.5;
  plane.position.y = 0.045;
  group.add(plane);
  return group;
}

/**
 * Create the visual for one staged part: a holder group (already scaled and
 * named) containing the fallback now and the CAD model when/if it loads.
 * Children named `PartLabel` survive the CAD swap.
 */
export function createPartVisual(
  kind: string,
  annotationLabel?: string,
  size: number = PART_VISUAL_SIZE,
): Group {
  const holder = new Group();
  holder.name = `PartVisual:${kind}`;
  if (ANNOTATION_KINDS.has(kind)) {
    holder.add(annotationVisual(kind, annotationLabel ?? kind));
    holder.userData.baseScale = 1;
    return holder;
  }
  holder.add(fallbackVisual(kind));
  holder.scale.setScalar(size);
  holder.userData.baseScale = size;
  void cad.sceneFor(kind).then((model) => {
    if (model === null || holder.parent === null) {
      return;
    }
    for (const child of [...holder.children]) {
      if (child.name !== 'PartLabel') holder.remove(child);
    }
    model.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh === true) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      }
    });
    holder.add(model);
  });
  return holder;
}

/** Terminal anchors from the real PCB footprint (shared with inventory). */
export function cadTerminalAnchors(kind: string) {
  return cad.terminalAnchors(kind);
}
