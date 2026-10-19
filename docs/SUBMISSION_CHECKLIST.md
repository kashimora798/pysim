# FieldForge — Meta VR Start Developer Competition 2026 submission checklist

Prepared 19 Oct 2026 from the Devpost overview, Meta's announcement, the Start
program page, and the `pysim` repo. The official Rules page would not open on
19 Oct, so items marked **read the Rules** need to be checked directly.

**Hard deadline: Wednesday, 18 Nov 2026, 12:00 pm PST → Thursday, 19 Nov 2026, 1:30 am IST.**
Target: **Monday, 16 Nov 2026**. Nothing can change after the deadline; judging
uses the state at deadline and runs until ~9 Dec, winners ~11 Dec.

> The plan doc dated 11 Oct wrote "Tue 18 Nov" — that is wrong, the 18th is a
> **Wednesday**. This file is the corrected reference. `docs/competition-plan.md`
> was patched to match.

Repository: `https://github.com/kashimora798/pysim` (this repo)  
Live link (after Pages is enabled): `https://kashimora798.github.io/pysim/`  
App track: **Productivity** — the plan docks a physics study bench to your desk.  
Division: **New Experience** — first commit 18 Oct 2026, plan dated 11 Oct, both
after the 24 Sep 2026 cutoff. Check that no file in the submission predates
24 Sep.

---

## 1. Blockers — clear this week (by Wed 22 Oct)

- [ ] **Age and country.** Entry requires being above the legal age of majority
  where you live (18 in India). Start program also requires 18+, a Meta developer
  account in good standing, and an eligible country. If unsure, email the
  hackathon manager (link on Devpost) before spending more time.

- [ ] **Read Rules §2(b).** Lists excluded countries/territories; forum posts say
  it includes Brazil, Quebec, Cuba and Iran. Also read prizes/payout paperwork and
  who owns the code.

- [ ] **Apply to the Start program.** Free and required, approval time unknown —
  do it first. Developer Access must be enabled on the Meta account.

- [ ] **Register on Devpost** with *Join hackathon*.

- [ ] **Confirm the division.** New Experience = built after 24 Sep 2026, no
  pre-existing codebase. `git log` first commit is `fc2fb73` 18 Oct 2026; plan is
  11 Oct. Fits. Verify no vendored code predates 24 Sep.

- [ ] **Confirm the track.** Plan says Productivity. Form requires one track;
  stick to it. Judging is per-track.

---

## 2. Pass/fail requirements to test

- [ ] **Hands-only, start to finish.** A judge must complete everything without a
  controller, including setting part values, switching modes, panels and exiting.
  `iwsdk.config.json` already has `handTracking: true` and
  `grabbing.useHandPinchForGrab: true` plus `canvasPointerEvents` for desktop
  fallback. Still missing: the **value dial** (currently no way to set e.g.
  `100 V` or `10 Ω` without typing) — this is an open gap toward the
  competition's "every interaction must have a hand path" rule. Mitigation:
  ship problems as pre-wired scenes selectable by hand ray, so no dial is
  needed for the judged path; make the dial a post-freeze stretch goal.

- [ ] **Seated test: every interaction works within ~0.6 m.** The inventory
  enforces this: `layoutGrid()` shrinks `SLOT_PITCH` until the furthest slot is
  inside `REACH_RADIUS = 0.6 m` and every spawned part is clamped to the reach
  box derived in `computeReachBox()`. `MAX_REACH = 1.1 m` in bench. Manual test:
  sit in a chair, palm-up shelf must be reachable without leaning.

- [ ] **Ten-minute and cold-start test.** Something satisfying in <10 min, fast
  start, clean pause/resume. `VisibilityState` blur/hidden short-circuit in
  `WireSystem.update` prevents burning cycles when not visible. Static hosting
  means cold start is just HTML+JS fetch; keep total `dist` under ~2 MB gzipped.

- [ ] **Not a wrapper — the Take-It-Away test.** Optional model step must pass:
  with `VITE_FF_AI_PROXY` unset (see `web/src/ff/ai-config.ts`), the bench,
  solver, and 24 problems still work. Test the no-key path explicitly and say so
  in the Devpost description: *"Delete every network call and the whole bench,
  solver and 24 verified problems still work."*

- [ ] **Policies.** Skim Meta Developer Content Guidelines and other developer
  policies. No disallowed content in corpus (all problems CC-BY OpenStax or
  definitional).

- [ ] **Asset licences.** See `docs/licences.md` — new section added 19 Oct.
  `chime.mp3`, `webxr.png`, `webxr-banner/banner.gltf`, Havok (unused), IWSDK
  (MIT). All permissive; no GPL/LGPL in tree.

- [ ] **Freeze scope 4 Nov.** Still unbuilt from the plan: auto+guided replay,
  trust card, field arrows with hand probe, sound, value dial, on-part
  readouts. Judging rewards design + technical quality + polish — finish a few
  properly rather than starting all thinly. Cut order: AI prompt layer →
  multi-path UI → cavity flagship demo → free-bench solver (keep precompiled
  traces).

---

## 3. Hosting (IWSDK links allowed)

The competition explicitly permits:
> "Built with IWSDK (WebXR): see Deploying to GitHub Pages for how to share a
> link. You may also use your preferred hosting solution (e.g. Vercel, Digital
> Ocean, AWS, Azure)."

