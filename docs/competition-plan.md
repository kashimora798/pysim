# FieldForge XR — Meta VR Start Developer Competition 2026

**Deadline: Wed 18 Nov 2026, 12:00 pm PST (Thu 19 Nov, 1:30 am IST).** Today is 11 Oct.
**5 weeks 3 days.** Plan to submit **Mon 16 Nov** — never on deadline day.
> **Correction 19 Oct:** the 18 Nov 2026 is a Wednesday, not Tuesday. The repo previously
> wrote "Tue 18 Nov"; the checklist dated 19 Oct is authoritative (12 pm PST = 1:30 am IST next
> day).

---

## 0. Verified competition facts

All of the following was read off the live competition pages on 11 Oct 2026, not recalled.

| | |
|---|---|
| Contest | Meta VR Start Developer Competition 2026 (Meta Platforms, via Devpost) |
| Prizes | $1,000,000 total; top prizes $100,000 |
| Field | 2,842 participants registered |
| Submission deadline | 18 Nov 2026, 12:00pm PST |
| Judging | ~18 Nov – 9 Dec; winners ~11 Dec |
| Tracks | Entertainment · Gaming · **Productivity** — *top awards go per track* |
| Divisions | New Experience (built after 24 Sep 2026) · Adapted/Significantly Updated |

### Our submission path is explicitly supported

> *"Built with IWSDK (WebXR): see Deploying to GitHub Pages for how to share a link. You may also
> use your preferred hosting solution (e.g. Vercel, Digital Ocean, AWS, Azure)."*

No APK, no release channel, no invite URL. We submit a **link**. This is materially less friction
than the Unity/Unreal path, and IWSDK is listed under *Suggested SDKs* (Node ≥ 20.19.0,
`npm create @iwsdk@latest`). IWSDK is MIT-licensed, which satisfies our licence stance.

### Judging criteria — four, **equally weighted**

1. **Innovation & Creativity** — originality, track relevance, and *"uniquely leverage Meta device
   capabilities (spatial depth, hands-first design, gaze, passthrough mode, scene understanding,
   persistent anchors) to drive repeat usage."*
2. **Experience Design** — *"seated, hands-first"*, intuitive from the moment of entry, clear
   onboarding, habit-forming. And: *"the player's real room should meaningfully change the
   experience, whether a table becomes the play surface… rather than a scene that plays
   identically with passthrough off."*
3. **Technical Implementation** — hand tracking, gaze, passthrough, spatial anchoring, FoV-aware
   design. *"Must be performant on Meta Quest hardware (min 60 fps), solid and bug-free."* For
   passthrough: correct scene understanding, anchoring to detected planes, *"holding up in rooms
   the developer never tested."*
4. **Polish & Presentation** — UI/UX, art direction, **sound design**, and the submission
   materials themselves. *"Show real gameplay that honestly represents the experience… Don't lean
   on AI-generated video to carry the pitch."*

### Hard requirements, and what each one costs us

| Requirement | What it means here |
|---|---|
| **Hands-first, end-to-end** | *"Can someone complete the entire experience without ever pairing a controller?"* Every interaction must have a hand path. Controllers optional. |
| **Seated-optimised** | *Airplane seat test: does every interaction work in a two-foot radius?* No walking round a lab bench. Parts must come **to** the hand. |
| **Easy in and out** | *One bus stop test.* Something satisfying in ≤10 minutes. Fast cold start, clean pause/resume. |
| **Original, not a wrapper** | *Take it away test: if you remove the third-party service, is there still a Project?* |

**The take-it-away test is a gift to us.** Most "AI + VR" entries put an LLM on the critical path
and fail it. Our kernel is AI-free and deterministic *by construction* — delete every network
call and the whole bench, solver and twelve verified problems still work. We should say this
explicitly in the submission.

---

## 1. The concept

> **FieldForge — the physics bench that lives on your desk.**
> Every other AI simulation tool *guesses* at physics. FieldForge *derives* it — and the
> derivation becomes the thing you build with your hands.

### The architectural hook: one artifact, three modes

The kernel already emits a **trace**: an ordered list of steps, each citing its formula, its law
and its source. That single artifact is simultaneously three things:

| The trace is… | …which gives us |
|---|---|
| the **proof** | every number justified; the trust card |
| the **animation script** | **Auto mode** — the bench assembles itself, narrating |
| the **lesson plan** | **Guided mode** — each `place` / `relate` beat becomes a *hand task* |

Nobody else in this competition can do the third one, because it falls out of having a verified
solver underneath. An LLM-generated sim has no trace to turn into a lesson.

Modes:

- **Auto** — watch it build and solve itself. Zero friction, the 20-second demo.
- **Guided** — the system names the next part; *you* place and wire it; it verifies your build
  matches the topology the solution needs, then resolves that step. This is the product.
