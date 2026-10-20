# FieldForge — Further Implementation Plan

**Written:** 18 Oct 2026, from a full read of the repository (every kernel module, every YAML
table, all 24 corpus problems, all three test files, the complete `web/src` tree, both research
documents, and the competition plan).
**Companion documents:** `docs/architecture.md` (how the system works), `docs/competition-plan.md`
(the Meta VR Start 2026 campaign), `FieldForge-Research-Document (1).pdf` (the founding vision),
`Physics Simulation Competition Research.html` (the market map). This plan does not repeat them;
it answers one question: **what is actually built, what is actually missing, and in what order do
we build the rest?**

> The one rule, unchanged, governing every phase below: **AI at the boundary, never in the
> kernel.** Nothing in this plan puts a model, a network call, or a game-physics integrator on the
> computation path.

---

## 1. What this project is (the 60-second version)

FieldForge is a **deterministically verified physics world**: a curated, machine-checked library
of physics *components* (battery, resistor, point charge, electron…), the *properties* they carry
(charge, resistance, field, speed…), and the *formulas and laws* relating those properties — all
stored as interlinked YAML tables keyed on one universal join key, the **property**.

A problem arrives as a typed `Scene` (instances + relations + givens). **Engine A**, a
backward-chaining resolver, works backwards from the target quantity, recursively resolving
missing inputs through the formula graph, and emits a **trace**: an ordered derivation in which
every step cites its formula, its law, its assumptions, and its source. The trace compiles to a
**SimSpec** JSON, which is simultaneously the proof, the animation script, and the lesson plan —
derivation order *is* build-up order. Multiple derivations are deduplicated by *law set* (energy
route vs. kinematics route, not algebraic rearrangements), and the corpus asserts all paths agree
to 1e-9: **cross-path agreement is the verification story.**

The same verified bundle (`kb.json` + precompiled `specs/*.json`) is exported at build time to a
static WebXR app (IWSDK) where the lab bench anchors to the user's real desk, parts are grabbed
from a knowledge-base-driven palette, and wires are pinched between terminals. An LLM
(Qwen3-8B over an OpenAI-compatible endpoint) exists only in `web/src/physics/extract.ts`, where
it fills a closed-vocabulary schema that the real validator then accepts or rejects.

**The moat is the corpus**: machine-checked golden traces that compound chapter by chapter. The
algorithms are clean but copyable; 24 verified problems today, hundreds tomorrow, are not.

## 2. Verified state of the repository (measured, not remembered)

All numbers below were reproduced on 18 Oct 2026: `ff audit` runs clean and `pytest` reports
**82 passed**.

### 2.1 The Python kernel — complete for its scope (Milestones M0–M3 + export)

| Module | Lines | Role | State |
|---|---|---|---|
| `kernel/dims.py` | 143 | 7-vector SI dimension algebra (kg·m·s·A·K·mol·cd) | ✅ done |
| `kernel/units.py` | 248 | `"100 V"` → (value, dimension); SI normalisation, vectors | ✅ done |
| `kernel/ontology.py` | 157 | Property registry: dimension, `rank` (scalar/vector), `kind` (lumped/field/pair) | ✅ done |
| `kernel/kb.py` | 427 | Components / formulas / laws; `solvers` index (property → formulas) | ✅ done |
| `kernel/exprs.py` | 471 | Sealed-namespace SymPy parsing, whitelist, dimension+rank inference, safe evaluation, JSON-AST serialisation | ✅ done |
| `kernel/validate.py` | 409 | The 6 validators: refs, dims, rank, units, orphans, coverage | ✅ done |
| `kernel/scene.py` | 306 | Scenes, instances, relations-that-carry-properties, implicit environment injection, corpus loader | ✅ done |
| `kernel/engine_chain.py` | 441 | **Engine A**: backward chaining, memoised, cycle-detected, depth-capped (12), law-set path dedup, self-explaining failures | ✅ done |
| `kernel/trace.py` | 295 | Trace → SimSpec (`place` / `relate` / `given` / `resolve` / `answer` beats, `because` on every beat, property→visual-channel map) | ✅ done |
| `kernel/export.py` | 311 | `ff export`: refuses on any validator error; writes `kb.json`, `problems.json`, 24 precompiled specs, SHA-256 content hash | ✅ done |
| `kernel/cli.py` | 329 | `ff audit / props / components / formulas / solve / coverage / export` | ✅ done |

