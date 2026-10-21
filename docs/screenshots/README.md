# Screenshots — the engine running, end to end

## After the 3D overhaul (Oct 21, 2026) — files 10–15

Same flows, re-shot after Phases 0–1 of the overhaul plan:

- `11/12` — Guided p101 now stages the **real KiCad CAD models** (black Keystone battery holder, tan axial resistor with leads) on a wooden bench with a green anti-static mat, lit by a key/fill/rim rig with shadows; the in-glasses guide panel sits to the right, trust card to the left, and panel text is clean (no emoji tofu boxes).
- `13` — Auto p101 reaches 3 A with the same real parts; `circuit_loop` and `environment` are floating annotations, not props.
- `14` — Auto p002: bench-sized field arrows around the glowing charge sphere and probe.
- `15` — Free bench in the lab.
- The lab backdrop is the toolkit environment (IBL "room" + a project-generated CC0 lab dome, `web/public/env/lab.jpg`) — on a Quest in passthrough the toolkit hides the dome and your real room shows instead.

What changed to get here: the CAD converter keeps materials + normals (check-models now enforces both), one part-visual factory (`ff/partvisual.ts`) serves palette and lessons, placeholders are gone, and the bench got lights + environment. Details in git history (Oct 21 commits).

Captured 2026-10-20 from the real app (`vite` dev server, headless Chromium with
SwiftShader WebGL2 — the same code path that ships to the Quest browser; the
desktop companion HUD mirrors the exact same state). Nothing here is staged:
each frame is the app after actually running the flow it shows.

| File | What it proves |
|---|---|
| `01-desktop-bench-loaded.png` | App boots on the verified bundle: "56 properties · 37 golden problems · dimensions checked ✓", the 3D bench, guide panel and trust card live. |
| `02-auto-p101-verified-answer.png` | Auto mode self-assembles the circuit on the bench (battery, resistor, loop, wire) and lands on the kernel-verified answer **3 A** — "Paths found: 1 · dimensions ✓ · paths agree ✓". |
| `03-auto-p002-electric-field.png` | Point-charge problem: instanced field arrows radiate from the charge, the hand probe readout is kernel-resolved (E = 1.999e+4 V/m), answer **199723 V/m**. |
| `04-guided-mode-task.png` | Guided mode, step 1/10: "Place the battery" — hands-first instructions on the in-glasses panel, step pips, desktop verify bridge visible. |
| `09-guided-step-verified.png` | Guided progression verified step-by-step to step 4/10 ("Wire the battery to the resistor"), placed parts and the drawn wire visible on the bench. |
| `05-free-bench.png` | Free bench: no problem file — the live solver answers from the wire graph ("No battery on the bench — every loop needs a source"). |
| `06-capture-ocr-questions.png` | A photo of a textbook page run through **local** Tesseract OCR (no upload): text lands editable and splits into Q1/Q2/Q3 chips. |
| `07-capture-confirm-solve.png` | Picking a question only ever *proposes*: "Solve this question?" with explicit Solve / Pick another. |
| `08-capture-matched-guided-build.png` | Confirm → corpus match (p101, 80%) with **no AI** → the kernel-verified problem loaded as a fresh guided build at step 1/10. |

## Bugs these screenshots caught (all fixed)

1. **Guided mode never started** — `setMode('guided')` never called
   `startGuide()`, so pressing Next instantly "completed" an empty guide.
2. **Guided hand-verification never ran** — `checkGuide()` existed but was
   never called from the update loop; wired it in.
3. **Browser OCR always failed** — tesseract.js v7 requests
   `tesseract-core-relaxedsimd-lstm.wasm.js` first; only the SIMD/plain cores
   were shipped, and the SPA fallback masked the 404 as HTML. All three LSTM
   cores now ship in `web/public/ocr/`.
4. **Runtime crash on load** — a leftover "TEMP TYPE PROBE"
   (`declare const _g` + `void _g`) in `inventory.ts` threw
   `_g is not defined` and stopped the app mounting. Removed.

Verification alongside: `pytest` 97 passed · `npm run check`
(typecheck + kernel cross-verify + experience/model/capture checks) green ·
`vite build` green with the OCR assets in `dist/ocr/`.

Known sandbox-only artefact: the dev emulator's `living_room` environment is
fetched from a CDN that this sandbox cannot reach, so the room backdrop is the
plain dark void in these frames. On a Quest (or any networked desktop) the
environment loads normally; the bench, panels and physics are unaffected.
