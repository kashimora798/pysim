# Plan: real CAD models, PCB footprints, and interaction physics for the bench

Researched and partially implemented 2026-10-20. This plan covers the three libraries
the project was asked to evaluate — **Rapier**, **Component Search Engine**, and
**cannon.js** — plus the wider free-CAD ecosystem, and turns them into a faster,
better-looking, still-free bench.

**Status markers:** ✅ done in this change · 🔜 planned · 🚫 rejected with reason.

---

## 1. The verdict up front

| Ask | Verdict |
|---|---|
| Pull 3D models from Component Search Engine's database at runtime via API | 🚫 **Impossible as imagined** — there is no public API that returns model files; downloads are account-gated behind their Library Loader, and the terms do not clearly permit redistributing models inside a web app. The *workflow* (search a huge real-parts database, get STEP + footprint) is still valuable — as an offline, human-in-the-loop sourcing step (§4). |
| Use free CAD libraries with real models + PCB footprints | ✅ **KiCad official libraries** — STEP 3D models *and* matched footprints, CC BY-SA 4.0 with an exception, on GitHub. Pipeline built and four real components are in the bench now (§3). |
| Rapier for physics | ✅ **Adopt, interaction-only** — Apache-2.0, actively maintained, deterministic, WASM inlined in the `-compat` package. Spike verified (raycast, overlap, determinism). It must never integrate a verified trajectory (§5). |
| cannon.js (schteppe) | 🚫 **Dead since 2016** (last commit May 2016). Its fork cannon-es is stale (npm latest 0.20.0, 2022) and slower. Do not adopt; if a pure-JS engine is ever needed for a non-XR fallback, cannon-es is the only sane form of it. |
| PCB footprints | ✅ **Already paying off** — KiCad footprint pads are parsed at import and shipped as terminal anchors in the manifest (§3). Full PCB bench mode is Phase 3 (§6). |

One discovery that changes the physics-engine calculus: **IWSDK already ships a
physics engine** — `@iwsdk/core` depends on `@babylonjs/havok` (Havok WASM) for its
grab interaction. So the bench never *lacked* interaction physics; it lacks
*placement/probe queries*, which is a much smaller need (§5).

---

## 2. Where we started (audit)

- The kernel already names a model per component (`model3d: resistor.glb`, … in the KB),
  but no GLB files existed: `inventory.ts` rendered **proxy primitives** (cylinders,
  spheres, slabs) chosen by tag/model heuristics. Correct, fast, ugly.
- Terminals for wiring are fixed offsets in `terminals.ts`; nothing knew a real part's
  pin geometry.
- No STEP/GLB loading anywhere; `three` (super-three 0.181) ships `GLTFLoader` in
  examples, unused.
- `@dimforge/rapier3d-compat@0.12.0` was already in `node_modules` (transitively, via
  `@types/three`), untried.

---

## 3. ✅ Implemented: the offline CAD pipeline (Phase 1)

