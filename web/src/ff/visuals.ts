/**
 * How a part looks on the bench.
 *
 * Real electronic parts (battery holder, resistor, capacitor, LED) come from the KiCad CAD
 * models (`models.ts`). Everything else the kernel knows about is an *idealised physics object*
 * (a point charge, a pair of plates, a conducting shell, a field region), and has no catalogue
 * part number to import. Those are built here, parametrically and lit, so the bench never shows
 * a grey placeholder box.
 *
 * Abstract kinds (the circuit loop, the environment, series and parallel pairs) are ideas, not
 * objects. They get no body at all: only a small floating label.
 *
 * Pure construction, no ECS and no kernel access. Sizes are metres, bases sit on y = 0.
 */

import {
  BoxGeometry,
  CanvasTexture,
  CatmullRomCurve3,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector3,
  type Object3D,
} from '@iwsdk/core';

import { LAB_PALETTE, canvasTexture, castShadows, stripPictographs } from './lab.js';

/** Kinds that are ideas rather than objects: no body, label only. */
export const ABSTRACT_KINDS: ReadonlySet<string> = new Set([
  'environment',
  'circuit_loop',
  'series_pair',
  'parallel_pair',
]);

/** Longest dimension of each CAD model on the bench, in metres. */
export const CAD_SIZE: Readonly<Record<string, number>> = {
  battery: 0.17,
  resistor: 0.15,
  capacitor: 0.1,
  lamp: 0.11,
};

/** Accent colour per kind, used for dots on labels and tints on idealised objects. */
export const KIND_ACCENT: Readonly<Record<string, number>> = {
  battery: 0xf5a524,
  resistor: 0xd9a066,
  lamp: 0xfde68a,
  capacitor: 0x2563eb,
  point_charge: 0xfb7185,
  charged_particle: 0xa78bfa,
  electron: 0x60a5fa,
  field_probe: 0xe2e8f0,
  parallel_plate_capacitor: 0x94a3b8,
  uniform_charged_sphere: 0xf472b6,
  conducting_shell: 0x9ca3af,
  infinite_charged_plane: 0x64748b,
  spherical_cavity_in_charged_sphere: 0xec4899,
  uniform_magnetic_field_region: 0x818cf8,
  circuit_loop: 0x34d399,
};

const accentOf = (kind: string): number => KIND_ACCENT[kind] ?? 0x94a3b8;

const glossy = (color: number, emissive = 0.0): MeshPhysicalMaterial =>
  new MeshPhysicalMaterial({
    color,
    roughness: 0.28,
    metalness: 0.05,
    clearcoat: 0.9,
    clearcoatRoughness: 0.2,
    emissive: color,
    emissiveIntensity: emissive,
  });

const glass = (color: number, opacity: number): MeshStandardMaterial =>
  new MeshStandardMaterial({
    color,
    roughness: 0.15,
    metalness: 0.1,
    transparent: true,
    opacity,
    side: DoubleSide,
    depthWrite: false,
  });

/** A charge-like sphere sitting on y = 0, with a faint halo so a charge reads as an active thing. */
function chargeBody(kind: string): Object3D {
  const r = kind === 'electron' ? 0.009 : 0.018;
  const color = accentOf(kind);
  const group = new Group();
  const core = new Mesh(new SphereGeometry(r, 28, 18), glossy(color, 0.45));
  core.position.y = r;
  const halo = new Mesh(
    new SphereGeometry(r * 2.0, 20, 14),
    new MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }),
  );
  halo.position.y = r;
  group.add(core, halo);
  return group;
}

function magneticRegion(): Object3D {
  const tex = canvasTexture(256, 192, (ctx, w, h) => {
    ctx.fillStyle = 'rgba(99,102,241,0.22)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(165,180,252,0.95)';
    ctx.lineWidth = 3;
    const step = 32;
    for (let x = step / 2; x < w; x += step) {
      for (let y = step / 2; y < h; y += step) {
        ctx.beginPath();
        ctx.moveTo(x - 7, y - 7);
        ctx.lineTo(x + 7, y + 7);
        ctx.moveTo(x + 7, y - 7);
        ctx.lineTo(x - 7, y + 7);
        ctx.stroke();
      }
    }
    ctx.strokeStyle = 'rgba(165,180,252,0.9)';
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, w - 6, h - 6);
  });
  tex.wrapS = RepeatWrapping;
  const pad = new Mesh(
    new PlaneGeometry(0.2, 0.15),
    new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  pad.rotation.x = -Math.PI / 2;
  pad.position.y = 0.002;
  return pad;
}

