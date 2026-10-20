# FieldForge

A component-based, deterministically-verified physics world.
**Problem in, lawful trace out.**

FieldForge owns a library of physics components (point charges, charged particles, field
regions, plates, spheres), the properties they carry, and the formulas and laws relating those
properties — all stored as interlinked, machine-checked tables. Given a scene and a target
quantity it derives the answer by chaining verified formulas, and emits an ordered **trace**:
every step cites the formula it used, the law behind it, and the source it came from.

The trace is also the storyboard. Derivation order *is* animation order, so there is no separate
animation planner and no frame that isn't backed by a law.

## The one rule

> **AI at the boundary, never in the kernel.**

An LLM may map natural language into a typed `Scene`. The kernel then *rejects or accepts* that
scene by schema, dimension and rank checks, and computes with zero AI. Nothing in `kernel/`
makes a network call or consults a model.

## Status

The compiler and chain resolver (CLI), the verified static export, the TypeScript kernel port,
and the 3D WebXR bench: desk-anchored parts palette, pinch-to-wire, Auto/Guided/Free modes over
24 golden problems, a live solver bridge, kernel-resolved field arrows and a hand-as-probe —
see `docs/xr-experience.md`. Not yet verified on a Quest headset.

Domain: **charged particles and electrostatic fields** — chosen because nothing in the market
occupies generative + lawful + 3D here, and because the `field → qE force → acceleration →
trajectory` chain proves cross-topic resolution on day one.

## Install

```bash
uv venv
uv pip install -e ".[dev]"
```

## Use

```bash
ff audit                           # run the 6 validators over the knowledge base
ff props                           # list the property registry
ff solve corpus/problems/p001.yaml # derive a target, print the cited trace
ff coverage                        # % of the corpus that resolves
```

## Layout

```
kernel/
  dims.py          7-dimensional SI vector algebra
  units.py         "100 V" -> (value, dimension); SI normalisation
  ontology.py      property registry: dimension, rank, kind
  kb.py            components, formulas, laws
  exprs.py         safe expression parsing + dimension/rank inference
  validate.py      the 6 validators
  scene.py         scenes, instances, bindings, relations
  engine_chain.py  Engine A: backward-chaining resolver (multi-path)
  trace.py         trace -> SimSpec JSON
  cli.py           ff
  ontology/        property + constant tables (YAML)
  kb/              component, formula and law tables (YAML)
corpus/problems/   problems with expected answers -- the coverage set
tests/
```

## Licence posture

Permissive dependencies only: BSD / MIT / Apache / PSF. No GPL or LGPL code is imported.
See `docs/licences.md` for the audit and for what was deliberately excluded.