**Knowledge base (data, not code): 56 properties · 10 constants · 25 components · 68 formulas ·
25 laws.**

- Properties by domain: electromagnetism 14, geometry 11, mechanics 11, electricity 8,
  kinematics 7, environment 5. Rank: 41 scalar / 15 vector. Kind: 47 lumped / 7 field / 2 pair.
- Formulas by scope: 42 `self`, 26 `pair`, **0 `scene`** (the scope exists in the schema and in
  role-binding code, but no formula uses it directly — environment access goes through
  `scene: true` *roles* instead; either document that as the idiom or add a `scene` exemplar).
- Components (25): circuits (`battery, resistor, lamp, capacitor, circuit_loop, series_pair,
  parallel_pair, ammeter, voltmeter_dc`), electrostatics (`point_charge, charged_particle,
  electron, parallel_plate_capacitor, uniform_field_region, uniform_magnetic_field_region,
  uniform_charged_sphere, conducting_shell, infinite_charged_plane, infinite_charged_line,
  spherical_cavity_in_charged_sphere`), plus `environment`, and tools-as-components
  (`field_probe, voltmeter, ruler, stopwatch`).

**Corpus: 24 problems, 100% coverage, 4 multi-path.**

- `p001–p014` — electrostatics/mechanics flagship set, incl. the two demos no competitor can
  fake: **p003/p011** (uniform field inside a spherical cavity in a charged sphere, chaining
  superposition → Lorentz force → Newton II → kinematics across three domains) and **p004**
  (shielded cavity: `E = 0` justified by a relation with *zero* formula inputs).
- `p101–p110` — circuits Chapter 1: Ohm loops, series/parallel reduction, nested reduction
  (p105), voltage sharing back *down* the reduction tree (p106), capacitors, RC time constant.
- Relations in use: `acts_on, inside, inside_cavity_of, driven_by, loads, series_a/b,
  parallel_a/b, charged_through` (10 kinds).
- Components never yet exercised by any problem: `ammeter, voltmeter(_dc), ruler, stopwatch,
  infinite_charged_line, uniform_field_region` — i.e. **the entire tools story is encoded but
  unproven**, and the line-charge Gauss case is missing.
- Audit backlog (orphan warnings, by design the to-do list): `em.electric_flux`,
  `geometry.angle`, `geometry.length` can be produced by nothing.

### 2.2 The TypeScript runtime — the physics half is ported; the experience half is not wired

