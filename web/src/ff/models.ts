/**
 * Real CAD models for bench parts, with the proxy shapes as the fallback.
 *
 * The models are genuine electronic components (an axial resistor, a radial
 * electrolytic capacitor, a 5 mm LED, an AA battery holder) from the KiCad official
 * libraries, converted from STEP to GLB offline by `tools/import_cad.py` -- see
 * `docs/3d-asset-pipeline-plan.md` for why the conversion is a build step and never
 * happens in the browser, and `gltf/models/manifest.json` for the licence and
 * attribution of every file.
 *
 * Loading is progressive enhancement, by design:
 *
 *   - the palette keeps the built-in proxy shapes (a highlight there is a material
 *     swap over shared geometry; real models would break both),
 *   - a spawned part starts as its proxy and swaps to the CAD model when it arrives,
 *   - if the manifest or a model fails to load (offline, older bundle), the proxy
 *     simply stays. The bench never depends on these files existing.
 *
 * Each model is normalized at import time to a unit maximum extent with its base at
 * y=0, so it drops into the same PART_SIZE box the proxies use. The manifest also
 * carries terminal anchors mapped from the component's real PCB footprint pads,
 * through the exact transform chain the mesh went through.
 */

import { Box3, Group, Mesh, Vector3, type Object3D } from '@iwsdk/core';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface CadPad {
  pad: string;
  /** Kernel terminal relation kind this pad is, when the registry maps it. */
  terminal: string | null;
  /** Normalized bench units: [x, z], base plane. Multiply by the part's scale. */
  pos: [number, number];
}

export interface CadModelEntry {
  glb: string;
  part: string;
  license: string;
  attribution: string;
  size_mm: [number, number, number];
  triangles: number;
  pads: CadPad[];
}

interface CadManifest {
  models: Record<string, CadModelEntry>;
}

const base = (): string => {
  const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  return b.endsWith('/') ? b : `${b}/`;
};

export class CadModels {
  private manifestPromise: Promise<CadManifest | null> | null = null;
  private templates = new Map<string, Promise<Object3D | null>>();
  private loader = new GLTFLoader();

  private manifest(): Promise<CadManifest | null> {
    this.manifestPromise ??= fetch(`${base()}gltf/models/manifest.json`)
      .then((res) => (res.ok ? (res.json() as Promise<CadManifest>) : null))
      .catch(() => null);
    return this.manifestPromise;
  }

  /** Terminal anchors from the real PCB footprint, or [] when no CAD model exists. */
  async terminalAnchors(kind: string): Promise<CadPad[]> {
    const manifest = await this.manifest();
    return manifest?.models[kind]?.pads ?? [];
  }

  /**
   * A fresh, own-resources clone of the CAD model for `kind`, normalized to unit
   * maximum extent on a y=0 base -- or null when this kind has no model, so the
   * caller keeps its proxy. Geometries and materials are cloned per call because a
   * spawned part owns its GPU resources (`entity.dispose()` must not blank siblings).
   */
  async sceneFor(kind: string): Promise<Group | null> {
    let template = this.templates.get(kind);
    if (template === undefined) {
      template = this.loadTemplate(kind);
      this.templates.set(kind, template);
    }
    const scene = await template;
    if (scene === null) {
      return null;
    }
    const clone = scene.clone(true);
    clone.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh === true) {
        mesh.geometry = mesh.geometry.clone();
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => m.clone())
          : mesh.material.clone();
      }
    });
    const group = new Group();
    group.name = `CadModel:${kind}`;
    group.add(clone);
    return group;
  }

  private async loadTemplate(kind: string): Promise<Object3D | null> {
    const manifest = await this.manifest();
    const entry = manifest?.models[kind];
    if (entry === undefined) {
      return null;
    }
    try {
      const gltf = await this.loader.loadAsync(`${base()}${entry.glb}`);
      const scene = gltf.scene;
      // Safety net over the import-time normalization: re-fit to unit extent,
      // centred on (0, 0) with the base at y=0, whatever a future import produced.
      const box = new Box3().setFromObject(scene);
      const size = box.getSize(new Vector3());
      const max = Math.max(size.x, size.y, size.z);
      if (!(max > 0)) {
        return null;
      }
      const centre = box.getCenter(new Vector3());
      scene.position.set(-centre.x, -box.min.y, -centre.z);
      scene.scale.setScalar(1 / max);
      const wrapper = new Group();
      wrapper.add(scene);
      return wrapper;
    } catch {
      return null; // a missing model is a proxy, never an error
    }
  }
}