- **Free bench** — grab anything off the shelf, wire it, probe it. The solver resolves live.

### The four signature hand interactions

This is what Innovation and Experience Design actually score. Each is one memorable thing.

1. **Pinch-to-wire.** Pinch a terminal, pull a glowing wire out of it, release on another
   terminal. The loop closes and current dots start flowing. *The wiring gesture is the physics.*
2. **Your hand is the probe.** Reach into the field; a live vector arrow blooms at your
   fingertip — length and colour for magnitude, direction for direction — recomputed by the
   kernel every frame. **This is only possible in XR**, and it costs almost nothing to build:
   `field_probe` is already a component in the knowledge base, its position is already a settable
   property, and IWSDK exposes `world.playerSpaceEntities.indexTipSpaces`. Bind one to the other.
   *This is the payoff of the tools-are-components decision.*
3. **Palm-up shelf.** Turn your palm up and the parts shelf rises above your hand. Satisfies the
   two-foot radius without anyone reaching for anything.
4. **Two-handed multimeter.** A probe in each hand; touch two points, read the potential
   difference between them. Free, for the same reason as #2.

### Passthrough, which is weighted twice

The criteria call out the real room in *both* Experience Design and Technical Implementation, with
a named example: *"a table becomes the play surface."* So:

- **Onboarding**: look at your real desk, pinch — the bench anchors to the detected plane.
- **Persistent anchor**: next session it is where you left it. (Named in criterion 1.)
- Parts rest **on** your real table; wires drape over its edge; the field fills the air **above**
  it. With passthrough off this experience is meaningfully worse — which is exactly the test.
- **Untested rooms**: if no plane is found, fall back to a floating bench at seated height and
  say so. Judges will run this in rooms we never saw.

### The trust card

A spatial panel pinned beside the bench showing, for the current step: the formula, the values
substituted into it, the law, the assumptions, the source citation, and a green
**dimensions checked** badge. It is the "lawful, not plausible" claim made visible, and it is the
thing no competitor can fake.

### Productivity framing

A **study bench**, not a toy: problem of the day, chapter progress, a 3-minute problem, a
10-minute session, living permanently on your real desk. That is *"habits tied to a recurring
context"* almost verbatim from the track description.

---

## 2. Architecture: how the Python kernel reaches the browser

The app must be **static** — judges open a URL. So the kernel does not run in the browser; it runs
at **build time**, and ships only what it has already verified.

```
kernel/  (Python — build time, in CI)            web/  (TypeScript — runtime, static)
┌──────────────────────────────┐                 ┌─────────────────────────────────┐
│ YAML knowledge base          │                 │ kb.json      verified rows +    │
│ 6 validators  ── ff export ──┼────────────────▶│               expression ASTs    │
│ expression → JSON AST        │                 │ specs/*.json precompiled traces │
│ precompiled SimSpecs         │                 │ resolver.ts  (free mode only)   │
└──────────────────────────────┘                 └─────────────────────────────────┘
```

Three consequences worth stating plainly:

- **SymPy never ships.** Dimensional analysis is an *authoring-time* concern. Expressions arrive
  pre-parsed and pre-verified, so the browser needs only a ~120-line AST evaluator.
- **`kb.json` carries the audit result and a content hash**, so the app can display
  *"knowledge base verified — 6/6 checks, 23 problems covered"* truthfully.
- **Auto and Guided modes need no browser solver at all.** They replay precompiled specs. Only
  Free mode needs the resolver port.

**That last point is the main de-risking move in this plan:** ship Auto + Guided on precompiled
specs first, and add the TypeScript resolver afterwards. The highest-scoring modes do not depend
on the riskiest code.

### App shape

```
web/
  src/
    main.ts            World.create — dual runtime (XR + desktop)
    bench/anchor.ts    plane detection, persistent anchor, fallback
    bench/shelf.ts     palm-up parts shelf
    parts/             one ECS prefab per knowledge-base component
    wire/pinch.ts      pinch-to-wire, terminal snapping, topology graph
    field/arrows.ts    instanced arrow field (one draw call)
    field/probe.ts     index-tip → field_probe.geometry.position
    modes/{auto,guided,free}.ts
    ui/trustcard.ts    formula · substitution · law · assumptions · citation
    solver/{ast,resolve}.ts
  public/kb.json, public/specs/*.json
```

