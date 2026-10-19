# FieldForge — pass/fail testing guide

Run this in one sitting the moment a Quest, a tester, or the emulator is
available. Every test maps to a competition rubric item.

## 0. Prerequisites

- Live link is green on `https://kashimora798.github.io/pysim/` (check
  `.github/workflows/deploy.yml` latest run).
- `npm run verify:kernel` passes (Python ↔ TS agreement to 1e-9).
- A seated desk with ~0.6 m reach.

## 1. Hands-only (Innovation & Technical Implementation)

> "Can someone complete the entire experience without ever pairing a controller?"

| Step | Expected hand path | Pass? |
|------|---------------------|-------|
| Launch | Enter XR by pinching UI button (ray + pinch) | ☐ |
| Pick a problem | Ray → pinch on problem list | ☐ |
| Bench appears | Anchor to desk plane; fallback if none | ☐ |
| Grab a part | Squeeze slot → part follows grip → release on bench | ☐ |
| Wire it | Pinch terminal → drag wire → release on second terminal | ☐ |
| Observe | Current dots flow along wire (sign = direction, speed = magnitude) | ☐ |
| Read | Potential difference shown on trust card / meter | ☐ |
| Next step | Guided mode prompts next part; palm-up shelf within reach | ☐ |
| Exit | Pinch exit button | ☐ |

No controller should be paired during this run. Known gap: the **value dial**
for editing `100 V` etc. is not yet built — workaround is selecting pre-authored
problems per problem; record as defect for judges, not a missing flow.

Desktop fallback: same flow with mouse/ray must still work (dual runtime).

## 2. Seated / airplane seat test (Experience Design)

- Every slot's furthest distance from shoulder ≤ 0.6 m. The inventory enforces it
  by shrinking `SLOT_PITCH`; verify visually — no slot should be overhead or
  behind the back.
- No walking. A seated user must not stand to read the trust card.
- Bench size adapts to detected plane (0.4–1.1 m) so a small desk still fits.

## 3. Ten-minute and cold-start (Experience Design)

- Cold start: reload page → bench visible in < 5 s on 3G throttled.
- One bus stop: from blank page to a satisfying visual (wired loop + flowing
  current + trust card) in ≤10 min. Time with stopwatch.
- Pause/resume: blur tab or cover headset → resume → wires still animate,
  no crash, `VisibilityState` path exercised.

## 4. Not a wrapper (Eligibility)

- Disable network (DevTools offline). Bench, solver, and 24 problems must still
  load from `kb.json` + `specs/*.json`. The optional `extract` (LLM→Scene)
  gracefully shows "AI unavailable, use Auto mode".
- Inspect DevTools Network: no fetch to an LLM host without user action.
- Devpost copy must say: *"Take it away — remove every network call and the
  entire bench, solver, and 24 verified problems still work."*

## 5. Performance (Technical Implementation)

- Target: solid 60 fps on Quest; emulator claims 60 fps alone are not convincing.
- Budget: ≤50k tris on screen, wires & field arrows each one draw call,
  no realtime shadows, no post-processing, texture atlas for parts, pooled wires.
- Frame-time HUD: add in week 1, watch daily.

## 6. Hosting & secrets (Eligibility)

- Live link in fresh private window, no login, no 404s, no console errors.
- `kb.json` `contentHash` === `problems.json` `contentHash`.
- `curl -s https://kashimora798.github.io/pysim/ | head` → 200.
- `grep -r sk- web/dist/` empty; no `apiKey` in bundle (deploy workflow scans).

## 7. Video (<3 min, Polish & Presentation)

- Real headset/emulator footage; no AI-generated pitch video.
- First 20 s are the hook (pinch-to-wire → flow → derivation).
- Shows wiring by hand, current flowing, cited derivation, and no-AI claim.

## 8. Sign-off

- [ ] All boxes above checked on actual hardware (or IWER emulator + tester note)
- [ ] Live link tested on two networks / two devices
- [ ] Video public on YouTube/Vimeo, link pasted in Devpost form
- [ ] Tags: `submission` git tag pushed
- [ ] Site left online through judging (~11 Dec)