| File | Lines | State |
|---|---|---|
| `web/src/physics/kernel.ts` | 435 | ✅ AST evaluator + quantity arithmetic + `loadPhysics()` (hash-checked bundle loader). Must agree with Python to the last float. |
| `web/src/physics/resolve.ts` | 1,293 | ✅ Engine A + `build_scene` ported 1:1 from Python (`Resolver`, `buildScene`, unit parser). The spec is the Python file; drift = bug. |
| `web/src/physics/extract.ts` | 1,249 | ✅ The LLM boundary: closed-vocabulary catalogue → JSON-schema enums → Qwen3-8B → real `buildScene` validation → `{ok:false}` + partial scene on any failure. Never throws. |
| `web/src/ff/ai-config.ts` | 107 | ✅ Proxy-first / personal-key AI config; degrades to no-AI cleanly (the take-it-away test). |
| `web/scripts/verify-kernel.mts` | 119 | ✅ Cross-language check: replays every precompiled trace through the TS evaluator, fails at >1e-9 relative drift. Wired as `prebuild`. |
| `web/src/ff/bench.ts` | 391 | ✅ Desk-plane scoring (rejects floor/ceiling/walls), re-anchoring, seated-reach clamp, honest fallback bench. |
| `web/src/ff/inventory.ts` | 1,105 | ✅ Palette generated *from `kb.components`* (never hand-authored), infinite stock, grip-pose hand-off, reach-clamped spawning. Procedural placeholder geometry. |
| `web/src/ff/terminals.ts` | 641 | ✅ Terminal entities parented to parts; `TerminalKind` makes illegal connections unrepresentable; snap/highlight queries. Layouts exist for only 8 kinds — everything else falls through to a structural `Mount` node. |
| `web/src/ff/wire.ts` | 1,181 | ✅ All wires in **one** merged mesh / one draw call; catenary (`Flexible`) and grid-snapped Manhattan (`Straight`) styles; flow animation via per-vertex shader attributes; pinch-drag API (`beginDrag/completeDrag/cancelDrag`). |
| `web/src/index.ts` | 39 | ⚠️ Registers Bench → Terminal → Wire → Inventory + the two IWSDK template leftovers (Panel, Robot). **No mode, player, solver-bridge, field, or trust-card system exists.** |
| `web/public/physics/` | — | ✅ Exported bundle: `kb.json` (137 KiB), `problems.json`, 24 specs (9–77 KiB each). |
| `web/public/scenes/main.iwsdk.scene.json` | — | ❌ Still the IWSDK starter scene (plant, robot, welcome banner). No bench/parts scene nodes authored. |
| `web/src/assets.ts` | 54 | ❌ Only stock CDN assets. **Every `model3d: *.glb` named in the KB (battery, resistor, electron, plates, cavity sphere…) points at a file that does not exist.** The bench currently renders procedural geometry. |

### 2.3 What is missing — the honest gap list

Ranked by "does the product claim survive without it":

1. **The solver bridge (critical).** Nothing connects the bench to the solver. `Wire.current`
   is documented as "written by the solver bridge" — that bridge does not exist. There is no
   code that turns placed `Part`s + pinched `Wire`s into a `SceneSpec`, runs
   `buildScene`/`Resolver`, and writes results back to wires, meters, or UI. Until this lands,
   the XR app is a beautiful bench that cannot solve anything.
2. **The topology translation (critical, and a genuine design problem).** The corpus speaks in
   *reified* relations — a `circuit_loop` instance `driven_by` a battery and `loads`-ing a
   `series_pair`/`parallel_pair` reduction tree — while the bench speaks in *terminal-to-terminal
   wires*. Somebody must translate a wire graph into (a) a reduction tree of pair components or
   (b) a new relation vocabulary the resolver understands. This decision shapes Engine B too
   (§5), so it must be made once, deliberately, and recorded as an ADR.
3. **Modes + SimSpec player (critical for the competition).** Auto (replay the trace as a
   self-assembling bench), Guided (each `place`/`relate` beat becomes a hand task, verified
   against the spec), and Free bench are specified in `docs/competition-plan.md` §1 but no
   `modes/` code, no beat player, and no playback state machine exists.
4. **The trust card (critical for the claim).** The spatial panel showing formula, substituted
   values, law, assumptions, citation, and the green "dimensions checked" badge — the visible
   form of "lawful, not plausible" — is not built. The only UI is the template welcome panel.
5. **Field visualisation + hand-as-probe.** No instanced arrow field, no index-tip →
   `field_probe.geometry.position` binding, no two-handed multimeter. This is the single most
   XR-native, judge-scoring interaction in the plan and it is entirely unbuilt. (`field_probe`
   being an ordinary component makes it cheap — the position is already a settable property.)
6. **Real 3D assets.** All `model3d` references dangle. Either model the ~15 competition-scope
   parts (low-poly, atlased, ≤50k triangles total on screen) or formally demote `model3d` to a
   post-competition concern and make the procedural geometry *good*.
7. **Engine B — acausal system assembly.** Engine A cannot do simultaneous systems (Wheatstone
   bridge, multi-loop Kirchhoff networks, anything where no formula isolates the unknown).
   Components must contribute constitutive equations, topology must contribute connection
   equations, and the assembled system is solved (SymPy linear/nonlinear solve) — with Engine A
   as the triangular special case, so the two engines **cross-check on every problem both can
   reach**. This is also where "optional force contributions" (drag folded into net force — see
   the honest limitation recorded in `formulas/mechanics.yaml: force.net_from_contributions`)
   become expressible.
