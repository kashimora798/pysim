# FieldForge XR — the competition experience

**What shipped (18 Oct 2026):** the 3D WebXR bench from `docs/competition-plan.md`, wired to the
verified kernel. One static site, dual runtime (Quest hands-first + desktop mouse), no server,
no AI required to solve anything.

## Run it

```bash
cd web && npm install --ignore-scripts   # onnx postinstall is emulator-only tooling
npm run dev:runtime                      # Vite on https://localhost:8081 (IWSDK/IWER emulator)
npm run build                            # production bundle in web/dist/
npm run check                            # typecheck + kernel cross-verification + bench-engine regressions
```

Python side (only when the knowledge base changes): `ff audit && ff export` (or
`npm run physics:export`) — the export refuses to ship unverified physics.

## The experience (what a student does)

1. **Your desk becomes the bench.** Plane detection scores real surfaces (floors/walls
   rejected), the bench anchors to the best desk-like plane; no plane → an honest floating
   fallback bench in seated reach. Everything lives inside a ~0.6 m reach sphere.
2. **Pick a problem** (24 verified golden problems: circuits Ch.1 + electrostatics flagship set).
3. **Auto** — the precompiled derivation replays on the bench: parts appear in derivation
   order, relations draw, each quantity resolves with its formula, substituted values, law,
   assumptions and citation on the **trust card** (spatial panel + HUD mirror).
4. **Guided** — each `place`/`relate` beat becomes a hand task: *"Place a Resistor"*, *"pinch-wire
   r1 → r2"*. The system verifies the student's real build (palette spawns / live wires)
   against the solution topology before the step resolves. Wrong build = no wrong number.
5. **Free bench** — grab any battery/resistor/lamp, pinch-wire a loop. The wire graph is
   translated into a series/parallel reduction tree (`src/ff/topology.ts`), solved live by the
   TypeScript port of the kernel, and the current flows in the wires (lamp glow follows resolved
   power). Non-reducible networks are refused honestly ("needs Engine B"). Values are editable
   (12 V / 10 Ω defaults are stated, never hidden).
6. **Your hand is the probe.** In field problems, instanced arrows (one draw call) fill the air
   above the bench — every arrow's magnitude is kernel-resolved for that point. Reach in: a
   live vector blooms at your fingertip with an exact readout
   (`E = … V/m · V = …`, Coulomb/superposition, kernel-resolved; only the arrow's *length* is
   log-scaled, and the card says so).
7. **Sound** — synthesised WebAudio cues (place/resolve/answer), no assets. **Spatial NEXT /
   PLAY buttons** on the bench work by hand press; the desktop HUD mirrors everything.

## Architecture (the lawful pipeline, end to end)

```
YAML tables ──(6 validators, ff export)──▶ kb.json + 24 SimSpecs (hash-stamped)
                                              │
        ┌─────────────────────────────────────┼──────────────────────────────────┐
   Auto/Guided replay                   Free bench                        Fields
   specs/*.json → player                wires → topology.ts               field.ts per-point
   (proof = storyboard)                 → reduction tree → Resolver       scenes → Resolver
                                              │                                │
                                        Wire.current flow              arrows + fingertip probe
```

New code: `web/src/ff/experience.ts` (modes/player/trust-card/solver-bridge/probe/sound),
`web/src/ff/topology.ts` (wire graph → Scene, unit-verified against p101/102/103/105),
`web/src/ff/field.ts` (superposed, kernel-resolved field sampling; returns null rather than
inventing). Fixed pre-existing `resolve.ts` type errors; `npm run check` is green: `verify:kernel` reproduces
all 87 Python-derived steps to 1e-9, and `scripts/check-experience.mts` reproduces the golden
answers through the bench's own engines (p101 3 A · p102 0.3 A · p103 6 A · p105 2 A · p002 field)
including honest refusals (shorted battery, open loop). The HUD carries a live fps meter for the
60 fps budget, and Guided tasks have a desktop companion verify button for mouse users.

The rules held: no game-physics integration of taught physics (Havok unused), AI only in
`extract.ts` (optional paste-a-problem; kernel validator accepts/rejects; bench fully works
with AI unplugged — the take-it-away test), renderer never computes a number the kernel didn't.

## Judge demo script (≤3 minutes)

1. Desktop link opens → banner shows the verified bundle hash + coverage. Launch **p101 Auto**:
   battery/resistor/loop assemble, `I = 3 A` lands with Ohm's law on the trust card.
2. **Guided p103** (parallel pair): build it by hand; watch verification accept your topology.
3. **Free bench**: wire battery + two resistors in series, change 10 Ω → 20 Ω, current updates
   live and flows. Short the battery → honest refusal.
4. **XR**: enter passthrough, bench on the real desk, **p002 Guided**: reach into the point
   charge's field — the fingertip arrow shrinks as 1/r² while the readout stays exact.
5. Close on the trust card: *"Every frame you saw was derived, dimension-checked, and cited.
   Unplug the AI and it all still works."*

## Honest limitations (do not demo past these)

- **Not yet verified on a Quest.** 60 fps, hand-tracking pinch reliability, plane detection in
  strange rooms, and anchor persistence are unproven until device access (plan gate: 31 Oct).
  Performance budget is respected in design (instanced arrows, one-mesh wires, no shadows/post)
  but unmeasured on hardware.
- Part visuals are procedural proxies with labels, not modelled GLBs (the KB's `model3d`
  names still have no files). Schematic-first per the founding document.
- Free bench covers series/parallel resistor/lamp networks; bridge/non-reducible networks
  need Engine B, time evolution needs Engine C (both specified in
  `docs/implementation-plan.md`).
- Anchor persistence across sessions is session-local until verified on hardware.