/**
 * A body for a kind with no CAD model. The caller treats the result as the part itself and scales
 * and shadows nothing further; `castShadows` is applied here.
 */
export function buildPartVisual(kind: string): Object3D | null {
  if (ABSTRACT_KINDS.has(kind)) return null;
  const color = accentOf(kind);
  const group = new Group();

  switch (kind) {
    case 'point_charge':
    case 'charged_particle':
    case 'electron':
      group.add(chargeBody(kind));
      break;

    case 'field_probe': {
      const tip = new Mesh(new ConeGeometry(0.006, 0.03, 16), new MeshStandardMaterial({ color: 0xd8dee3, roughness: 0.25, metalness: 0.9 }));
      tip.rotation.x = Math.PI; // point down at the bench
      tip.position.y = 0.015;
      const body = new Mesh(new CylinderGeometry(0.008, 0.01, 0.07, 18), new MeshStandardMaterial({ color: 0x20262b, roughness: 0.5, metalness: 0.2 }));
      body.position.y = 0.065;
      const band = new Mesh(new CylinderGeometry(0.0105, 0.0105, 0.008, 18), new MeshStandardMaterial({ color: 0xf5a524, roughness: 0.45 }));
      band.position.y = 0.045;
      group.add(tip, body, band);
      break;
    }

    case 'parallel_plate_capacitor': {
      const metal = new MeshStandardMaterial({ color: 0xc3ccd4, roughness: 0.32, metalness: 0.95 });
      for (const y of [0.014, 0.054]) {
        const plate = new Mesh(new BoxGeometry(0.13, 0.003, 0.09), metal);
        plate.position.y = y;
        group.add(plate);
      }
      const post = new MeshStandardMaterial({ color: 0xeceff1, roughness: 0.6 });
      for (const [x, z] of [[-0.055, -0.035], [0.055, 0.035]] as const) {
        const standoff = new Mesh(new CylinderGeometry(0.004, 0.004, 0.04, 12), post);
        standoff.position.set(x, 0.034, z);
        group.add(standoff);
      }
      break;
    }

    case 'uniform_charged_sphere': {
      const shell = new Mesh(new SphereGeometry(0.04, 36, 24), glass(color, 0.5));
      shell.position.y = 0.04;
      const core = new Mesh(new SphereGeometry(0.018, 24, 16), glossy(color, 0.5));
      core.position.y = 0.04;
      group.add(shell, core);
      break;
    }

    case 'conducting_shell': {
      const shell = new Mesh(
        new SphereGeometry(0.045, 40, 28),
        new MeshStandardMaterial({ color: 0xcdd5db, roughness: 0.12, metalness: 1, transparent: true, opacity: 0.42, side: DoubleSide, depthWrite: false }),
      );
      shell.position.y = 0.045;
      group.add(shell);
      break;
    }

    case 'spherical_cavity_in_charged_sphere': {
      const outer = new Mesh(new SphereGeometry(0.045, 36, 24), glass(color, 0.45));
      outer.position.y = 0.045;
      const cavity = new Mesh(new SphereGeometry(0.02, 24, 16), new MeshStandardMaterial({ color: 0x121a1f, roughness: 0.9 }));
      cavity.position.set(0.012, 0.045, 0);
      group.add(outer, cavity);
      break;
    }

    case 'infinite_charged_plane': {
      const slab = new Mesh(new BoxGeometry(0.22, 0.003, 0.15), glass(0x7c8ea6, 0.7));
      slab.position.y = 0.002;
      const edge = new Mesh(new BoxGeometry(0.22, 0.006, 0.004), new MeshStandardMaterial({ color: 0xcfd8e3, roughness: 0.3, metalness: 0.8 }));
      edge.position.set(0, 0.003, 0.075);
      group.add(slab, edge);
      break;
    }

    case 'uniform_magnetic_field_region':
      group.add(magneticRegion());
      break;

    default: {
      // A kind with no dedicated look: a small instrument-style module in the kind's tint.
      const body = new Mesh(new BoxGeometry(0.06, 0.03, 0.045), glossy(color, 0.08));
      body.position.y = 0.015;
      group.add(body);
    }
  }

  castShadows(group, true);
  return group;
}

// --------------------------------------------------------------------------- labels