8. **Engine C — ODE/DAE time evolution.** Today every answer is a *value*; a trajectory is a
   *function*. Engine C samples the derived dynamics (constant-acceleration motion now;
   RC transients, cyclotron orbits, projectile-in-field later) so the renderer animates motion
   the kernel computed — never motion a game integrator (Havok/Rapier) guessed. Havok may settle
   a part on the table; it must never integrate the physics being taught.
9. **The LLM boundary's last mile.** `extract.ts` is built, but: no scene-editor UI to show the
   extracted scene for correction (the "wrong extraction surfaces as an editable structured
   scene" promise), no `scripts/check-extract.mts` (referenced in the file header, absent), and
   no deployed proxy. Cut first per the competition plan — but the editor UI is also the Free
   bench's property inspector, so build it once for both.
10. **MCP server.** The founding document's §6.2 tool surface (`list_components`,
    `get_component`, `assemble`, `connect`, `solve`, `probe`, `derive`, `render_frames`) —
    zero code exists. This is the B2D product and the "every AI tutor becomes a customer"
    inversion; it is deliberately *after* the bench proves the engine is worth calling.
11. **Corpus depth.** 24 problems is a proof, not a product. The moat compounds only if coverage
    grows chapter by chapter with the audit as the backlog (currently: flux/Gauss producers,
    angle/length geometry, line charge, every tool component, AC, optics, waves,
    thermodynamics, rotation, gravitation-as-chapter…). Research-doc Phase 0 estimated
    ~40 components / ~120 formulas for one full chapter; we are at 25 / 68 across *two* partial
    chapters.
12. **Documentation drift (small, fix immediately).** `README.md` claims "No 3D renderer yet"
    (there is a half-built one); `docs/architecture.md` §"What is missing" lists the renderer,
    the LLM boundary, and the TS resolver as unbuilt (all three exist); `kernel.ts` comments say
    "21 precompiled traces" (there are 24); `web/package.json:physics:export` uses the Windows
    path `.venv/Scripts/python` (breaks on Linux/macOS). Judges and contributors read these
    first — the trust product cannot have an untrustworthy README.

## 3. Guiding decisions to lock before Phase 1 (ADRs)

Write these as one-page Architecture Decision Records in `docs/adr/` *before* the code that
depends on them:

- **ADR-1 · Wire graph → scene topology.** Options: (a) infer a binary reduction tree
  (`series_pair`/`parallel_pair` synthesis) from the wire graph — matches the corpus and the
  taught physics, mirrors build order; (b) introduce a `connected_to` relation + let Engine B
  assemble Kirchhoff systems directly — more general, but makes Free bench depend on Engine B.
  **Recommendation: (a) now for Guided/Free circuits, (b) as Engine B's native input later; the
  tree inference is a pure function `wireGraph → SceneSpec` with its own tests.** Failure mode
  to design for: a wire graph that is neither series nor parallel decomposable must say so
  honestly ("this network needs the system solver — coming in Engine B"), never silently solve
  a different circuit.
- **ADR-2 · SimSpec versioning.** `SPEC_VERSION = "0.1"` in Python, `schema: "1"` in the export.
  Unify into one versioned contract with a changelog; the player, the MCP `render_frames` tool,
  and any future desktop player all consume it. Add `engine: "A" | "B" | "C"` and sampled-series
  support (Engine C) to the schema *on paper* now so C doesn't break the contract later.
- **ADR-3 · Where Engine B lives.** Python-first (SymPy assembly, corpus-verified, exported
  traces), TS port second (same discipline as Engine A: Python is the spec, `verify:kernel`
  extended to B-traces). Never TS-first.
