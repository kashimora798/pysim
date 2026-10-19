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

Milestones M0–M4 of the plan: the compiler and all three engines, as a CLI. No 3D renderer yet.

**Three engines, one knowledge base, cross-checked against each other:**

| engine | what it answers | where |
|---|---|---|
| **A** — chain | algebraic chains: `field → qE → a → v` | `kernel/engine_chain.py` |
| **B** — system | simultaneous systems: two cells in parallel, any scene where no single law isolates an unknown | `kernel/engine_system.py` |
| **C** — ODE | time evolution: a charging capacitor, a trajectory | `kernel/engine_ode.py` |

Plus `kernel/math_tools.py`, the explicit mathematical toolkit — differentiation, integration,
quadrature, gradients, linear and symbolic solving — registered by name and callable by any
engine (`ff math list`). Wherever both A and B reach an answer they must agree to 1e-9, and the
coverage run reports the comparison for every corpus problem.

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
  engine_system.py Engine B: acausal assembly of simultaneous systems
  engine_ode.py    Engine C: time evolution by explicit integration
  math_tools.py    the mathematical toolkit, callable by name
  solve.py         engine selection + cross-checking
  trace.py         trace -> SimSpec JSON
  cli.py           ff
  ontology/        property + constant tables (YAML)
  kb/              component, formula and law tables (YAML)
corpus/problems/   problems with expected answers -- the coverage set (Engines A + B)
corpus/trajectories/  time-evolution problems with closed-form answers (Engine C)
tests/
```

## Live XR bench

Deployed on every push: **https://kashimora798.github.io/pysim/**  
Enable once: GitHub → Settings → Pages → Source: *GitHub Actions*.

Seated, hands-only, no controller ever required. Palm-up shelf → place → pinch-to-wire →
solve → trust card. Desktop fallback via ray + canvas pointer.

`vite.config.ts` uses `base: './'` and `src/physics/kernel.ts` loads `physics/` relative to
`BASE_URL`, so the same bundle works on Pages, Vercel, Netlify, or localhost without
a hardcoded origin.

## Submission

See `docs/SUBMISSION_CHECKLIST.md` (hard deadline Wed 18 Nov 2026 12 pm PST / Thu 19 Nov
1:30 am IST; target Mon 16 Nov). Pass/fail test plan: `docs/testing-guide.md`.
Devpost draft: `docs/DEVPOST_DRAFT.md`. Licence & asset audit: `docs/licences.md`.

## Licence posture

Permissive dependencies only: BSD / MIT / Apache / PSF. No GPL or LGPL code is imported.
See `docs/licences.md` for the audit, deliberately excluded projects, and bundled binary
assets (`chime.mp3`, `webxr.png`, banner).