/** A name tag: kind-coloured dot, instance id in mono, label in sans. Billboarded by the caller. */
export function makeLabel(id: string, label: string, kind: string): Mesh {
  const dot = `#${accentOf(kind).toString(16).padStart(6, '0')}`;
  const tex: CanvasTexture = canvasTexture(512, 112, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(11,22,27,0.88)';
    ctx.beginPath();
    ctx.roundRect(4, 4, w - 8, h - 8, 28);
    ctx.fill();
    ctx.strokeStyle = 'rgba(45,212,191,0.35)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = dot;
    ctx.beginPath();
    ctx.arc(40, h / 2, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.textBaseline = 'middle';
    ctx.font = '600 38px ui-monospace,Menlo,Consolas,monospace';
    ctx.fillStyle = LAB_PALETTE.teal;
    ctx.fillText(id, 72, h / 2 + 1);
    const idWidth = ctx.measureText(id).width;
    ctx.font = '500 36px system-ui,"Segoe UI",sans-serif';
    ctx.fillStyle = '#e8f5f2';
    ctx.fillText(stripPictographs(label).slice(0, 22), 72 + idWidth + 16, h / 2 + 1);
  });
  const mesh = new Mesh(
    new PlaneGeometry(0.17, 0.0371),
    new MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
  );
  mesh.name = 'PartLabel';
  mesh.renderOrder = 10;
  return mesh;
}

/** Turn a label to face a camera, whatever rotation its parents carry. */
const parentQ = new Quaternion();
const cameraQ = new Quaternion();
export function faceCamera(label: Object3D, camera: Object3D): void {
  const parent = label.parent;
  if (parent == null) return;
  parent.getWorldQuaternion(parentQ).invert();
  camera.getWorldQuaternion(cameraQ);
  label.quaternion.copy(parentQ).multiply(cameraQ);
}

// --------------------------------------------------------------------------- wires

/** An insulated lead between two points, drooping a little the way a real wire does. */
export function makeWire(a: Vector3, b: Vector3, color = 0xd9622b): Mesh {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mid.y += 0.022 + a.distanceTo(b) * 0.06;
  const curve = new CatmullRomCurve3([a, mid, b]);
  const wire = new Mesh(
    new TubeGeometry(curve, 28, 0.0022, 10, false),
    new MeshStandardMaterial({ color, roughness: 0.45, metalness: 0.1 }),
  );
  wire.castShadow = true;
  wire.name = 'Lead';
  return wire;
}

/** A lead that also returns its centre curve, so charge carriers can be placed along it. */
export function makeLead(a: Vector3, b: Vector3, color = 0xd9622b): { mesh: Mesh; curve: CatmullRomCurve3 } {
  const mid = a.clone().add(b).multiplyScalar(0.5);
  mid.y += 0.018 + a.distanceTo(b) * 0.1;
  const curve = new CatmullRomCurve3([a.clone(), mid, b.clone()]);
  const mesh = new Mesh(
    new TubeGeometry(curve, 32, 0.0024, 10, false),
    new MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.15 }),
  );
  mesh.castShadow = true;
  mesh.name = 'Lead';
  return { mesh, curve };
}

const UP = new Vector3(0, 1, 0);
const dirScratch = new Vector3();

/** A lit arrow for a vector (velocity, acceleration). Direction and length are set per frame. */
export class VectorArrow extends Group {
  private readonly shaft: Mesh;
  private readonly head: Mesh;

  constructor(color: number) {
    super();
    const material = new MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.1, emissive: color, emissiveIntensity: 0.45 });
    this.shaft = new Mesh(new CylinderGeometry(0.0022, 0.0022, 1, 10), material);
    this.head = new Mesh(new ConeGeometry(0.0065, 0.016, 14), material);
    this.add(this.shaft, this.head);
    this.visible = false;
  }

  /** Point from `origin` along `dir` (any length) for `length` metres; hides itself when degenerate. */
  set(origin: Vector3, dir: Vector3, length: number): void {
    this.visible = length > 1e-4 && dir.lengthSq() > 1e-18;
    if (!this.visible) return;
    const headLength = 0.016;
    const shaftLength = Math.max(0.001, length - headLength);
    this.position.copy(origin);
    this.quaternion.setFromUnitVectors(UP, dirScratch.copy(dir).normalize());
    this.shaft.scale.y = shaftLength;
    this.shaft.position.y = shaftLength / 2;
    this.head.position.y = shaftLength + headLength / 2;
  }
}

/** A faint ring lying on the mat, for the "closed loop" idea. A hint, not a prop. */
export function makeLoopHint(): Mesh {
  const ring = new Mesh(
    new TorusGeometry(0.03, 0.0016, 8, 48),
    new MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.55, toneMapped: false }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.003;
  return ring;
}
