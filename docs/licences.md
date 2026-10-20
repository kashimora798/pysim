# Licence posture

**Stance chosen: keep every option open.** FieldForge itself is unlicensed for now, and the
dependency set is restricted to the strictest constraint that forecloses nothing later — so the
project can still go closed-source commercial, permissive open source, or AGPL-with-hosting
without a dependency rewrite.

The rules:

- **Runtime dependencies: permissive only** (BSD / MIT / Apache / ISC / PSF).
- **No GPL code**, in any form, anywhere in the tree.
- **No LGPL code in-process.** An LGPL library may only ever be reached across a process or
  service boundary, and nothing currently needs one.
- **GPL projects may be read and learned from, never copied.**

## Audited runtime and dev dependencies

Taken from installed package metadata on 2026-10-04, not from memory:

| Package | Version | Licence | Role |
|---|---|---|---|
| sympy | 1.14.0 | BSD-3-Clause | symbolic algebra — the kernel's backbone |
| mpmath | 1.3.0 | BSD | sympy's arbitrary-precision dependency |
| PyYAML | 6.0.3 | MIT | knowledge-base authoring format |
| typer | 0.27.2 | MIT | CLI |
| rich | 15.0.0 | MIT | trace and audit rendering |
| markdown-it-py, mdurl | 4.2.0, 0.1.2 | MIT | rich's dependencies |
| Pygments | 2.21.0 | BSD-2-Clause | rich's dependency |
| colorama | 0.4.6 | BSD | rich's Windows dependency |
| shellingham | 1.5.4 | ISC | typer's dependency |
| annotated-doc | 0.0.5 | MIT | typer's dependency |
| pytest, pluggy, iniconfig | 9.1.1, 1.6.0, 2.3.0 | MIT | dev only |
| hypothesis | 6.168.3 | MPL-2.0 | dev only — file-level copyleft, no linking obligation |
| sortedcontainers | 2.4.0 | Apache-2.0 | hypothesis's dependency, dev only |

No GPL or LGPL package is installed. `hypothesis` is the only non-permissive entry; MPL-2.0 is
file-level copyleft with no linking obligation, and it is a test-only dependency that ships in no
artifact.

## Deliberately excluded, and why

| Project | Licence | Why excluded | What we do instead |
|---|---|---|---|
| **lcapy** | LGPL-2.1 | Closest off-the-shelf symbolic circuit analyser, but LGPL cannot be imported in-process under this stance | Not needed for the charged-particle domain. If circuits are added, reach it over a service boundary or write nodal analysis on SymPy directly |
| **CircuitJS1** (`pfalstad/circuitjs1`) | GPL-2.0 | Best animated-current UX in existence | Study the interaction design; write our own renderer |
| **ahkab** | GPL | Readable pure-Python SPICE | Read as a reference implementation only |
| **PySpice** | GPL | Convenient ngspice bindings | If ngspice is wanted as a cross-check oracle, shell out to the `ngspice` binary (BSD-like) rather than link a GPL wrapper |
| **OpenModelica** | OSMC-PL / GPL | The closest architectural ancestor | Read the Modelica *language spec* and the Modelica Standard Library (BSD-3) instead |
| **PhET** | mixed / custom | Pedagogy benchmark | Reference for teaching design only; no code or assets reused |

## Content licensing

This matters more than the code licensing, because the corpus is the asset.

- **OpenStax College Physics 2e / University Physics** — **CC BY**. Reusable with attribution,
  including derivative problems. Every corpus problem and formula citation in the shipped
  knowledge base traces to OpenStax or is marked `definitional` / `geometry`. Attribution is
  carried per-row in the `cite:` field and surfaces in every trace and SimSpec.
- **Physics formulas themselves** are not copyrightable. The *expression* of a problem set is.
  That is why corpus problems are rewritten rather than transcribed, and why the source is named.
- **NCERT / JEE past papers** — copyrighted. Usable as a private internal test set; must not be
  redistributed in the repo or shipped in a product.
- **Benchmarks** (PHYBench, JEEBench, SciBench, OlympiadBench) — evaluation only, to measure
  coverage. Never training data; nothing here trains.

## Re-verification

`docs/licences.md` is generated against reality, not trusted. To re-audit:

```bash
.venv/Scripts/python -c "import importlib.metadata as md; [print(d.metadata['Name'], d.version, d.metadata.get('License-Expression') or [c for c in d.metadata.get_all('Classifier') or [] if c.startswith('License')]) for d in md.distributions()]"
```

Live web search was unavailable while this project was set up, so no licence claim here rests on
a web page. Every row above came from the metadata of the package actually installed in `.venv`.
The *excluded* table is from knowledge and should be re-confirmed from each project's `LICENSE`
file before any of those tools is adopted.

## 3D model licensing (added with the CAD pipeline)

Real component models enter the bench only through `tools/import_cad.py`, and only from
libraries whose terms clearly permit what we do with them (serve the converted GLB from a
public web app). The registry is `tools/cad_sources.json`; every imported model carries its
licence and attribution in `web/public/gltf/models/manifest.json`, and `npm run check:models`
fails the build if either goes missing.

| Library | Licence / terms | Verdict |
|---|---|---|
| **KiCad official libraries** (kicad-packages3D, kicad-footprints) | CC BY-SA 4.0 with the KiCad libraries exception (designs made with the data are unrestricted; redistributing the library data itself keeps BY-SA + attribution) | **Used.** Converted GLBs are redistributed library data in modified form, so they stay CC BY-SA 4.0 with attribution — recorded per model in the manifest |
| **Component Search Engine / SamacSys** | Free account downloads; no public API for asset files; terms do not clearly grant redistribution of models inside a third-party web app | Not imported. Manual-download-only parts may be added later, one by one, after a terms check — never scraped, never hot-linked |
| **SnapEDA / SnapMagic** | CC BY-SA 4.0 with Design Exception 1.0 for files from SnapMagic Search | Candidate second source; same share-alike handling as KiCad would apply |
| **GrabCAD** | Community cross-licence is non-commercial, internal use only | **Excluded** — incompatible with keeping every option open |
| **Ultra Librarian / TraceParts / 3D ContentCentral / PARTcommunity** | Paid API or portal terms without redistribution rights | Excluded unless a licence is negotiated |

Physics engines are covered in `docs/3d-asset-pipeline-plan.md`; the audited position is
that `@dimforge/rapier3d-compat` (Apache-2.0) may be used for interaction queries only,
and no game-physics engine may ever integrate a trajectory the kernel has verified.

## OCR assets (question capture)

| Asset | Licence | Notes |
|---|---|---|
| `tesseract.js`, `tesseract.js-core` (WASM) | Apache-2.0 | Runtime dependency, dynamically imported only when a capture is read; assets copied to `web/public/ocr/` |
| `eng.traineddata` (tessdata_fast) | Apache-2.0 | English OCR data, gzipped, served locally; no photo ever leaves the device |

Capture respects the AI boundary: OCR output is *text*, the extractor may only turn
text into a schema-shaped Scene, and the kernel validator accepts or rejects it.
A corpus match (the common textbook case) uses no AI at all.