Scaffold with (per IWSDK's own agent guide):

```bash
npx @iwsdk/create@latest . --yes --force --target ar \
  --grabbing --scene-understanding --environment-raycast --physics --no-locomotion
```

`--target ar` is passthrough/MR. `--no-locomotion` is correct for seated. Dual runtime via
`xr: { offer: 'once' }` + `input: { canvasPointerEvents: true }` so the same code runs on desktop.

### One discipline that must not slip

IWSDK bundles **Havok physics**. It may handle incidental feel — a part settling on the table,
collisions while you place things. It must **never** integrate the physics being taught. The
kernel computes the trajectory; the renderer only applies transforms. A game integrator is
plausible, not lawful, and letting it compute would quietly void the entire positioning.

This is also a *good judge story*: we shipped with a physics engine available and deliberately
did not let it do the physics.

---

## 3. The top risk: no Quest

> **60 fps on Quest and real hand tracking are explicitly judged, and we cannot currently verify
> either.** This is the single biggest threat to winning, and it is a logistics problem, not a
> technical one.

Mitigations, in order of value:

1. **Get device access, with a date on it.** Borrow, rent, a friend, a college lab, a local Meta
   developer meetup, or Start-program perks. **Decision gate: if no device by Fri 31 Oct**, cut
   the fields chapter to auto-play only and spend the time on certainty instead of surface area.
2. **Dual runtime from day one** so the app is continuously testable on desktop — and so judges
   can open it on a laptop too.
3. **IWER emulation** for scripted hand poses: the CLI drives canonical devices `hand-left`,
   `hand-right`, `headset`, `gaze`.
4. **Set the performance budget now, not in week 5.** Instanced arrow field in a single draw
   call; ≤50k triangles on screen; no realtime shadows; no post-processing; texture atlas for
   parts; pooled wire meshes. Build a frame-time HUD in week 1 and watch it every day.
5. **Keep a hardware checklist** to burn through in one sitting the moment a device appears:
   60fps under load, hand-tracking reliability at the pinch, plane detection in three rooms,
   anchor persistence across restarts, FoV comfort, and a full controller-free run-through.

Second risk: **IWSDK is v1.0.1 and young.** Use the official scaffold and CLI, follow its agent
skill, and do not fight the framework.

Third risk: **eligibility.** Start-program membership is required *by submission time* and is not
instant.

---

## 4. Scope, with explicit cut lines

**Must have** — the submission is not credible without these:

- Dual-runtime app, fully operable with hands, no controller ever required
- Desk plane detection + anchored bench + graceful fallback
- Circuits chapter: palm-up shelf → place → pinch-to-wire → solve → meter reading
- Auto mode and Guided mode over precompiled verified specs
- Trust card
- Onboarding under 60 seconds
- Demo video of real gameplay + submission form

**Should have:**

- Fields chapter with hand-as-probe
- Free bench with the in-browser resolver
- Persistent anchors across sessions
- Sound design (explicitly in criterion 4 — do not skip)
- Problem of the day + chapter progress

**Cut first, in this order:** AI prompt layer · multi-path "show me another way" · the cavity
flagship demo · free-bench mode.

---

## 5. Timeline

| Week | Dates | Work | Gate |
|---|---|---|---|
| **W1** | Oct 11–18 | IWSDK scaffold; `ff export` pipeline; kb.json; desk anchor; grab one part; frame-time HUD | A part sits on a detected plane, hands only |
| **W2** | Oct 19–25 | Circuits knowledge base; pinch-to-wire; topology graph; live solve; meter | Build an RC loop by hand and read the current |
| **W3** | Oct 26–Nov 1 | Auto + Guided modes; trust card; onboarding | **Device gate 31 Oct** |
| **W4** | Nov 2–8 | Fields chapter; hand-as-probe; instanced arrows | Hand in the field, arrow at the fingertip |
| **W5** | Nov 9–15 | Polish, sound, art direction, perf pass. **Feature freeze Fri 14 Nov** | 60fps, zero known bugs |
| **W6** | Nov 16–18 | Video, submission copy, buffer | **Submit Mon 17 Nov** |

Budget **three full days** for the video and submission materials. Polish & Presentation is a
quarter of the score and is where strong projects routinely lose.

---

## 6. Do these today

1. **Apply to the Meta VR Start program.** Hard eligibility gate, not instant, and nothing else
   matters without it.
2. **Enable Developer Access** on the Meta account.
3. **Join the hackathon on Devpost.**
4. **Commit to a device plan with a date**, against the 31 Oct gate.
5. Confirm the **New Experience** division is honest for us: the code began 4 Oct, after the
   24 Sep window opens, so it is — but decide deliberately rather than by default.

---

## 7. Why this can win

- It is **hands-first in substance, not decoration**: wiring and probing *are* the physics, not a
  menu you poke.
- It uses the real room the way the criteria ask for, with a named use the judges already
  describe: your desk becomes the bench.
- It has **one thing nobody else has** — a verified derivation underneath — and that single asset
  produces the animation, the lesson and the trust card.
- It passes the take-it-away test outright, in a field where most AI entries will not.
- **Productivity is likely the thinnest of the three tracks**, and awards are given per track.
- The hand-as-probe moment is genuinely impossible on a flat screen, which is the strongest
  possible answer to *"why does this need to be in VR?"*
