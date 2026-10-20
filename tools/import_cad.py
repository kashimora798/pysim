#!/usr/bin/env python3
"""Import real CAD models into the bench: STEP -> normalized GLB + footprint pads.

This is an OFFLINE build tool, never a runtime dependency (the plan, and why, is in
docs/3d-asset-pipeline-plan.md). It exists because three.js cannot read STEP: the CAD
kernel work (OpenCASCADE tessellation) happens once here, and the web app only ever
loads the resulting small GLB files.

For each entry in tools/cad_sources.json it:

1. converts the KiCad STEP model to GLB with cascadio (OpenCASCADE),
2. recentres/scales it with trimesh to a unit footprint with its base at y=0, so the
   bench can drop it into the same PART_SIZE box the proxy shapes use,
3. parses the matching KiCad footprint (.kicad_mod) for pad positions and maps them
   through the same normalization, so every model carries *real terminal anchors*
   derived from its PCB footprint -- the data the wiring system snaps to,
4. writes web/public/gltf/models/<kind>.glb and a manifest.json recording source,
   licence and attribution for every model (CC BY-SA 4.0, KiCad exception).

Usage:
    .venv/bin/python tools/import_cad.py --kicad3d /path/to/kicad-packages3D \
                                         --kicadfp /path/to/kicad-footprints
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "web" / "public" / "gltf" / "models"


def parse_footprint_pads(text: str) -> list[dict]:
    """Pull (pad number, x, y, w, h) out of a .kicad_mod S-expression, in mm.

    KiCad board coordinates: x right, y *down* when viewed from the front. The bench
    is three.js (x right, z toward viewer), so a footprint point (x, y) lands on the
    bench at (x, -y) in (x, z). We keep that mapping explicit here, once.
    """
    pads = []
    for m in re.finditer(r'\(pad\s+"?([\w]+)"?\s+\w+\s+\w+.*?\(at\s+([-\d.]+)\s+([-\d.]+)(?:\s+[-\d.]+)?\)\s*\(size\s+([-\d.]+)\s+([-\d.]+)\)', text, re.S):
        pads.append({
            "n": m.group(1),
            "x_mm": float(m.group(2)),
            "y_mm": float(m.group(3)),
            "w_mm": float(m.group(4)),
            "h_mm": float(m.group(5)),
        })
    return pads


def convert(step: Path, kind: str) -> dict:
    import cascadio
    import trimesh

    raw = OUT_DIR / f".{kind}.raw.glb"
    cascadio.step_to_glb(str(step), str(raw), tol_linear=0.05, tol_angular=0.5)
    scene = trimesh.load(raw)
    raw.unlink()
    geometry = scene.to_geometry()
    tris = int(len(geometry.faces))

    # cascadio emits metres with the STEP axes preserved (KiCad models are Z-up).
    size_mm = [round(float(s) * 1000, 2) for s in geometry.extents]
    # Rotate -90 deg about X: (x, y, z) -> (x, z, -y), so STEP's Z becomes three.js Y.
    # The returned transform (rotation, centre, scale) is applied to footprint pads
    # too -- one transform chain, so anchors can never drift from the mesh.
    rot = trimesh.transformations.rotation_matrix(-np.pi / 2, [1, 0, 0])
    geometry.apply_transform(rot)
    bounds = geometry.bounds
    center = (bounds[0] + bounds[1]) / 2.0
    scale = 1.0 / float(max(bounds[1] - bounds[0]))
    geometry.apply_translation([-center[0], -bounds[0][1], -center[2]])
    geometry.apply_scale(scale)

    out = OUT_DIR / f"{kind}.glb"
    trimesh.Scene(geometry).export(out)
    return {"size_mm": size_mm, "triangles": tris, "bytes": out.stat().st_size,
            "_pad_transform": {"rot": rot, "center": center, "scale": scale}}


def map_pad(pad: dict, tf: dict) -> list[float]:
    """Footprint pad (mm, KiCad board coords) -> normalized bench (x, z)."""
    point = np.array([pad["x_mm"] / 1000.0, pad["y_mm"] / 1000.0, 0.0, 1.0])
    rotated = tf["rot"] @ point
    centred = rotated[:3] - np.array([tf["center"][0], 0.0, tf["center"][2]])
    scaled = centred * tf["scale"]
    return [round(float(scaled[0]), 4), round(float(scaled[2]), 4)]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--kicad3d", required=True, help="checkout of KiCad/kicad-packages3D")
    ap.add_argument("--kicadfp", required=True, help="checkout of KiCad/kicad-footprints")
    args = ap.parse_args()

    registry = json.loads((ROOT / "tools" / "cad_sources.json").read_text())
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest: dict = {"library": registry["library"], "models": {}}

    for entry in registry["models"]:
        kind = entry["kind"]
        step = Path(args.kicad3d) / entry["step"]
        fp = Path(args.kicadfp) / entry["footprint"]
        if not step.exists() or not fp.exists():
            print(f"!! {kind}: missing {step if not step.exists() else fp}", file=sys.stderr)
            return 1
        info = convert(step, kind)
        tf = info.pop("_pad_transform")
        pads_raw = parse_footprint_pads(fp.read_text())
        # Footprint origin == STEP model origin in KiCad libraries, so pads ride the
        # exact transform chain the mesh got. Anchors land on the rendered model.
        pads = []
        for p in pads_raw:
            pads.append({
                "pad": p["n"],
                "terminal": entry["terminals"].get(p["n"]),
                "pos": map_pad(p, tf),
            })
        manifest["models"][kind] = {
            "glb": f"gltf/models/{kind}.glb",
            "part": entry["part"],
            "source_step": entry["step"],
            "source_footprint": entry["footprint"],
            "license": registry["library"]["license"],
            "attribution": "3D model from the KiCad official libraries (kicad-packages3D), CC BY-SA 4.0 with the KiCad libraries exception; converted from STEP for web rendering.",
            **info,
            "pads": pads,
        }
        print(f"ok {kind}: {info['triangles']} tris, {info['bytes'] // 1024} KiB, "
              f"{info['size_mm']} mm, pads={[(p['pad'], p['pos']) for p in pads]}")

    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"manifest -> {OUT_DIR / 'manifest.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