Real models cannot be fetched in the browser: three.js has no STEP reader (STEP is
BREP/NURBS; tessellating it needs a CAD kernel — OpenCASCADE ≈ 15 MB of WASM via
occt-import-js, which would also blow the Quest's 60 fps budget). So conversion is a
**build step**, and the browser only ever loads small GLBs.

```
KiCad STEP ──cascadio (OpenCASCADE)──▶ GLB ──trimesh──▶ normalized GLB ──▶ web/public/gltf/models/
KiCad .kicad_mod ──regex S-expr parse──▶ pad positions ──same transform──▶ terminal anchors
```

- `tools/cad_sources.json` — the registry: bench kind → STEP file, footprint file,
  real part name, pad→kernel-terminal mapping. Adding a component = adding a row.
- `tools/import_cad.py --kicad3d <checkout> --kicadfp <checkout>` — converts,
  recentres (unit max extent, base at y=0, Z-up→Y-up), parses footprint pads, maps
  them through the *same* transform chain as the mesh, and writes `manifest.json`
  with per-model source, licence, attribution, real size in mm, triangle count.
- Imported now: **resistor** (axial DIN0207, 2,076 tris, 43 KiB), **capacitor**
  (radial electrolytic ⌀8 mm, 2,468 tris, 53 KiB), **lamp** (5 mm LED, 509 tris,
  12 KiB), **battery** (Keystone 2462 2×AA holder, 3,740 tris, 87 KiB). Total
  195 KiB — less than one texture.
- `web/src/ff/models.ts` (`CadModels`) — lazy manifest + GLTFLoader cache;
  `sceneFor(kind)` returns an own-resources clone re-fitted to the unit box;
  `terminalAnchors(kind)` exposes the footprint anchors.
- `inventory.ts` `spawn()` — a part starts as its proxy and swaps to the CAD model
  when it loads; failure leaves the proxy. Palette slots keep proxies on purpose:
  their highlight is a material swap over shared geometry, which real multi-material
  CAD models would break.
- `npm run check:models` (in `npm run check`) — asserts every manifest entry names a
  real kernel kind, carries licence+attribution, is valid GLB under a 256 KiB
  budget, and has ≥2 wired terminals **inside the unit box** (anchor/mesh alignment
  is testable, not hoped for).

Licence posture is recorded in `docs/licences.md`. KiCad's exception means *designs*
made with the data are unrestricted; redistributing the (converted) library data
keeps CC BY-SA 4.0 + attribution, which the manifest carries per model.

### Remaining Phase-1 work 🔜
- Import the rest of the placeable kinds: ammeter/voltmeter (KiCad has no meter
  bodies — source from SnapMagic under CC BY-SA + Design Exception, or model
  parametrically), field probe, ruler, stopwatch, charged sphere/shell/plates
  (these are physics idealizations, not products: keep proxies or generate
  parametric GLBs from kernel geometry — the kernel knows the radii).
- Meshopt compression (`gltfpack`) + a triangle budget per kind enforced in
  `check:models`; KTX2 textures if textured parts arrive.
- Wire `terminalAnchors()` into `terminals.ts` so wiring snaps to the real pads
  (resistor pads land at x = ±0.4721 in unit space — verified by check).

---

## 4. Component Search Engine & friends: the sourcing playbook

Researched 2026-10-20:

| Source | What it has | Access | Licence for our use | Plan |
|---|---|---|---|---|
| **KiCad libraries** | ~10k STEP+WRL models, matched footprints/symbols | git (GitHub/GitLab) | CC BY-SA 4.0 + exception | ✅ Primary (§3) |
| **Component Search Engine (SamacSys/Supplyframe)** | Millions of manufacturer parts: symbol, footprint, STEP | Free account + Library Loader app; **no public file API** (community importers confirm downloads are manual ZIPs) | Terms don't clearly grant redistribution in a web app | 🔜 Manual sourcing only: a human downloads a specific part ZIP, checks terms, converts via `import_cad.py` layout (STEP→GLB), registers provenance. Never scrape, never hot-link, never runtime-fetch |
| **SnapEDA / SnapMagic** | Large symbol/footprint/3D library, KiCad-format downloads | Web download (account) | CC BY-SA 4.0 + Design Exception 1.0 | 🔜 Second source, same share-alike handling as KiCad |
| **Ultra Librarian** | Manufacturer-verified models | Paid API | Commercial licence needed | 🚫 unless funded |
| **GrabCAD** | Huge community CAD | Web | **Non-commercial internal use only** | 🚫 excluded (docs/licences.md) |
| **TraceParts / 3DContentCentral / PARTcommunity** | Manufacturer CAD portals | Portal download | No redistribution | 🚫 for shipping; OK as a modelling reference |
| **McMaster-Carr** | Per-part STEP downloads | Web, no API | Internal use | 🚫 for shipping |

In short: "our model just needs to search their database and show them" is not a
thing any of these licences/APIs allow at runtime. The achievable version — and the
one implemented — is: **search offline, convert offline, ship small GLBs with
provenance**. The search step can still be CSE/SnapMagic; the shipping step is ours.

---

## 5. Physics engines: Rapier vs cannon.js vs what we already have

### The law that constrains everything
From `docs/architecture.md`, unchanged: *the kernel computes the trajectory; the
renderer only applies transforms.* Engine C's RK4 trajectories are verified against
Engine A's algebra and the corpus's known answers. A game engine stepping a charged
particle would produce plausible-but-unverified motion and silently void the product's
one claim. **No general physics engine integrates physics content. Ever.**

### What a physics engine *is* wanted for
1. **Placement validation** — "would this part intersect that one / is it on the desk?"
   (overlap queries at spawn and on drop).
2. **Hand-as-probe queries** — "what does the fingertip touch first?" (raycasts,
   already done crudely by IWSDK handles).
3. **Prop life** — parts shouldn't interpenetrate when knocked; a dropped resistor
   should land on the desk, not fall through it. (Kinematic-to-dynamic handoff on
   release is the classic pattern.)
4. **Deterministic replay** — if prop motion is ever recorded for a lesson, it must
   replay bit-identically. Rapier offers cross-platform determinism; cannon-es
   explicitly does not.

### Evaluation
| Engine | State | Perf | Determinism | Licence | Verdict |
|---|---|---|---|---|---|
| **Rapier** (`@dimforge/rapier3d-compat`) | Actively maintained (Dimforge), Rust→WASM, SIMD builds | Fastest in class | ✅ opt-in cross-platform | Apache-2.0 | ✅ **Adopt for interaction** (queries first) |
| cannon.js (schteppe) | **Unmaintained since 2016** | Slow (three.js forum consensus) | ✗ | MIT | 🚫 |
| cannon-es (pmndrs fork) | Stale (2022), minor fixes only | Slow–OK for ~100 bodies | ✗ | MIT | 🚫 unless a no-WASM fallback is required |
| Havok (`@babylonjs/havok`, via IWSDK) | Maintained; **already loaded** for IWSDK grabbing | Fast | ✗ | Apache-2.0 (Babylon) | 🔜 Prefer for grab-coupled dynamics if it suffices — zero new WASM |

### Plan
- ✅ **Step 0 (done):** pinned `@dimforge/rapier3d-compat@~0.12.0` as a direct
  dependency; `npm run spike:rapier` proves WASM init, placement raycast (hits a prop
  top at exactly y=0.055), sensor overlap, and bit-identical stepping in our
  toolchain. It touches no runtime code.
- 🔜 **Step 1 — queries only:** a `ff/interaction-physics.ts` Rapier world mirroring
  the bench (static desk collider, one cuboid/sphere collider per part from its
  manifest size), used at spawn/drop for overlap rejection and probe raycasts.
  Colliders come from CAD bounding boxes — another reason the manifest carries real
  sizes. No `world.step()` dynamics for parts; queries read a stepped-once pipeline.
- 🔜 **Step 2 — prop dynamics (optional, gated):** dynamic bodies only while a part
  is *not* held and *not* part of a staged problem; the moment a problem stages, all
  bodies go kinematic and the kernel owns every transform again. Compare against
  IWSDK/Havok handles first; adopt Rapier here only if Havok can't express it.
- 🚫 **Never:** particle trajectories, field motion, anything with a verified answer.

Budget note: rapier3d-compat inlines its WASM (~2 MB) into the JS bundle. On Quest
that is a real cost; Step 1 must lazy-load it (`import()` on first bench interaction)
and the build must report the delta. If that proves too heavy, Step 1 falls back to
Havok queries via IWSDK and Rapier stays a dev/spike tool.

---

## 6. PCB footprints: from anchors to a PCB bench mode

Already shipped: footprint pads → terminal anchors (§3). The PCB section the user
asked for, in order:

1. 🔜 **Terminal snapping from pads** (Phase 2): `terminals.ts` prefers manifest
   anchors (real 10.16 mm pitch on the resistor) over fixed offsets; check-models
   already guards anchor sanity.
2. 🔜 **PCB board mode** (Phase 3): render a board (rounded-rect slab, solder-mask
   green) under the parts; pads drawn as copper discs at the footprint positions;
   when a problem is a circuit, the kernel's circuit graph draws **traces** between
   connected pads (the Scene relations already know the topology — a trace is just a
   relation rendered flat). This makes the bench read as a real PCB for circuits
   problems while staying a field bench for electrostatics.
3. 🔜 **Footprint-first authoring**: a new component enters the KB with its KiCad
   footprint name; `import_cad.py` derives model + anchors automatically. The KB's
   `model3d` field becomes the fallback hint it already is, not the source of truth.

---

## 7. Performance plan (faster, and free)

- **Asset weight:** all four CAD models total 195 KiB. Budgets enforced in CI
  (256 KiB/model). 🔜 gltfpack (meshopt) typically cuts GLB 5–10×; decode is
  built into three via MeshoptDecoder (already a three dependency).
- **Draw calls:** palette = proxies (shared geometry/materials, unchanged). Spawned
  parts ≤ ~10 on a bench; CAD models are 500–3.7k tris each — trivial for Quest.
  🔜 If a scene ever stages >50 parts, switch to InstancedMesh per kind.
- **No runtime CAD kernel, no runtime model APIs, no CDN dependency** — everything
  ships as static files next to the specs; the bench still works fully offline and
 with the AI unplugged, per the standing rule.
- **Rapier lazy-load** (§5) keeps the initial bundle at today's size.

## 8. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Share-alike obligations on converted models | Per-model licence+attribution in manifest, enforced by check:models; models kept in a clearly-licensed directory |
| A future imported model misaligns pads↔mesh | Both ride one transform chain in import_cad.py; check:models asserts anchors inside the unit box; add a golden-render screenshot test on Quest |
| CSE/SnapMagic terms change or a part's provenance is unclear | Registry requires source+licence per row; unclear ⇒ not imported |
| Rapier bundle weight on Quest | Lazy import, build-size report, Havok fallback |
| Physics engine creeps into verified motion | Architecture law (§5); spike script header states it; code review checklist |

## Sources
- Rapier: https://rapier.rs/ · npm `@dimforge/rapier3d-compat`
- cannon.js (unmaintained): https://github.com/schteppe/cannon.js/ (last commit 2016);
  fork: https://github.com/pmndrs/cannon-es
- Component Search Engine: https://componentsearchengine.com/ and
  https://componentsearchengine.com/learn-more (free account downloads, Library
  Loader; no file API)
- KiCad libraries & licence: https://github.com/KiCad/kicad-packages3D,
  https://github.com/KiCad/kicad-footprints, https://www.kicad.org/libraries/license/
- SnapMagic licence FAQ: https://www.snapeda.com/about/FAQ/
- STEP→GLB: https://github.com/trimesh/cascadio (OpenCASCADE); occt-import-js for the
  in-browser variant we rejected
- three.js physics guidance: https://threejs.org/manual/en/physics.html