- [ ] **Deploy to an HTTPS link.** This repo deploys to GitHub Pages on every
  push via `.github/workflows/deploy.yml`. Alternative hosts that also satisfy
  the requirement: Vercel, Netlify, Cloudflare Pages. All are subpath-safe
  because `vite.config.ts` uses `base: './'` and `src/physics/kernel.ts` loads
  `physics/*` relative to `import.meta.env.BASE_URL`.

- [ ] **Deploy workflow exists.** `/.github/workflows/deploy.yml` builds and
  deploys on every push to `main` and `arena/*`. No build machine needed at the
  café. Requires Pages enabled once: **Settings → Pages → Source: GitHub
  Actions**. Verify the first run goes green.

- [ ] **Test the live link** in a fresh browser profile, on another network,
  on a Quest browser if possible, with no login and no console errors.
  Checklist: `kb.json` contentHash matches `problems.json`, 24 specs present,
  no `sk-*` in bundle, `physics/` loads without 404.

- [ ] **Keep it online through judging.** Winners ~11 Dec; do not touch Pages
  settings until then. Avoid force-pushing after submission — judging uses state
  at deadline.

- [ ] **Tag the submitted version** (e.g. `git tag submission && git push origin submission`).
  Nothing can change after deadline; a tag is the auditable snapshot.

- [ ] **Keep API keys out of the bundle.** `src/ff/ai-config.ts` explains the
  two supported shapes (proxy or user-pasted localStorage). The deploy workflow
  checks the bundle for `sk-` and fails if found. The `physics:export` bundle
  never contains keys.

Deployment details:

```
kernel/ (Python, build-time) ── ff export ──▶ web/public/physics/{kb.json,problems.json,specs/*.json}
web/    (TypeScript, Vite)   ── npm run build ──▶ web/dist   ──▶ GitHub Pages
                ▲ prebuild runs: tsc --noEmit + verify:kernel (cross-checks Python↔TS math to 1e-9)
```

`SymPy` never ships. The browser evaluator is ~200 lines (`src/physics/kernel.ts`).

---

## 4. Demo video (< 3 min)

- [ ] **Footage:** headset, XR Simulator, or emulator is accepted. Use real
  footage — judges are told not to reward AI-generated pitch video.

- [ ] **Upload to YouTube or Vimeo as public** and paste link into Devpost form.

- [ ] **Lead with the best 20 s.** Judges don't have to watch past 3 min.
  Suggested spine: pinch-to-wire (5 s), current dots flowing (5 s), cited
  derivation → answer (10 s), voiceover: "no AI computes the answer."

- [ ] **Show the story:** wiring by hand, current flowing, cited derivation,
  and the "not a wrapper" proof (toggle AI off, bench still works).

- [ ] **Record by 12 Nov** so there's time to redo.

---

## 5. Devpost form

- [ ] Submission name.
- [ ] Tagline (≤ 140 chars).
- [ ] Track and division.
- [ ] Description (≈ 500 words): inspiration, how it was built, and future plans.
      Include take-it-away sentence and contentHash provenance line:
      *"Knowledge base verified — 6/6 checks, 24 problems, hash {contentHash}."*
- [ ] Hand interactions (marked optional): write it anyway, since hands-first is
      the competition theme. Name: pinch-to-wire, palm-up shelf, hand-as-probe.
- [ ] Target launch date, if not yet published.
- [ ] Team members: name, email, role for each.
- [ ] Links: app link + video link (both public, no login).
- [ ] Special awards: 25k prizes such as Best Agentic Interaction, Best First
      Five Minutes, Best Accessibility Forward. Read criteria on Special Awards
      tab. An agent-facing interface could fit Agentic if time permits (MCP
      server §6.2 remains unbuilt).

---

## 6. Schedule

| By | Work | Gate |
|----|------|------|
| 22 Oct | Start application, Devpost registration, age/rules check | Eligible to compete |
| 26 Oct | Deploy pipeline live with current build | `https://kashimora798.github.io/pysim/` returns 200, no console errors |
| 31 Oct | **Device gate** — decide if field arrows/probe ship or auto-play only | Quest or Start-community tester secured? |
| 4 Nov | Scope freeze | No new features after this |
| 5–11 Nov | Build, polish, sound, performance + room test | 60 fps, zero known crash |
| 12 Nov | Video recorded | Upload ready |
| 13–15 Nov | Form drafted, links tested in private window, version tagged | Dry-run submit |
| **16 Nov** | **Submit** | Submission tag pushed |
| 17–18 Nov | Buffer only | No code changes |

If a headset is not handy, ask in the Start community for a tester. A 60 fps
claim is hard to back up from an emulator alone — set budget now (≤50k tris,
one draw call for wires, one for field arrows, no shadows/post, pooled meshes)
and ship a frame-time HUD in week 1.

---

## 7. Quick verification (run anywhere)

```bash
# Python kernel
pip install -e ".[dev]"
python -m kernel.cli audit --coverage   # 0 errors, 24/24 resolved & agreeing
python -m kernel.cli export             # writes web/public/physics/

# Browser bundle
cd web && npm ci
npm run typecheck
npm run verify:kernel                    # Python↔TS evaluator to 1e-9
npm run build                            # → dist/

# Secret hygiene
! grep -R "sk-" web/public/physics web/dist 2>/dev/null
```

---

## Appendix: FieldForge one-liners for copy

- Tagline (≤140c): *"A physics bench on your desk: wire a circuit by hand, watch the current flow, every answer cites the law that proved it."*
- Take-it-away proof: *"Remove every network call and the bench, solver and 24 verified problems still work — the model never computes."*
- Why VR: *"Your hand is the field probe; a vector blooms at your fingertip — only possible in XR."*