- **ADR-4 · Asset strategy.** Procedural-vs-modelled per component kind, triangle/texture budget,
  and the rule that `ff export` *warns* when a component's `model3d` file is absent from
  `web/public/` (turn today's silent dangling references into an audit line).
- **ADR-5 · States beyond `initial`/`final`.** Engine C needs time-series, not two instants.
  Decide now that sampled series live in the SimSpec (`series: {t, values[]}` per ref), *not* in
  new property states — states are per-binding and must stay that way (`kernel/scene.py`).

## 4. The plan, phase by phase

Effort is in focused developer-days (d) for one strong full-stack developer; curation tasks are
separately marked (c) because they are physics-authoring, not coding. Competition-critical phases
are marked ★ (per `docs/competition-plan.md`: submit **Mon 17 Nov 2026**, freeze **Fri 14 Nov**).

### Phase 0 — Reconcile truth (2–3 d) ★

*Goal: the repo says what is true, and CI proves the two kernels agree.*

1. Fix the four documentation drifts in §2.3.12; rewrite `README.md` Status (M0–M3 + export +
   TS port + bench systems; modes/bridge/fields pending).
2. Add CI (GitHub Actions): `pytest` (82) → `ff audit` → `ff export` → `npm run typecheck` →
   `npm run verify:kernel`. The export's refuse-on-error behaviour makes CI a physics gate, not
   a style gate.
3. Fix `physics:export` for POSIX (`python` from `.venv/bin`), keep Windows working.
4. Delete or quarantine the IWSDK template leftovers (robot, welcome panel, plant, banner) from
   the shipped scene; keep `panel.ts` only as the seed of the trust card.
5. Write ADR-1…ADR-5.
   **Done when:** a fresh clone runs the full gate green and every claim in the README is
   mechanically checkable.

### Phase 1 — The solver bridge: make the bench solve (5–8 d) ★★ (the critical path)

*Goal: place battery + resistor, pinch a loop closed, watch the kernel's number appear.*

1. `web/src/ff/topology.ts` — pure `wireGraph → SceneSpec` per ADR-1: terminals/wires →
   `circuit_loop` + reduction-tree synthesis + `driven_by`/`loads`/`series_*`/`parallel_*`
   relations. Unit-tested against hand-built graphs for p101/p102/p103/p105 topologies.
2. `web/src/ff/solver-bridge.ts` — ECS → `buildScene(spec, kb)` → `Resolver.resolve(target)`;
   writes `Wire.current`, meter readings, and the current `Derivation` to a shared bench state.
   Re-resolves on topology/property change (debounced, synchronous — Engine A is microseconds
   at this scale). Invalid scenes surface the resolver's own `Failure` text; a bridge must
   never invent a number.
3. Property editing on placed parts: settable slots from `kb.json` (resistance, emf,
   capacitance) via the scene-editor UI (§Phase 6.1, built here in minimal form).
4. Targets: default target per topology (`loop.electric.current`), explicit target picker next.
   **Done when:** the p101 loop built *by hand in the emulator* reads 3 A with a trust-card-grade
   derivation available, and breaking the loop honestly un-solves it.

### Phase 2 — Modes and the SimSpec player (6–9 d) ★★

*Goal: one trace artifact drives proof, animation, and lesson — visibly.*

1. `web/src/modes/player.ts` — beat player over `SimSpec.timeline`: `place` (spawn/highlight
   part), `relate` (draw wire/relation), `given` (show value), `resolve` (animate the channel
   from `trace.py:CHANNEL` — field arrows, force vectors, energy bars, clock), `answer`.
   Play/pause/scrub; seated-safe (nothing requires reaching beyond the bench).
2. `modes/auto.ts` — zero-friction replay: the 20-second demo. `modes/guided.ts` — each
   `place`/`relate` beat becomes a hand task ("place the battery", "wire r1 to r2"); the system
   verifies the student's topology against the spec's, then resolves that step live via the
   Phase-1 bridge. Wrong part/wire = gentle rejection with the reason, never a wrong number.
3. `ui/trustcard.ts` — spatial panel per beat: formula, substituted expression, law + statement,
   assumptions, citation, inputs with provenance, "dimensions checked ✓" from the bundle's
   audit block, and the content hash as provenance stamp. Multi-path problems get the
   "another way" switcher (data already in `paths[]`) — competition plan lists it as cut-first,
   so build the card first, the switcher only if the calendar survives.
4. Problem picker over `problems.json` (title, tags, answer hidden until solved in Guided).
   **Done when:** p001 plays end-to-end in Auto, is buildable in Guided with verification, and
   every rendered beat can show its `because`.

### Phase 3 — Fields chapter: arrows and the hand-as-probe (5–7 d) ★

*Goal: the interaction that is impossible on a flat screen.*

1. `field/arrows.ts` — instanced arrow grid (one draw call) over the bench volume; per-instance
   direction/magnitude/colour from the kernel: for each grid point, synthesise a `field_probe`
   at that position and resolve `em.electric_field` (Engine A already supports this — it is a
   scene with a moved probe). Cache per scene-state; recompute on change, not per frame.
2. `field/probe.ts` — bind `world.playerSpaceEntities.indexTipSpaces` (hand) / target-ray
   (controller) to a live `field_probe`: a vector arrow blooms at the fingertip, length+colour =
   magnitude, recomputed each frame from the resolver. Two-handed variant: probes in both hands
   → potential difference between them (the two-handed multimeter, free for the same reason).
3. Field problems wired into Guided: p002, p005, p013 first; p003 cavity as the flagship demo
   (competition plan: cut before the circuits chapter, never instead of it).
   **Done when:** a hand moving through the p002 field sees the arrow shrink as 1/r² — computed,
   not keyframed.

### Phase 4 — Engine B: acausal system assembly (10–15 d + curation)

*Goal: simultaneous systems — the class Engine A honestly cannot do.*

1. `kernel/engine_system.py`: components contribute constitutive equations (from a new
   `equations:` block per component — still property-keyed, still dimension-checked by a 7th
   validator), topology contributes connection equations (KCL/KVL from relations), SymPy solves
   the assembled system. Output is still a *trace*: elimination order becomes derivation order.
2. Cross-check harness: every corpus problem both engines reach must agree (extends validator 6
   and `SimSpec.checks.engines: ["chain"]` → `["chain", "system"]`). Disagreement = audit error.
3. First B-only corpus: Wheatstone bridge, two-loop Kirchhoff network, resistor network that is
   not series/parallel-decomposable, capacitor networks, drag-in-net-force (retiring the
   documented `force.net_from_contributions` limitation).
4. Export + TS port (`resolve-system.ts`) under ADR-3; `verify:kernel` extended to B traces.
   Only then does Free bench accept non-decomposable wire graphs (ADR-1b).
   **Done when:** a Wheatstone bridge the chain resolver refuses is solved by B, and A∩B
   problems cross-check green in `ff audit`.

### Phase 5 — Engine C: time evolution (8–12 d)

*Goal: trajectories as sampled functions, lawfully.*

1. `kernel/engine_ode.py`: from a resolved state + dynamics (Engine A/B provide `a(x,v,t)`),
   integrate with an explicit, dimension-checked scheme (RK4; SymPy where closed forms exist —
   constant-acceleration and cyclotron motion must reproduce the analytic answers already in
   the corpus). Emits SimSpec `series` per ADR-5: `{ref, t[], values[]}` + the beats that
   justify the dynamics.
2. First C corpus: p011 extended to a full cavity crossing (position/velocity series), p006
   cyclotron orbit, RC discharge (needs B's capacitor equation or an A-chain `τ` + exponential
   law row), projectile in a uniform field (the research document's cross-domain demo, live).
3. Player upgrade: series drive part transforms and charts; the renderer only applies
   transforms (the Havok rule, §2.3.8). TS side *replays* series; integration stays Python-side
   until a port is justified.
   **Done when:** the cavity projectile's animated path is the kernel's sampled series, and
   scrubbing the trust card to any `t` shows values from that series.

### Phase 6 — Boundary hardening: LLM extraction + scene editor (4–6 d)

1. `web/public/ui/scene-editor.uikitml` + system: the extracted/bench scene as editable
   structured data (instances, settable values, relations) — one UI serving extraction
   correction, Guided hints, and Free-bench inspection. Rejection reasons from `buildScene`
   displayed verbatim (they are written to be shown).
2. `web/scripts/check-extract.mts` (the file `extract.ts` already promises): prompt/schema/
   parser tests with a stubbed `fetchImpl`, no network, no key — in CI.
3. Serverless proxy recipe (Worker/Vercel) in `docs/ai-proxy.md`: holds the key, rate-limits,
   forwards to Featherless; the static site never ships a credential.
   **Done when:** pasting p002's prose produces an editable scene that solves — and pasting
   nonsense produces an honest rejection, with AI unplugged the bench is unaffected.

### Phase 7 — MCP server: the world for AI agents (5–8 d)

*Goal: the founding document's §6.2 surface, over the Python kernel (the source of truth).*

1. `server/` (Python, official MCP SDK, permissive deps only): tools `list_components`,
   `get_component`, `assemble`, `connect`, `solve`, `probe`, `derive`, `render_frames` —
   thin wrappers over `build_scene`, `Resolver`, `build_simspec`. Every response carries the
   trace/citations; the server computes, the agent narrates.
2. Conformance tests: an external agent (any MCP client) assembles p101 and receives 3 A with
   the cited derivation; invalid assemblies return validator text, never numbers.
3. Publish: registry listing, `docs/mcp.md` integrator guide, per-solve metering hooks (no
   billing yet — Phase 9's business decision).
   **Done when:** a third-party agent builds a verified sim end-to-end via MCP (research-doc
   Phase 3 exit criterion).

### Phase 8 — Corpus & knowledge-base expansion (continuous; curation-led)

*Goal: compound the moat, one fully-covered chapter at a time. The audit is the backlog.*

Per-chapter sprint (the repeatable unit of work): encode components → encode formulas with
OpenStax (CC BY) citations → add corpus problems until the chapter's standard problem types
resolve → zero orphan warnings for the chapter's properties → export.

1. **Close the current backlog** (1–2 c): Gauss/flux (`em.electric_flux` producer via
   `gauss_law_electric`), `geometry.angle`/`geometry.length` producers/consumers, line-charge
   problem for `infinite_charged_line`, and one problem per tool (`ammeter` in a loop,
   `voltmeter` across r1, `ruler`/`stopwatch` kinematics) — tools-as-components is a headline
   claim and currently unproven.
2. **Circuits Chapter 2** (3–5 c): internal resistance, Kirchhoff multi-loop (Engine B),
   RC transients (Engine C), AC phasors (new `kind`/rank questions — phasors may need a
   complex-scalar property convention; ADR required).
3. **Mechanics proper** (4–6 c): projectile motion, inclined planes, friction, circular motion,
   gravitation — the properties largely exist; components and formulas are the work.
4. **Then, in value order:** magnetism (force on wires, induction/EMF — the research
   document's coaxial-solenoid canonical case), optics (components are property-carriers too:
   lens focal length is a settable property; thin-lens formula is a row), waves & sound,
   thermodynamics, modern physics.
5. **Authoring workbench** (post-competition, 8–10 d): web formula editor with live dimension
   check + "test against corpus" — Wikipedia's model, but every edit machine-checked
   (research-doc Phase 3/community curation). This is how curation velocity stops being
   founder-bound.
   **Standing rule:** no chapter is "done" at 90%. Completeness is `ff audit` green with zero
   orphan warnings over that chapter's properties — a testable property, never an aspiration.

### Phase 9 — Productisation beyond the competition (sequenced by the business decision)

1. **Desktop/web player** — the same SimSpec bundle in a non-XR Three.js player (worked-example
   pages with KaTeX derivations for teachers; shareable links per problem). The kernel/renderer
   split was designed for exactly this; it is also the SEO/distribution surface.
2. **Teacher & curriculum layer** — chapter mapping (OpenStax/JEE), assignments, problem-of-
   the-day, progress. (Competition plan's Productivity framing, generalised.)
3. **Accounts/billing/API keys** — only when B2C/B2D pricing (research doc §9: freemium
   ₹499–999/yr India · $30–60/yr
...[truncated 7246 chars]