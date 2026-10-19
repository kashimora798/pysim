# FieldForge — Devpost form draft (do not paste until 13 Nov)

## Submission name

FieldForge — the physics bench that lives on your desk

## Tagline (≤140c)

A physics bench on your desk: wire a circuit by hand, watch the current flow,
every answer cites the law that proved it.

## Track & division

Track: **Productivity** · Division: **New Experience**

## App link

`https://kashimora798.github.io/pysim/`

## Video link (public, YouTube/Vimeo)

`<paste public link after 12 Nov recording>`

## Description (≤500 words scaffold)

Inspiration: no tool in the market owns a generative + lawful + 3D physics
world. Students see plausibly wrong animations computed by an integrator with the
authority of visualization. FieldForge owns a library of components, the
properties they carry, and the formulas and laws relating those properties — all
as interlinked, machine-checked tables. Given a scene and a target it derives the
answer by chaining verified formulas and emits an ordered trace: every step cites
the formula, the law, and the source.

How we built it: the physics kernel is Python (SymPy + YAML tables + six
validators: refs, dims, rank, units, orphans, coverage). It compiles to
`kb.json` + AST expressions + precompiled `SimSpec` traces for 24 problems. A
browser evaluator replays verified math (~200 lines, no SymPy in the bundle).
The XR app is IWSDK (WebXR) — the bench anchors to the real desk via plane
detection with graceful fallback, palm-up shelf within 0.6 m, pinch-to-wire
with one-draw-call batched wires.

Take-it-away test: delete every network call and the bench, solver, and 24
verified problems still work. An LLM may map prose into a typed `Scene`; it never
computes.

What's next: fields chapter with hand-as-probe, trust card, value dial, more
corpus, persistent anchors. The moat is a large corpus of machine-checked golden
traces.

## Hand interactions (optional field — fill it anyway)

- Pinch-to-wire: pinch terminal, pull wire, release to connect; loop closes,
  current flows.
- Palm-up shelf: parts come to the hand within seated reach (≤0.6 m).
- Your hand is the probe: index tip drives a field-probe vector in the air.

## Target launch date

`<to be announced / not yet published>`

## Team members — add name, email, role per person

| Name | Email | Role |
|------|-------|------|
|      |       |      |
|      |       |      |

## Special awards (read criteria in Special Awards tab)

- Best Agentic Interaction — optional if MCP server ships; defer if not ready.
- Best First Five Minutes, Best Accessibility Forward — mention hands-only,
  seated, clear onboarding.

## Pre-submission check

- [ ] Video is public (not unlisted), plays logged-out in private window.
- [ ] App link loads logged-out, no console errors, kb hash matches.
- [ ] `FF export` coverage 24/24, cross-check 0 disagreements, 6/6 validators.
- [ ] Tag `submission` pushed before deadline.
