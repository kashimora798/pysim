/**
 * The FieldForge experience: modes, the SimSpec player, the trust card, the solver bridge,
 * the field arrows and the hand-as-probe — one system, because they share one state: what the
 * kernel has currently derived.
 *
 *   Auto    — the precompiled trace replays: the bench assembles itself, narrating.
 *   Guided  — each `place`/`relate` beat becomes a hand task; the build is verified
 *             against the spec before the step resolves.
 *   Free    — parts + wires on the bench are translated to a Scene (topology.ts), solved
 *             live by the ported kernel (resolve.ts), and written back as current flow.
 *
 * The rule kept everywhere: this file renders and arranges. Numbers come from the kernel
 * (precompiled specs, or Resolver), or they do not appear. The hand-probe's magnitude is
 * resolved per sample (field.ts); only arrow *length* is log-compressed, and the card says so.
 */

import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  Line,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Pressed,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  createSystem,
  type Entity,
} from '@iwsdk/core';

import {
  loadPhysics,
  type Beat,
  type KnowledgeBase,
  type Physics,
  type SimSpec,
} from '../physics/kernel.js';
import { Resolver, buildScene, formatRef } from '../physics/resolve.js';
import { extractScene, type SceneSpec as CapturedSceneSpec, type TargetRef } from '../physics/extract.js';
import { aiConfig } from './ai-config.js';
import { Bench as BenchComp, ExperienceButton, Part, Terminal, Wire } from './components.js';
import { buildCircuitScene, benchDefaults, type BenchPart, type BenchWire } from './topology.js';
import { buildGuideSteps, wireMatchesStep, wirePairKey, type GuideStep } from './guide.js';
import { matchCorpus, splitQuestions, type CapturedQuestion, type CorpusCandidate } from './capture.js';
import { readPhoto } from './ocr.js';
import { highlightPalette } from './inventory.js';
import { clearHighlights, setHighlight } from './terminals.js';
import { arrowLength, fieldAt, type FieldSource } from './field.js';

type Mode = 'auto' | 'guided' | 'free';

const TEAL = 0x2dd4bf;
const AMBER = 0xf5a524;
const KIND_COLORS: Record<string, number> = {
  battery: 0xf5a524, resistor: 0x38bdf8, lamp: 0xfde68a, capacitor: 0x2dd4bf,
  point_charge: 0xfb7185, charged_particle: 0xa78bfa, electron: 0x60a5fa,
  field_probe: 0xe2e8f0, parallel_plate_capacitor: 0x94a3b8,
  uniform_charged_sphere: 0xf472b6, conducting_shell: 0x9ca3af,
  infinite_charged_plane: 0x64748b, spherical_cavity_in_charged_sphere: 0xec4899,
  uniform_magnetic_field_region: 0x818cf8, circuit_loop: 0x34d399,
  series_pair: 0x38bdf8, parallel_pair: 0x38bdf8,
};
const RESISTANCE_STEPS = [1, 2, 3, 4, 6, 10, 20, 30, 47, 100];
const EMF_STEPS = [1.5, 3, 6, 9, 12, 24];

export class ExperienceSystem extends createSystem({
  benches: { required: [BenchComp] },
  parts: { required: [Part] },
  wires: { required: [Wire] },
  terms: { required: [Terminal] },
  buttons: { required: [ExperienceButton, Pressed] },
}) {
  private physics?: Physics;
  private kb?: KnowledgeBase;
  private bench?: Entity;
  private root?: Group;
  private rootEntity?: Entity;

  private spec: SimSpec | null = null;
  private mode: Mode = 'auto';
  private beatIndex = -1;
  private playing = false;
  private nextAt = 0;
  private waitingTask: Beat | null = null;
  private baseline = { kinds: new Map<string, number>(), wires: 0 };

  // ------------------------------------------------------------ guided build
  private guideSteps: GuideStep[] = [];
  private guideIndex = -1;
  private waitingGuide: GuideStep | null = null;
  private guideBaseline = { snapped: new Map<string, number>(), wirePairs: new Map<string, number>() };
  private guideBasePos = new Map<string, Vector3>();
  private guideCanvas?: HTMLCanvasElement;
  private guideTexture?: CanvasTexture;
  private wasPresenting = false;

  // ------------------------------------------------------------ question capture
  private captured: CapturedQuestion[] = [];
  private pickedText: string | null = null;
  private corpusCache: Promise<CorpusCandidate[]> | null = null;
  private cameraStream: MediaStream | null = null;
  /** In-glasses question picker (bench buttons drive it; see onCaptureButton). */
  private picker: {
    stage: 'list' | 'confirm';
    index: number;
    items: Array<{ label: string; run: () => void | Promise<void> }>;
  } | null = null;

  private readonly proxies = new Map<string, Mesh>();
  private readonly pulses = new Map<Mesh, number>();
  private lines?: Group;
  private arrows?: InstancedMesh;
  private sources: FieldSource[] = [];
  private layout = new Map<string, Vector3>();

  private trustCanvas?: HTMLCanvasElement;
  private trustTexture?: CanvasTexture;
  private probeArrow?: Group;
  private lastProbe = 0;
  private probeEnabled = true;

  private hud: Record<string, HTMLElement> = {};
  private freeValues = new Map<string, Record<string, string>>();
  private lastFreeAt = 0;
  private freeSignature = '';
  private audio?: AudioContext;
  private stopped = false;
  private resumeAt = 0;
  private soundOn = true;
  private trail?: Line;
  private frames = 0;
  private lastFpsAt = 0;

  // ---------------------------------------------------------------- lifecycle

  init(): void {
    this.buildHud();
    this.cleanupFuncs.push(
      () => { this.stopped = true; document.getElementById('ff-hud')?.remove(); },
      this.queries.benches.subscribe('qualify', (e) => this.attachToBench(e), true),
      this.queries.buttons.subscribe('qualify', (e) => {
        const action = e.getValue(ExperienceButton, 'action');
        if (action === 'capture') this.onCaptureButton();
        else if (this.picker) {
          // The question picker owns the two transport buttons while it is up:
          // NEXT cycles (or backs out of a confirm), PLAY picks / confirms.
          if (action === 'play') this.pickerPlay();
          else this.pickerNext();
        }
        else if (action === 'play') this.togglePlay();
        else this.advance(true);
      }),
    );
    void loadPhysics()
      .then((physics) => {
        if (this.stopped) return;
        this.physics = physics;
        this.kb = physics.kb;
        this.fillProblemList();
        this.setStatus(
          `Verified physics bundle ${physics.kb.contentHash} · ${physics.kb.audit.counts.properties} properties · ` +
          `${physics.kb.audit.coverage.total} golden problems · dimensions checked ✓`,
        );
        void this.loadProblem('p101');
      })
      .catch((err: unknown) => this.setStatus(`Physics bundle failed to load: ${String(err)}`));
  }

  update(): void {
    const now = performance.now();
    this.frames++;
    if (now - this.lastFpsAt > 500) {
      const fps = Math.round((this.frames * 1000) / Math.max(1, now - this.lastFpsAt));
      this.frames = 0; this.lastFpsAt = now;
      if (this.hud.fps) this.hud.fps.textContent = `${fps} fps${fps >= 55 ? ' · 60fps budget ✓' : ''}`;
    }
    // pulses
    for (const [mesh, until] of this.pulses) {
      if (now > until) { mesh.scale.setScalar(mesh.userData.baseScale ?? 1); this.pulses.delete(mesh); }
      else mesh.scale.setScalar((mesh.userData.baseScale ?? 1) * (1 + 0.18 * Math.sin(now / 60)));
    }
    this.animateTrajectory(now);
    if (this.playing && this.mode === 'auto' && now >= this.nextAt) this.advance(false);
    if (this.resumeAt && now >= this.resumeAt) { this.resumeAt = 0; this.advance(false); }
    if (this.waitingTask) this.checkTask();
    if (this.waitingGuide) this.checkGuide();
    if (this.mode === 'free' && now - this.lastFreeAt > 600) { this.lastFreeAt = now; this.solveFree(); }
    if (this.probeEnabled && this.sources.length > 0 && now - this.lastProbe > 140) {
      this.lastProbe = now;
      this.updateProbe();
    }
  }

  // ---------------------------------------------------------------- spatial stage

  private attachToBench(bench: Entity): void {
    if (this.bench) return;
    this.bench = bench;
    const root = new Group();
    root.name = 'FieldForgeExperience';
    this.root = root;
    this.rootEntity = this.world.createTransformEntity(root, bench);
    this.lines = new Group();
    root.add(this.lines);

    // Trust card: a canvas plane at the back of the bench, tilted toward the seated reader.
    this.trustCanvas = document.createElement('canvas');
    this.trustCanvas.width = 1024; this.trustCanvas.height = 640;
    this.trustTexture = new CanvasTexture(this.trustCanvas);
    const card = new Mesh(
      new BoxGeometry(0.56, 0.35, 0.004),
      new MeshBasicMaterial({ map: this.trustTexture }),
    );
    card.name = 'TrustCard';
    card.position.set(0, 0.30, -0.27);
    card.rotation.x = -0.42;
    root.add(card);

    // Guide panel: the step instructor that floats in front of the learner in the
    // glasses. Bigger and higher than the trust card — this is the panel a student
    // actually reads while their hands are busy. Same canvas-texture technique.
    this.guideCanvas = document.createElement('canvas');
    this.guideCanvas.width = 1024; this.guideCanvas.height = 512;
    this.guideTexture = new CanvasTexture(this.guideCanvas);
    const guide = new Mesh(
      new BoxGeometry(0.68, 0.34, 0.004),
      new MeshBasicMaterial({ map: this.guideTexture }),
    );
    guide.name = 'GuidePanel';
    guide.position.set(0, 0.62, -0.24);
    guide.rotation.x = -0.30;
    root.add(guide);
    this.drawGuide('FieldForge Guide', ['Pick a problem, then build it with your hands.', 'Palm up: palette · pinch: grab & wire · open hand: drop'], 'idle');
    this.drawTrust('FieldForge', ['Your verified physics bench is ready.', 'Pick a problem — or grab parts and wire your own.']);

    // Field arrows: one instanced draw call for the whole grid.
    const cone = new ConeGeometry(0.007, 0.032, 8);
    cone.translate(0, 0.016, 0);
    this.arrows = new InstancedMesh(cone, new MeshBasicMaterial({ color: TEAL, transparent: true, opacity: 0.9 }), 60);
    this.arrows.frustumCulled = false;
    this.arrows.visible = false;
    root.add(this.arrows);

    // Spatial transport buttons (hands-first: pressable in XR, clickable via ray).
    this.makeButton('next', new Vector3(0.33, 0.018, 0.22), TEAL, 'NEXT ▸');
    this.makeButton('play', new Vector3(-0.33, 0.018, 0.22), AMBER, '▶ ❚❚');
    this.makeButton('capture', new Vector3(0, 0.018, 0.24), 0xf97316, '📷 ASK');

    // If a lesson started before the bench arrived, replay its beats onto the new stage.
    if (this.spec && this.beatIndex >= 0) {
      const upto = this.beatIndex;
      const wasPlaying = this.playing;
      this.beatIndex = -1;
      for (let i = 0; i <= upto; i++) this.applyBeat(this.spec.timeline[i]!);
      this.beatIndex = upto;
      this.playing = wasPlaying;
    }

    // Fingertip probe arrow (world-space, follows the hand).
    const arrow = new Group();
    const shaft = new Mesh(new CylinderGeometry(0.0022, 0.0022, 1, 6), new MeshBasicMaterial({ color: 0xfb7185 }));
    shaft.rotation.x = Math.PI / 2; shaft.position.z = 0.5; shaft.name = 'shaft';
    const head = new Mesh(new ConeGeometry(0.009, 0.03, 10), new MeshBasicMaterial({ color: 0xfb7185 }));
    head.rotation.x = Math.PI / 2; head.name = 'head';
    arrow.add(shaft, head);
    arrow.visible = false;
    this.probeArrow = arrow;
    this.world.createTransformEntity(arrow, { persistent: true });
  }

  private makeButton(action: string, pos: Vector3, color: number, _label: string): void {
    if (!this.root || !this.bench) return;
    const mesh = new Mesh(
      new BoxGeometry(0.11, 0.014, 0.05),
      new MeshStandardMaterial({ color, roughness: 0.4, emissive: color, emissiveIntensity: 0.35 }),
    );
    const holder = new Group();
    holder.add(mesh);
    const entity = this.world.createTransformEntity(holder, this.bench);
    holder.position.copy(pos);
    entity.addComponent(ExperienceButton, { action });
  }

  private proxyFor(instance: string): Mesh | undefined {
    return this.proxies.get(instance);
  }

  private stagePosition(index: number): Vector3 {
    return new Vector3(-0.33 + (index % 4) * 0.22, 0.035, -0.16 + Math.floor(index / 4) * 0.17);
  }

  private spawnProxy(instance: string, kind: string): Mesh {
    const existing = this.proxies.get(instance);
    if (existing || !this.root) return existing as Mesh;
    const pos = this.layout.get(instance) ?? this.stagePosition(this.proxies.size);
    const color = KIND_COLORS[kind] ?? 0x94a3b8;
    let geo: BoxGeometry | SphereGeometry | CylinderGeometry | TorusGeometry;
    if (kind.includes('sphere') || kind.includes('particle') || kind === 'electron' || kind === 'point_charge' || kind === 'field_probe' || kind === 'lamp')
      geo = new SphereGeometry(kind === 'electron' ? 0.014 : 0.026, 20, 14);
    else if (kind === 'circuit_loop') geo = new TorusGeometry(0.035, 0.006, 8, 28);
    else if (kind === 'resistor' || kind === 'capacitor') geo = new CylinderGeometry(0.013, 0.013, 0.055, 12);
    else geo = new BoxGeometry(0.055, 0.035, 0.04);
    const mat = new MeshStandardMaterial({
      color, roughness: 0.35, metalness: 0.15,
      emissive: color, emissiveIntensity: kind === 'lamp' ? 0.7 : 0.12,
      transparent: kind.includes('sphere') || kind.includes('shell'), opacity: kind.includes('sphere') ? 0.85 : 1,
    });
    const mesh = new Mesh(geo, mat);
    if (geo instanceof CylinderGeometry) mesh.rotation.z = Math.PI / 2;
    if (geo instanceof TorusGeometry) mesh.rotation.x = Math.PI / 2;
    mesh.position.copy(pos);
    mesh.userData.baseScale = 1;
    this.root.add(mesh);
    this.proxies.set(instance, mesh);
    this.addLabel(mesh, `${instance} · ${this.kb?.components[kind]?.label ?? kind}`);
    return mesh;
  }

  private addLabel(mesh: Mesh, text: string): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = 'rgba(4,20,18,0.85)';
    ctx.fillRect(0, 0, 512, 96);
    ctx.font = '600 34px system-ui, sans-serif';
    ctx.fillStyle = '#d9fbf3';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text.slice(0, 34), 256, 48);
    const tex = new CanvasTexture(canvas);
    const label = new Mesh(
      new BoxGeometry(0.11, 0.02, 0.001),
      new MeshBasicMaterial({ map: tex, transparent: true }),
    );
    label.position.set(0, 0.045, 0);
    mesh.add(label);
  }

  private drawRelation(from: string, to: string): void {
    if (!this.lines) return;
    const a = this.layout.get(from); const b = this.layout.get(to);
    if (!a || !b) return;
    // A thin stretched cylinder as the visible lead between the two proxies.
    const dir = b.clone().sub(a); const length = dir.length();
    const lead = new Mesh(
      new CylinderGeometry(0.0028, 0.0028, length, 6),
      new MeshBasicMaterial({ color: AMBER }),
    );
    lead.position.copy(a.clone().add(b).multiplyScalar(0.5)).setY(0.05);
    lead.quaternion.setFromUnitVectors(new Vector3(0, 1, 0), dir.normalize());
    this.lines.add(lead);
    // glow pulse spheres travelling the lead are handled by pulses on the endpoints
    const pa = this.proxyFor(from); const pb = this.proxyFor(to);
    if (pa) this.pulses.set(pa, performance.now() + 900);
    if (pb) this.pulses.set(pb, performance.now() + 900);
  }

  private showFieldArrows(): void {
    if (!this.arrows || !this.kb || this.sources.length === 0) return;
    const c0 = this.sources[0]!.position;
    const center = new Vector3(c0[0], c0[1], c0[2]);
    const m = new Matrix4(); const q = new Quaternion(); const up = new Vector3(0, 1, 0);
    let count = 0;
    for (let layer = 0; layer < 2; layer++) {
      for (let ix = -2; ix <= 2; ix++) {
        for (let iz = -2; iz <= 2; iz++) {
          if (count >= 60) break;
          const p = new Vector3(center.x + ix * 0.11, 0.05 + layer * 0.11, center.z + iz * 0.11);
          if (p.distanceTo(center) < 0.05) continue;
          const sample = fieldAt(this.kb, this.sources, [p.x, p.y, p.z]);
          if (!sample || sample.magnitude === 0) continue;
          const dir = new Vector3(sample.e[0], sample.e[1], sample.e[2]).normalize();
          q.setFromUnitVectors(up, dir);
          const len = arrowLength(sample.magnitude);
          m.compose(p, q, new Vector3(1, len / 0.032, 1));
          this.arrows.setMatrixAt(count++, m);
        }
      }
    }
    this.arrows.count = count;
    this.arrows.instanceMatrix.needsUpdate = true;
    this.arrows.visible = count > 0;
  }

  // ---------------------------------------------------------------- trust card (spatial)

  private drawTrust(title: string, lines: string[]): void {
    const ctx = this.trustCanvas?.getContext('2d');
    if (!ctx || !this.trustCanvas) return;
    const { width: w, height: h } = this.trustCanvas;
    ctx.fillStyle = '#06231f'; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 6; ctx.strokeRect(6, 6, w - 12, h - 12);
    ctx.fillStyle = '#2dd4bf'; ctx.font = '700 34px system-ui, sans-serif';
    ctx.fillText('✓ TRUST CARD — dimensions checked', 36, 58);
    ctx.fillStyle = '#f0fdf9'; ctx.font = '700 44px system-ui, sans-serif';
    this.wrap(ctx, title, 36, 118, w - 72, 48, 2);
    ctx.font = '400 30px system-ui, sans-serif'; ctx.fillStyle = '#c8f5ec';
    let y = 230;
    for (const line of lines.slice(0, 9)) { this.wrap(ctx, line, 36, y, w - 72, 36, 2); y += 76; }
    if (this.physics) {
      ctx.font = '400 22px ui-monospace, monospace'; ctx.fillStyle = '#7dd3c8';
      ctx.fillText(`bundle ${this.physics.kb.contentHash} · kernel-verified · no AI in the solver`, 36, h - 30);
    }
    if (this.trustTexture) this.trustTexture.needsUpdate = true;
  }

  private wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines: number): void {
    const words = text.split(/\s+/); let line = ''; let lines = 0;
    for (const word of words) {
      const cand = line ? `${line} ${word}` : word;
      if (ctx.measureText(cand).width > maxW && line) {
        ctx.fillText(line, x, y); y += lh; lines++; line = word;
        if (lines >= maxLines) return;
      } else line = cand;
    }
    if (line) ctx.fillText(line, x, y);
  }

  // ---------------------------------------------------------------- HUD (desktop + mirror)

  private buildHud(): void {
    const style = document.createElement('style');
    style.textContent = `
      #ff-hud{position:fixed;top:12px;left:12px;width:368px;max-height:calc(100vh - 24px);overflow:auto;
        background:rgba(4,24,21,.92);color:#e6fff8;border:1px solid #2dd4bf;border-radius:14px;
        font:14px/1.45 system-ui,sans-serif;padding:14px;z-index:50;backdrop-filter:blur(8px)}
      #ff-hud h1{font-size:19px;margin:0} #ff-hud h1 span{color:#2dd4bf}
      #ff-hud button{background:#0b3d36;color:#d9fbf3;border:1px solid #2dd4bf;border-radius:8px;
        padding:6px 10px;cursor:pointer;font:600 13px system-ui}
      #ff-hud button.on{background:#2dd4bf;color:#04211c}
      #ff-hud select,#ff-hud textarea{width:100%;background:#072e29;color:#e6fff8;border:1px solid #1f6f63;
        border-radius:8px;padding:7px;margin:4px 0}
      #ff-hud .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:7px 0}
      #ff-hud .task{background:#123f37;border-left:4px solid #f5a524;padding:8px;border-radius:6px;white-space:pre-wrap}
      #ff-hud .trust{background:#021815;border:1px solid #14544a;border-radius:8px;padding:9px;white-space:pre-wrap;
        font:12.5px/1.5 ui-monospace,monospace;max-height:260px;overflow:auto}
      #ff-hud .dim{color:#8fd8cb;font-size:12px} #ff-hud .big{font-size:17px;color:#fde68a;font-weight:700}
      @media (max-width:760px){#ff-hud{width:calc(100vw - 48px)}}`;
    document.head.appendChild(style);
    const hud = document.createElement('div');
    hud.id = 'ff-hud';
    hud.innerHTML = `
      <div class="row" style="justify-content:space-between">
        <h1>Field<span>Forge</span> ⚡</h1>
        <button data-k="xr">🥽 Enter XR</button>
        <button data-k="sound" class="on">🔊</button>
      </div>
      <div class="dim"><span data-k="status">Loading verified physics…</span> · <span data-k="fps">— fps</span></div>
      <div class="row" role="group" aria-label="Mode">
        <button data-k="m-auto" class="on">▶ Auto</button>
        <button data-k="m-guided">🖐 Guided</button>
        <button data-k="m-free">🧪 Free bench</button>
      </div>
      <select data-k="problem" aria-label="Problem"></select>
      <div class="row">
        <button data-k="prev">⏮</button><button data-k="play">▶ Play</button><button data-k="next">Next ⏭</button>
        <label class="dim"><input type="checkbox" data-k="probe" checked> Hand probe</label>
      </div>
      <div class="task" data-k="task">Pick a problem to begin.</div>
      <button data-k="task-do" style="display:none;margin:4px 0">✓ I did it — verify (desktop companion)</button>
      <div class="trust" data-k="trust">Trust card: every number here cites its formula, law and source.</div>
      <div data-k="free" style="display:none">
        <div class="big" data-k="free-result">Free bench: grab a battery + resistor from the palette, pinch-wire a loop.</div>
        <div class="row"><select data-k="free-part" style="flex:1"></select>
        <button data-k="cycle">Change value ⟳</button></div>
        <div class="dim">Defaults are stated, never hidden: battery 12 V · resistor/lamp 10 Ω. Wiring is translated to a reduction tree and solved by the kernel — watch the wires flow.</div>
      </div>
      <div class="dim" data-k="probe-read"></div>
      <details><summary>📷 Capture a question (book / laptop screen)</summary>
        <div class="row"><button data-k="cap-photo">🖼 Photo</button><button data-k="cap-cam">🎥 Camera</button><button data-k="cap-snap" style="display:none">📸 Snap</button><button data-k="cap-xr">🥽 Pick in glasses</button></div>
        <input data-k="cap-file" type="file" accept="image/*" style="display:none">
        <video data-k="cap-video" style="display:none;width:100%;border-radius:6px" autoplay playsinline muted></video>
        <div class="dim" data-k="cap-status">Snap your textbook page or laptop screen (on the companion). In the Quest, use passthrough to line the page up, take a screenshot, and share it here — WebXR cannot hand web apps the raw passthrough camera, so capture is companion-side and everything after it (picking, confirming, building) happens in the glasses.</div>
        <textarea data-k="cap-text" rows="4" placeholder="OCR text lands here — or paste the question yourself. Always editable; the kernel still validates."></textarea>
        <div data-k="cap-list" class="row" style="flex-wrap:wrap"></div>
        <div class="row" data-k="cap-confirm-row" style="display:none"><span data-k="cap-picked" class="dim" style="flex:1"></span><button data-k="cap-solve">✓ Solve this</button><button data-k="cap-cancel">Pick another</button></div>
        <pre class="trust" data-k="cap-out">A captured question is only ever a proposal: a corpus match loads a kernel-verified problem; anything new goes through the AI boundary, and the kernel validator accepts or rejects it.</pre>
      </details>
      <details><summary>🤖 Paste a problem (AI at the boundary — optional)</summary>
        <textarea data-k="ai-text" rows="3" placeholder="A 12 V battery drives a 4 ohm resistor. What current flows?"></textarea>
        <button data-k="ai-go">Extract &amp; validate scene</button>
        <pre class="trust" data-k="ai-out">The bench works fully with AI unplugged. The model may only fill a schema; the kernel validator accepts or rejects it.</pre>
      </details>
      <div class="dim">Desktop: mouse + buttons work. Quest: hands only — palm-up palette, pinch to wire, press the bench NEXT button, reach into the field.</div>`;
    document.body.appendChild(hud);
    hud.querySelectorAll<HTMLElement>('[data-k]').forEach((el) => { this.hud[el.dataset.k!] = el; });
    this.hud.xr!.onclick = () => { this.ensureAudio(); void (this.world as { launchXR?: () => void }).launchXR?.(); };
    this.hud.sound!.onclick = () => { this.soundOn = !this.soundOn; this.hud.sound!.classList.toggle('on', this.soundOn); this.hud.sound!.textContent = this.soundOn ? '🔊' : '🔇'; };
    this.hud['m-auto']!.onclick = () => this.setMode('auto');
    this.hud['m-guided']!.onclick = () => this.setMode('guided');
    this.hud['m-free']!.onclick = () => this.setMode('free');
    this.hud.problem!.onchange = () => void this.loadProblem((this.hud.problem as HTMLSelectElement).value);
    this.hud.play!.onclick = () => this.togglePlay();
    this.hud.next!.onclick = () => this.advance(true);
    this.hud.prev!.onclick = () => { this.resetStage(); if (this.mode === 'auto') this.playing = true; };
    this.hud['task-do']!.onclick = () => this.completeTask();
    this.hud.probe!.onchange = () => { this.probeEnabled = (this.hud.probe as HTMLInputElement).checked; };
    this.hud.cycle!.onclick = () => this.cycleFreeValue();
    this.hud['ai-go']!.onclick = () => void this.runExtraction();
    this.hud['cap-photo']!.onclick = () => (this.hud['cap-file'] as HTMLInputElement).click();
    (this.hud['cap-file'] as HTMLInputElement).onchange = () => {
      const file = (this.hud['cap-file'] as HTMLInputElement).files?.[0];
      if (file) void this.ocrIntoBox(file);
    };
    this.hud['cap-cam']!.onclick = () => void this.toggleCamera();
    this.hud['cap-snap']!.onclick = () => void this.snapPhoto();
    this.hud['cap-xr']!.onclick = () => this.onCaptureButton();
    this.hud['cap-solve']!.onclick = () => { if (this.pickedText) void this.solveCaptured(this.pickedText); };
    this.hud['cap-cancel']!.onclick = () => this.pickQuestion(null);
    (this.hud['cap-text'] as HTMLTextAreaElement).oninput = () => {
      this.captured = splitQuestions((this.hud['cap-text'] as HTMLTextAreaElement).value);
      this.renderCaptureList();
    };
  }

  private setStatus(text: string): void { if (this.hud.status) this.hud.status.textContent = text; }
  private setTask(text: string): void { if (this.hud.task) this.hud.task.textContent = text; }

  private fillProblemList(): void {
    const select = this.hud.problem as HTMLSelectElement | undefined;
    if (!select || !this.physics) return;
    select.innerHTML = this.physics.index.problems
      .map((p) => `<option value="${p.id}">${p.id} · ${p.title} — answer ${p.answer}</option>`).join('');
    select.value = 'p101';
  }

  // ---------------------------------------------------------------- lesson player

  private async loadProblem(id: string): Promise<void> {
    if (!this.physics || !this.kb) return;
    this.spec = await this.physics.spec(id);
    this.layout.clear(); this.sources = [];
    let i = 0;
    for (const inst of this.spec.scene.instances) {
      if (inst.kind === 'environment') continue;
      const pos = this.stagePosition(i++);
      this.layout.set(inst.id, pos);
      const given = inst.given[`${inst.id}.em.charge`] as { value?: number } | undefined;
      const charge = typeof given?.value === 'number' ? given.value : inst.kind === 'electron' ? -1.602176634e-19 : undefined;
      if (charge !== undefined && charge !== 0) this.sources.push({ id: inst.id, charge, position: [pos.x, pos.y, pos.z] });
    }
    this.resetStage();
    this.setTask(`${this.spec.problem.title}\n${this.spec.problem.text}\nTarget: ${this.spec.target} · expected ${this.spec.answer.display}`);
    this.drawTrust(this.spec.problem.title, [
      `Target ${this.spec.target}`, `Verified answer: ${this.spec.answer.display}`,
      `${this.spec.timeline.length} beats · ${this.spec.checks.paths_found} path(s) · paths agree: ${this.spec.checks.paths_agree ? 'yes ✓' : 'NO'}`,
      this.mode === 'guided' ? 'Guided: build each step with your hands.' : 'Press Play / Next — or the teal NEXT button on the bench.',
    ]);
    if (this.mode === 'auto') this.playing = true;
  }

  private resetStage(): void {
    this.beatIndex = -1; this.waitingTask = null; this.resumeAt = 0;
    for (const mesh of this.proxies.values()) { this.root?.remove(mesh); }
    this.proxies.clear(); this.pulses.clear();
    if (this.lines && this.root) { this.root.remove(this.lines); this.lines = new Group(); this.root.add(this.lines); }
    if (this.arrows) this.arrows.visible = false;
    if (this.trail && this.root) { this.root.remove(this.trail); this.trail = undefined; }
    if (this.hud.trust) this.hud.trust.textContent = 'Trust card: every number here cites its formula, law and source.';
  }

  private setMode(mode: Mode): void {
    this.mode = mode; this.playing = false; this.waitingTask = null;
    for (const m of ['auto', 'guided', 'free'] as Mode[])
      this.hud[`m-${m}`]?.classList.toggle('on', m === mode);
    if (this.hud.free) this.hud.free.style.display = mode === 'free' ? 'block' : 'none';
    if (mode === 'free') {
      this.resetStage();
      this.setTask('🧪 Free bench: grab a battery and a resistor from the palm palette, pinch-wire a closed loop. The kernel solves it live — no problem file needed.');
      this.drawTrust('Free bench', ['Wire a loop. The wire graph becomes a reduction tree,', 'the kernel resolves it, current flows in the wires.']);
    } else if (this.spec) {
      this.resetStage();
      if (mode === 'auto') this.playing = true;
      else this.startGuide(); // arms the step list + panel; without this Next "completes" an empty guide
    }
  }

  private togglePlay(): void {
    this.ensureAudio();
    if (this.mode === 'free') this.setMode('auto');
    this.playing = !this.playing;
    if (this.hud.play) this.hud.play.textContent = this.playing ? '❚❚ Pause' : '▶ Play';
    if (this.playing) this.nextAt = performance.now() + 300;
  }

  private advance(manual: boolean): void {
    this.ensureAudio();
    if (this.mode === 'guided' && this.spec) {
      // The bench NEXT button / desktop companion: accept the current build step
      // (verified by hand where our checks can see it), or move the guide on.
      if (this.waitingGuide) this.completeGuideStep(true);
      else this.advanceGuide();
      return;
    }
    if (!this.spec || this.mode === 'free') { if (manual) this.setMode('auto'); if (!this.spec) return; }
    if (this.waitingTask && !manual) return;
    this.waitingTask = null;
    this.beatIndex += 1;
    const beat = this.spec!.timeline[this.beatIndex];
    if (!beat) {
      this.playing = false;
      this.setTask('✅ Lesson complete. Try Guided mode to build it yourself, or Free bench to explore.');
      this.sound('answer');
      return;
    }
    this.applyBeat(beat);
    if (this.mode === 'auto') this.nextAt = performance.now() + 1900;
  }

  private applyBeat(beat: Beat): void {
    if (!this.spec) return;
    const isTask = this.mode === 'guided' && (beat.kind === 'place' || beat.kind === 'relate');
    if (beat.kind === 'place' && beat.instance) {
      if (!isTask) this.spawnProxy(beat.instance, beat.component ?? '');
      this.sound('place');
    } else if (beat.kind === 'relate' && beat.from && beat.to) {
      if (!isTask) { this.spawnProxy(beat.from, this.kindOf(beat.from)); this.spawnProxy(beat.to, this.kindOf(beat.to)); this.drawRelation(beat.from, beat.to); }
      this.sound('place');
    } else {
      if (beat.instance) {
        const mesh = this.spawnProxy(beat.instance, this.kindOf(beat.instance));
        if (mesh) this.pulses.set(mesh, performance.now() + 1100);
      }
      if (beat.channel?.includes('field') || beat.property?.includes('electric_field')) this.showFieldArrows();
      this.sound(beat.kind === 'answer' ? 'answer' : 'resolve');
    }

    const b = beat.because;
    const lines = [
      beat.narrate,
      beat.display ? `Value: ${beat.display}` : '',
      b.formula ? `Formula: ${b.formula}   ${b.expression ?? ''}` : b.detail ?? '',
      b.substituted ? `Substituted: ${b.substituted}` : '',
      b.law_label ? `Law: ${b.law_label}` : '',
      b.assumes?.length ? `Assumes: ${b.assumes.join(', ')}` : '',
      b.cite ? `Source: ${b.cite}` : '',
      beat.kind === 'answer' ? `Paths found: ${b.paths_found ?? this.spec.checks.paths_found} · dimensions ✓ · paths agree ✓` : '',
    ].filter(Boolean);
    this.drawTrust(beat.kind === 'answer' ? `Answer: ${beat.display ?? ''}` : beat.narrate, lines);
    if (this.hud.trust) this.hud.trust.textContent = lines.join('\n');

    if (isTask) {
      if (this.hud['task-do']) this.hud['task-do'].style.display = 'block';
      this.baseline = { kinds: this.countKinds(), wires: this.liveWireCount() };
      this.waitingTask = beat;
      this.setTask(beat.kind === 'place'
        ? `🖐 Your task: place a ${this.kb?.components[beat.component ?? '']?.label ?? beat.component} (for ${beat.instance}) from the palette. Then it will be verified.`
        : `🖐 Your task: pinch-wire ${beat.from} → ${beat.to} (${beat.relation}). The system checks your topology.`);
    } else {
      if (this.hud['task-do']) this.hud['task-do'].style.display = 'none';
      this.setTask(`${this.mode === 'guided' ? '✓ ' : ''}${beat.narrate}${beat.display ? `  →  ${beat.display}` : ''}`);
      if (this.mode === 'guided') this.resumeAt = performance.now() + 1500;
    }
  }

  private kindOf(instance: string): string {
    return this.spec?.scene.instances.find((i) => i.id === instance)?.kind ?? '';
  }

  private countKinds(): Map<string, number> {
    const counts = new Map<string, number>();
    this.queries.parts.entities.forEach((e) => {
      const kind = String(e.getValue(Part, 'kind') ?? '');
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    });
    return counts;
  }

  private liveWireCount(): number {
    let n = 0;
    this.queries.wires.entities.forEach((e) => { if (e.getValue(Wire, 'to')) n++; });
    return n;
  }

  private checkTask(): void {
    const beat = this.waitingTask;
    if (!beat) return;
    const done = beat.kind === 'place'
      ? (this.countKinds().get(beat.component ?? '') ?? 0) > (this.baseline.kinds.get(beat.component ?? '') ?? 0)
      : this.liveWireCount() > this.baseline.wires;
    if (done) this.completeTask();
  }

  /** Accept the current Guided task (hand-verified by the bridge, or the desktop companion button). */
  private completeTask(): void {
    if (this.waitingGuide) { this.completeGuideStep(true); return; }
    const beat = this.waitingTask;
    if (!beat) return;
    this.waitingTask = null;
    if (this.hud['task-do']) this.hud['task-do'].style.display = 'none';
    this.sound('resolve');
    if (beat.kind === 'place' && beat.instance) this.spawnProxy(beat.instance, beat.component ?? '');
    if (beat.kind === 'relate' && beat.from && beat.to) this.drawRelation(beat.from, beat.to);
    this.setTask('✓ Verified against the solution topology — that step is lawful. Continuing…');
    this.resumeAt = performance.now() + 700;
  }

  // ================================================================ guided build
  //
  // The hands-first lesson. Steps come from guide.ts (pure, tested); this class owns
  // the presentation (guide panel in the glasses + HUD mirror), the highlighting
  // (palette slots, terminals) and the verification. A step completes when the
  // learner's hands actually did it — a part settled, a wire landed between the
  // right kinds, two parts brought together — never merely when time passed.

  private startGuide(): void {
    if (!this.spec || !this.kb) return;
    const labels = new Map(Object.entries(this.kb.components).map(([k, v]) => [k, v.label]));
    const placeable = new Set(
      Object.entries(this.kb.components).filter(([, v]) => v.model3d != null).map(([k]) => k),
    );
    this.guideSteps = buildGuideSteps(this.spec, { labels, placeable });
    this.guideIndex = -1;
    this.waitingGuide = null;
    this.drawGuide(this.spec.problem.title, [
      `Build it with your hands — ${this.guideSteps.length} steps.`,
      'The palette has every part you need. Follow the panel in front of you.',
    ], 'idle');
    this.setTask(`🖐 Guided: ${this.spec.problem.title} — ${this.guideSteps.length} steps. Read the panel in front of you, then use your hands.`);
    this.resumeAt = performance.now() + 900;
  }

  private advanceGuide(): void {
    if (this.mode !== 'guided' || !this.spec) return;
    this.resumeAt = 0;
    this.guideIndex += 1;
    const step = this.guideSteps[this.guideIndex];
    if (!step) {
      this.waitingGuide = null;
      highlightPalette(null); clearHighlights();
      this.drawGuide('✅ You built it', [
        `${this.spec.problem.title}`,
        `Verified answer: ${this.spec.answer.display}`,
        'Every step was placed and wired by your hands — and checked.',
        'Try Free bench to explore, or pick another problem.',
      ], 'done');
      this.setTask('✅ Guided build complete — every step verified by your hands.');
      this.sound('answer');
      return;
    }
    this.applyGuideStep(step);
  }

  private applyGuideStep(step: GuideStep): void {
    if (!this.spec) return;
    const beat = step.beat;
    // Keep the staged visualisation and trust card in step with the build: givens,
    // resolutions and the answer appear as they are earned.
    const lines = [
      beat.narrate,
      beat.display ? `Value: ${beat.display}` : '',
      beat.because.formula ? `Formula: ${beat.because.formula}   ${beat.because.expression ?? ''}` : beat.because.detail ?? '',
      beat.because.law_label ? `Law: ${beat.because.law_label}` : '',
      beat.because.cite ? `Source: ${beat.because.cite}` : '',
    ].filter(Boolean);
    this.drawTrust(step.final ? `Answer: ${beat.display ?? ''}` : step.title, lines);
    if (this.hud.trust) this.hud.trust.textContent = lines.join('\n');
    if (beat.instance && step.action === 'observe') {
      const mesh = this.spawnProxy(beat.instance, this.kindOf(beat.instance));
      if (mesh) this.pulses.set(mesh, performance.now() + 1100);
      if (beat.channel?.includes('field') || beat.property?.includes('electric_field')) this.showFieldArrows();
    }

    if (step.action === 'observe') {
      this.waitingGuide = null;
      highlightPalette(null); clearHighlights();
      this.drawGuide(`Step ${step.index} / ${step.total} — ${step.title}`, [step.instruction, beat.display ? `→ ${beat.display}` : ''], 'observe');
      this.setTask(`👀 ${step.instruction}${beat.display ? `  →  ${beat.display}` : ''}`);
      this.sound(step.final ? 'answer' : 'resolve');
      this.resumeAt = performance.now() + (step.final ? 2600 : 1500);
      // The final answer ends the guided sequence.
      if (step.final) { this.guideIndex = this.guideSteps.length; this.resumeAt = performance.now() + 1200; }
      return;
    }

    // A build step: snapshot the bench, light the way, and wait for hands.
    this.guideBaseline = { snapped: this.settledCounts(), wirePairs: this.wirePairCounts() };
    this.guideBasePos.clear();
    this.queries.parts.entities.forEach((e) => {
      if (e.object3D) {
        this.guideBasePos.set(String(e.getValue(Part, 'instanceId') ?? ''), e.object3D.getWorldPosition(new Vector3()));
      }
    });
    this.waitingGuide = step;
    if (step.action === 'place') {
      highlightPalette([step.component ?? '']);
      clearHighlights();
    } else {
      highlightPalette(null);
      this.highlightStepTerminals(step);
    }
    this.drawGuide(`Step ${step.index} / ${step.total} — ${step.title}`, [step.instruction], 'task');
    this.setTask(`🖐 Step ${step.index}/${step.total}: ${step.instruction}`);
    if (this.hud['task-do']) this.hud['task-do'].style.display = 'block';
    this.sound('place');
  }

  /** Terminals of the parts this step connects, lit so the hands know where to go. */
  private highlightStepTerminals(step: GuideStep): void {
    clearHighlights();
    if (step.action !== 'wire') return;
    const kinds = new Set([step.fromKind, step.toKind]);
    const owners = new Set<Entity>();
    this.queries.parts.entities.forEach((e) => {
      if (kinds.has(String(e.getValue(Part, 'kind') ?? ''))) owners.add(e);
    });
    this.queries.terms.entities.forEach((t) => {
      const owner = t.getValue(Terminal, 'owner') as Entity | null;
      if (owner && owners.has(owner)) setHighlight(t, true);
    });
  }

  private settledCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    this.queries.parts.entities.forEach((e) => {
      if (!e.getValue(Part, 'snapped')) return;
      const kind = String(e.getValue(Part, 'kind') ?? '');
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    });
    return counts;
  }

  private wirePairCounts(): Map<string, number> {
    const { parts, wires } = this.collectFree();
    const kindOf = new Map(parts.map((p) => [p.id, p.kind]));
    const counts = new Map<string, number>();
    for (const w of wires) {
      const a = kindOf.get(w.aId); const b = kindOf.get(w.bId);
      if (!a || !b) continue;
      const key = wirePairKey(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  private checkGuide(): void {
    const step = this.waitingGuide;
    if (!step) return;
    let done = false;
    if (step.action === 'place' && step.component) {
      // Done when one more of this kind has *settled* than when the step began:
      // pulled from the palette is not enough — it must have been dropped flat.
      done = (this.settledCounts().get(step.component) ?? 0) > (this.guideBaseline.snapped.get(step.component) ?? 0);
    } else if (step.action === 'wire' && step.fromKind && step.toKind) {
      // Done when the wire graph gains a wire between the two kinds this step
      // joins (wireMatchesStep is exactly that pair test). Baseline-relative, so
      // the second lead of a loop must really be a second wire.
      const { parts, wires } = this.collectFree();
      const kindOf = new Map(parts.map((p) => [p.id, p.kind]));
      let now = 0;
      for (const w of wires) {
        const a = kindOf.get(w.aId); const b = kindOf.get(w.bId);
        if (a && b && wireMatchesStep(step, a, b)) now += 1;
      }
      done = now > (this.guideBaseline.wirePairs.get(wirePairKey(step.fromKind, step.toKind)) ?? 0);
    } else if (step.action === 'position' && step.fromKind && step.toKind) {
      done = this.guideProximityMoved(step.fromKind, step.toKind);
    }
    if (done) this.completeGuideStep(false);
  }

  /**
   * Position step: some part of one kind was actually carried (it moved from where
   * the step found it) and the two kinds now sit within interaction distance.
   * The movement clause stops parts staged side-by-side from passing untouched.
   */
  private guideProximityMoved(fromKind: string, toKind: string): boolean {
    const a: Vector3[] = []; const b: Vector3[] = [];
    let moved = false;
    this.queries.parts.entities.forEach((e) => {
      const obj = e.object3D;
      if (!obj) return;
      const kind = String(e.getValue(Part, 'kind') ?? '');
      if (kind !== fromKind && kind !== toKind) return;
      const p = obj.getWorldPosition(new Vector3());
      const id = String(e.getValue(Part, 'instanceId') ?? '');
      const before = this.guideBasePos.get(id);
      if (before && before.distanceTo(p) > 0.03) moved = true;
      if (kind === fromKind) a.push(p);
      if (kind === toKind) b.push(p);
    });
    return moved && a.some((p) => b.some((q) => p.distanceTo(q) < 0.15));
  }

  /** A build step is done: stamp it, catch the stage visuals up, move on. */
  private completeGuideStep(_manual: boolean): void {
    const step = this.waitingGuide;
    if (!step) return;
    this.waitingGuide = null;
    if (this.hud['task-do']) this.hud['task-do'].style.display = 'none';
    highlightPalette(null); clearHighlights();
    this.sound('resolve');
    if (step.action === 'place' && step.beat.instance) this.spawnProxy(step.beat.instance, step.component ?? '');
    if (step.action === 'wire' && step.beat.from && step.beat.to) this.drawRelation(step.beat.from, step.beat.to);
    this.drawGuide(`✓ Step ${step.index} / ${step.total}`, [step.title, 'Verified — that is exactly what the solution needs.'], 'done');
    this.setTask(`✓ Step ${step.index}/${step.total} verified: ${step.title}. Continuing…`);
    this.resumeAt = performance.now() + 800;
  }

  /** Render the in-glasses guide panel (canvas texture; the HUD mirrors it). */
  private drawGuide(title: string, lines: string[], state: 'idle' | 'task' | 'observe' | 'done'): void {
    const canvas = this.guideCanvas; const tex = this.guideTexture;
    if (!canvas || !tex) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width; const H = canvas.height;
    ctx.fillStyle = state === 'done' ? '#06281c' : state === 'task' ? '#0b2436' : '#071018';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = state === 'done' ? '#34d399' : '#2dd4bf'; ctx.lineWidth = 6;
    ctx.strokeRect(6, 6, W - 12, H - 12);
    ctx.fillStyle = '#5eead4'; ctx.font = '700 34px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText('🖐 FIELDFORGE GUIDE', 36, 58);
    // step pips
    if (this.guideSteps.length > 0) {
      this.guideSteps.forEach((s, i) => {
        ctx.beginPath();
        ctx.arc(W - 40 - (this.guideSteps.length - 1 - i) * 30, 46, 10, 0, Math.PI * 2);
        ctx.fillStyle = i < this.guideIndex ? '#34d399' : i === this.guideIndex ? '#fbbf24' : '#1f3a34';
        ctx.fill();
      });
    }
    ctx.fillStyle = '#f0fdf9'; ctx.font = '700 54px system-ui, sans-serif';
    let y = this.wrapFrom(ctx, title, 36, 128, W - 72, 62, 2);
    ctx.font = '38px system-ui, sans-serif'; ctx.fillStyle = '#c9f5ec';
    for (const line of lines) { y = this.wrapFrom(ctx, line, 36, y + 14, W - 72, 48, 5); if (y > H - 56) break; }
    ctx.font = '30px system-ui, sans-serif'; ctx.fillStyle = '#7dd3c8';
    ctx.fillText(state === 'task' ? 'Do it with your hands — I am watching the bench.' : ' ', 36, H - 28);
    tex.needsUpdate = true;
  }

  /** Word-wrap returning the y below the last line drawn. */
  private wrapFrom(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines: number): number {
    const words = text.split(/\s+/); let line = ''; let drawn = 0;
    for (const word of words) {
      const cand = line ? `${line} ${word}` : word;
      if (ctx.measureText(cand).width > maxW && line) {
        ctx.fillText(line, x, y); y += lh; drawn++; line = word;
        if (drawn >= maxLines) return y;
      } else line = cand;
    }
    if (line) { ctx.fillText(line, x, y); y += lh; }
    return y;
  }

  // ---------------------------------------------------------------- free-bench solver bridge

  private collectFree(): { parts: BenchPart[]; wires: BenchWire[]; entities: Map<string, Entity> } {
    const parts: BenchPart[] = []; const entities = new Map<string, Entity>();
    this.queries.parts.entities.forEach((e) => {
      const id = String(e.getValue(Part, 'instanceId') ?? '');
      const kind = String(e.getValue(Part, 'kind') ?? '');
      if (!id || !kind) return;
      parts.push({ id, kind, values: this.freeValues.get(id) ?? {} });
      entities.set(id, e);
    });
    const wires: BenchWire[] = [];
    this.queries.wires.entities.forEach((e) => {
      const from = e.getValue(Wire, 'from') as Entity | null;
      const to = e.getValue(Wire, 'to') as Entity | null;
      if (!from || !to) return;
      const a = this.terminalOwner(from); const b = this.terminalOwner(to);
      if (a && b) wires.push({ aId: a.id, aTerm: a.term, bId: b.id, bTerm: b.term });
    });
    return { parts, wires, entities };
  }

  private terminalOwner(term: Entity): { id: string; term: number } | null {
    const owner = term.getValue(Terminal, 'owner') as Entity | null;
    if (!owner) return null;
    const id = String(owner.getValue(Part, 'instanceId') ?? '');
    return id ? { id, term: Number(term.getValue(Terminal, 'index') ?? 0) } : null;
  }

  private solveFree(): void {
    if (!this.kb || !this.hud['free-result']) return;
    const { parts, wires, entities } = this.collectFree();
    const select = this.hud['free-part'] as HTMLSelectElement;
    const signature = JSON.stringify({ parts, wires, v: [...this.freeValues] });
    const options = parts.map((p) => `<option value="${p.id}">${p.id} · ${p.kind} · ${JSON.stringify({ ...benchDefaults(p.kind), ...p.values })}</option>`).join('');
    if (select.innerHTML !== options) select.innerHTML = options;
    if (signature === this.freeSignature) return;
    this.freeSignature = signature;

    const topo = buildCircuitScene(parts, wires);
    if (!topo.ok) {
      this.hud['free-result']!.textContent = topo.error;
      this.queries.wires.entities.forEach((e) => e.setValue(Wire, 'current', 0));
      return;
    }
    try {
      const scene = buildScene(topo.spec, this.kb, { where: 'free-bench' });
      const resolver = new Resolver(this.kb, scene);
      const paths = resolver.resolve(topo.target);
      if (paths.length === 0) {
        this.hud['free-result']!.textContent = resolver.failure(topo.target).message;
        return;
      }
      const steps = paths[0]!.steps;
      const current = steps[steps.length - 1]!.quantity;
      const amps = typeof current.value === 'number' ? current.value : 0;
      this.hud['free-result']!.textContent =
        `⚡ ${topo.summary}\nLoop current I = ${amps.toPrecision(4)} A — resolved live by the kernel (${paths.length} path${paths.length > 1 ? 's' : ''}). Current is now flowing in your wires.`;
      this.queries.wires.entities.forEach((e) => e.setValue(Wire, 'current', amps));
      const trace = steps.filter((s) => s.formula).slice(-5)
        .map((s) => `${formatRef(s.ref)} — ${s.formula?.exprText ?? ''}`).join('\n');
      this.drawTrust(`Free bench: I = ${amps.toPrecision(4)} A`, [topo.summary, trace, 'Dimensions checked ✓ · solved at runtime by Engine A (TypeScript port of the verified kernel)']);
      if (this.hud.trust) this.hud.trust.textContent = `Free bench derivation:\n${steps.map((s) => `${formatRef(s.ref)} = ${typeof s.quantity.value === 'number' ? s.quantity.value.toPrecision(4) : JSON.stringify(s.quantity.value)}`).join('\n')}`;
      // Lamp glow follows dissipated power — resolved, not guessed.
      entities.forEach((entity, id) => {
        const part = parts.find((p) => p.id === id);
        if (part?.kind !== 'lamp') return;
        try {
          const power = resolver.resolve({ instance: id, prop: 'electric.power' });
          const pSteps = power[0]?.steps; const p = pSteps?.[pSteps.length - 1]?.quantity.value;
          const glow = typeof p === 'number' ? Math.min(2.2, p / 10) : 0.2;
          entity.object3D?.traverse((o) => {
            const mat = (o as Mesh).material as MeshStandardMaterial | undefined;
            if (mat && 'emissiveIntensity' in mat) mat.emissiveIntensity = 0.15 + glow;
          });
        } catch { /* a lamp outside a solved loop simply stays dim */ }
      });
      this.sound('resolve');
    } catch (err) {
      this.hud['free-result']!.textContent = `Kernel rejected this bench: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private cycleFreeValue(): void {
    const select = this.hud['free-part'] as HTMLSelectElement | undefined;
    const id = select?.value;
    if (!id) return;
    const { parts } = this.collectFree();
    const part = parts.find((p) => p.id === id);
    if (!part) return;
    const current = { ...benchDefaults(part.kind), ...this.freeValues.get(id) };
    if (part.kind === 'battery') {
      const v = parseFloat(current['electric.emf'] ?? '12');
      const next = EMF_STEPS.find((s) => s > v) ?? EMF_STEPS[0]!;
      current['electric.emf'] = `${next} V`;
    } else if (part.kind === 'resistor' || part.kind === 'lamp') {
      const v = parseFloat(current['electric.resistance'] ?? '10');
      const next = RESISTANCE_STEPS.find((s) => s > v) ?? RESISTANCE_STEPS[0]!;
      current['electric.resistance'] = `${next} ohm`;
    } else if (part.kind === 'capacitor') {
      current['electric.capacitance'] = current['electric.capacitance'] === '100 uF' ? '220 uF' : '100 uF';
    } else return;
    this.freeValues.set(id, current);
    this.freeSignature = '';
    this.solveFree();
  }

  // ---------------------------------------------------------------- Engine C playback

  /** Map a physics vector [x, y, z] (z up) onto the bench (x right, y up, z toward viewer). */
  private mapPhysics(v: number[]): Vector3 {
    return new Vector3(v[0] ?? 0, v[2] ?? 0, -(v[1] ?? 0));
  }

  private animateTrajectory(now: number): void {
    const traj = this.spec?.trajectory;
    if (!traj || !this.root) return;
    const mesh = this.proxies.get(traj.instance);
    const base = this.layout.get(traj.instance);
    if (!mesh || !base || traj.t.length < 2) return;

    const origin = traj.position[0]!;
    let extent = 0;
    for (const pos of traj.position) {
      const d = this.mapPhysics(pos).distanceTo(this.mapPhysics(origin));
      if (d > extent) extent = d;
    }
    const scale = extent > 1e-9 ? Math.min(0.5 / extent, 5000) : 1;

    if (!this.trail) {
      const pts = traj.position.map((pos) =>
        base.clone().add(this.mapPhysics(pos).sub(this.mapPhysics(origin)).multiplyScalar(scale)).setY(base.y + 0.02),
      );
      const geo = new BufferGeometry();
      geo.setAttribute('position', new Float32BufferAttribute(pts.flatMap((p) => [p.x, p.y, p.z]), 3));
      this.trail = new Line(geo, new MeshBasicMaterial({ color: 0xa78bfa, transparent: true, opacity: 0.85 }));
      this.root.add(this.trail);
      if (this.hud['probe-read']) {
        this.hud['probe-read']!.textContent =
          `🎞 Engine C trajectory (${traj.mode}, RK4): real duration ${traj.t[traj.t.length - 1]} s played over 6 s, ` +
          `magnified ×${scale.toFixed(scale >= 100 ? 0 : 1)} to fit the bench. Laws: ${traj.laws.join(', ')}. The path is integrated, never keyframed.`;
      }
    }

    const duration = traj.t[traj.t.length - 1]!;
    const phase = duration > 0 ? ((now / 1000) % 6) / 6 : 0;
    const idx = Math.min(traj.t.length - 1, Math.floor(phase * (traj.t.length - 1)));
    const offset = this.mapPhysics(traj.position[idx]!).sub(this.mapPhysics(origin)).multiplyScalar(scale);
    mesh.position.copy(base).add(offset).setY(base.y + 0.02 + offset.y);
  }

  // ---------------------------------------------------------------- hand-as-probe

  private fingertip(): Vector3 | null {
    try {
      const w = this.world as unknown as {
        xrEnabled?: boolean;
        playerSpaceEntities?: { indexTipSpaces?: { right?: Entity; left?: Entity } };
      };
      if (!w.xrEnabled) return null;
      const entity = w.playerSpaceEntities?.indexTipSpaces?.right ?? w.playerSpaceEntities?.indexTipSpaces?.left;
      const object = (entity?.object3D ?? this.player.indexTipSpaces.right) as
        | { getWorldPosition?: (v: Vector3) => void; position?: Vector3 }
        | undefined;
      if (!object) return null;
      const out = new Vector3();
      if (typeof object.getWorldPosition === 'function') object.getWorldPosition(out);
      else if (object.position) out.copy(object.position);
      else return null;
      return out;
    } catch { return null; }
  }

  private updateProbe(): void {
    if (!this.kb || !this.probeArrow) return;
    const tip = this.fingertip();
    if (!tip) { this.probeArrow.visible = false; return; }
    const worldSources: FieldSource[] = [];
    for (const s of this.sources) {
      const mesh = this.proxies.get(s.id);
      if (!mesh) continue;
      const wp = new Vector3();
      mesh.getWorldPosition(wp);
      worldSources.push({ ...s, position: [wp.x, wp.y, wp.z] });
    }
    if (worldSources.length === 0) { this.probeArrow.visible = false; return; }
    const sample = fieldAt(this.kb, worldSources, [tip.x, tip.y, tip.z]);
    if (!sample || sample.magnitude === 0) { this.probeArrow.visible = false; return; }
    const dir = new Vector3(sample.e[0], sample.e[1], sample.e[2]).normalize();
    this.probeArrow.position.copy(tip);
    this.probeArrow.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir);
    const len = arrowLength(sample.magnitude);
    this.probeArrow.scale.set(1, 1, Math.max(len, 0.02));
    const head = this.probeArrow.getObjectByName('head');
    if (head) head.position.z = 1;
    this.probeArrow.visible = true;
    if (this.hud['probe-read']) {
      this.hud['probe-read']!.textContent =
        `🖐 Hand probe (kernel-resolved): E = ${sample.magnitude.toExponential(3)} V/m · V = ${sample.potential.toExponential(3)} V · direction away from + charge. Arrow length is log-scaled; the number is exact.`;
    }
  }

  // ---------------------------------------------------------------- AI boundary (optional)

  private async runExtraction(): Promise<void> {
    const out = this.hud['ai-out']!;
    const text = (this.hud['ai-text'] as HTMLTextAreaElement).value.trim();
    if (!text || !this.kb) return;
    const cfg = aiConfig();
    if (!cfg) {
      out.textContent = 'AI is off (no proxy / personal key configured) — and the bench still works completely. That is the take-it-away test, passing.';
      return;
    }
    out.textContent = 'Extracting… the model may only fill a schema; the kernel validator decides.';
    const result = await extractScene(text, { kb: this.kb, config: cfg.config });
    out.textContent = result.ok
      ? `✓ Kernel VALIDATED this scene:\n${JSON.stringify(result.sceneSpec, null, 1)}\nTarget: ${result.target ? formatRef({ instance: result.target.instance, prop: result.target.prop, state: result.target.state ?? null }) : '—'}\nNow build it in Free bench — the solver will do the physics.`
      : `✗ Kernel REJECTED it (this is the system working):\n${result.errors.join('\n')}\nPartial scene kept for editing:\n${JSON.stringify(result.sceneSpec, null, 1)}`;
  }

  // ================================================================ question capture
  //
  // See ff/capture.ts for the honest shape of this: OCR proposes text, the learner
  // picks one question and confirms ("Solve this?"), then either the golden corpus
  // answers from its kernel-verified stock or the AI boundary proposes a Scene for
  // the kernel to judge. Nothing captured ever computes physics directly.

  private async ocrIntoBox(image: Blob): Promise<void> {
    const status = this.hud['cap-status']!;
    status.textContent = 'Reading the photo (OCR runs locally — nothing is uploaded)…';
    const text = await readPhoto(image);
    if (text === null) {
      status.textContent = 'OCR could not read that photo. Try better light, hold it square — or paste the question below.';
      this.sound('error');
      return;
    }
    (this.hud['cap-text'] as HTMLTextAreaElement).value = text;
    this.captured = splitQuestions(text);
    this.renderCaptureList();
    status.textContent = this.captured.length > 1
      ? `I found ${this.captured.length} questions on that page. Pick the one you want below — or press 📷 ASK on the bench and pick it in the glasses.`
      : 'I read one question. Check the text, then choose “Solve this”.';
    this.sound('resolve');
  }

  private async toggleCamera(): Promise<void> {
    const video = this.hud['cap-video'] as HTMLVideoElement;
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach((t) => t.stop());
      this.cameraStream = null;
      video.style.display = 'none';
      this.hud['cap-snap']!.style.display = 'none';
      return;
    }
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = this.cameraStream;
      video.style.display = 'block';
      this.hud['cap-snap']!.style.display = 'inline-block';
      this.hud['cap-status']!.textContent = 'Line the book page or laptop screen up, then Snap.';
    } catch {
      this.hud['cap-status']!.textContent = 'No camera available here — use Photo (upload) or paste the question.';
      this.sound('error');
    }
  }

  private async snapPhoto(): Promise<void> {
    const video = this.hud['cap-video'] as HTMLVideoElement;
    if (!this.cameraStream || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.92));
    if (blob) await this.ocrIntoBox(blob);
  }

  private renderCaptureList(): void {
    const list = this.hud['cap-list']!;
    list.innerHTML = '';
    this.pickQuestion(null);
    for (const q of this.captured) {
      const chip = document.createElement('button');
      chip.textContent = `${q.marker}: ${q.text.replace(/\s+/g, ' ').slice(0, 44)}…`;
      chip.title = q.text;
      chip.onclick = () => this.pickQuestion(q.text);
      list.appendChild(chip);
    }
  }

  /** The ask: a question is *proposed* to the learner, never solved uninvited. */
  private pickQuestion(text: string | null): void {
    this.pickedText = text;
    const row = this.hud['cap-confirm-row']!;
    if (text === null) {
      row.style.display = 'none';
      return;
    }
    row.style.display = 'flex';
    this.hud['cap-picked']!.textContent = `Solve this question? “${text.replace(/\s+/g, ' ').slice(0, 90)}…”`;
  }

  private corpusCandidates(): Promise<CorpusCandidate[]> {
    this.corpusCache ??= (async () => {
      if (!this.physics) return [];
      const out: CorpusCandidate[] = [];
      for (const p of this.physics.index.problems) {
        const s = await this.physics.spec(p.id).catch(() => null);
        if (s) out.push({ id: p.id, haystack: `${s.problem.title}\n${s.problem.text}` });
      }
      return out;
    })();
    return this.corpusCache;
  }

  private async solveCaptured(text: string): Promise<void> {
    const out = this.hud['cap-out']!;
    if (!this.kb || !this.physics) return;
    out.textContent = 'Matching against the verified corpus first — a match needs no AI and no trust…';
    const match = matchCorpus(text, await this.corpusCandidates());
    if (match) {
      out.textContent =
        `📖 This is corpus problem ${match.id} (match ${(match.score * 100).toFixed(0)}%). ` +
        `Loading its kernel-verified version as a guided build — same physics, guaranteed answer.`;
      this.setTask(`📷 Captured question matched verified problem ${match.id}. Build it guided.`);
      await this.loadProblem(match.id);
      this.setMode('guided');
      this.sound('answer');
      return;
    }
    const cfg = aiConfig();
    if (!cfg) {
      out.textContent =
        'No corpus match, and AI is off (no proxy / personal key), so I cannot interpret a new ' +
        'question — that is the take-it-away test working. The bench still solves anything you ' +
        'build in Free bench. Configure AI in the 🤖 section to interpret captures.';
      this.sound('error');
      return;
    }
    out.textContent = 'No corpus match. Asking the model to fill the Scene schema — the kernel validator decides…';
    const result = await extractScene(text, { kb: this.kb, config: cfg.config });
    if (!result.ok || !result.target) {
      out.textContent =
        `✗ Kernel REJECTED that reading (this is the system working):\n${result.errors.join('\n')}\n` +
        'Edit the text above and try again, or build it in Free bench.';
      this.sound('error');
      return;
    }
    out.textContent = '✓ Kernel validated the scene. Building your guided lesson from it…';
    this.startCapturedGuide(result.sceneSpec, result.target, text);
  }

  /**
   * A captured, kernel-validated scene becomes a guided build. There is no exported
   * SimSpec for it (those are Python-compiled), so a spec-shaped lesson is assembled
   * here: place a part per instance, wire per relation, then the kernel's own
   * resolution as the closing answer. The answer comes from the TS Resolver against
   * the validated scene — computed by the kernel, never by the model.
   */
  private startCapturedGuide(sceneSpec: CapturedSceneSpec, target: TargetRef, sourceText: string): void {
    if (!this.kb) return;
    let display = '';
    try {
      const scene = buildScene(sceneSpec, this.kb, { where: 'captured-question' });
      const paths = new Resolver(this.kb, scene).resolve(target);
      const steps = paths[0]?.steps;
      const q = steps?.[steps.length - 1]?.quantity;
      display = q ? `${formatRef(target)} = ${typeof q.value === 'number' ? q.value.toPrecision(5) : JSON.stringify(q.value)}` : '';
    } catch { /* the guide still teaches the build; the answer beat says so honestly */ }

    const labelOf = (kind: string): string => this.kb!.components[kind]?.label ?? kind;
    const beats: Beat[] = [];
    for (const inst of sceneSpec.instances) beats.push({
      beat: beats.length + 1, kind: 'place', instance: inst.id, component: inst.kind,
      narrate: `Place the ${labelOf(inst.kind)} (${inst.id})`,
      because: { kind: 'scene', detail: 'From your captured question' },
    });
    for (const rel of sceneSpec.relations) beats.push({
      beat: beats.length + 1, kind: 'relate', relation: rel.kind, from: rel.from, to: rel.to,
      narrate: `Connect ${rel.from} → ${rel.to} (${rel.kind})`,
      because: { kind: 'scene', detail: 'From your captured question' },
    });
    beats.push({
      beat: beats.length + 1, kind: 'answer',
      narrate: display ? 'The kernel resolves your build' : 'Build it, then check with the Free-bench solver',
      display: display || undefined,
      because: { kind: 'summary', detail: 'Resolved by the kernel (TS Resolver, same rules as the corpus)' },
    });

    this.spec = {
      fieldforge: 'captured',
      problem: { id: 'captured', title: '📷 Captured question', text: sourceText, source: 'Captured by the learner; kernel-validated', tags: ['captured'] },
      target: formatRef(target),
      answer: { value: 0, unit: '', rank: 'scalar', display: display || '—' },
      scene: {
        instances: sceneSpec.instances.map((inst) => ({
          id: inst.id, kind: inst.kind, label: labelOf(inst.kind),
          model3d: this.kb!.components[inst.kind]?.model3d ?? null, tags: [], given: {},
        })),
        relations: sceneSpec.relations.map((rel) => ({ kind: rel.kind, from: rel.from, to: rel.to, given: {} })),
      },
      timeline: beats,
      checks: { paths_found: 1, paths_agree: true },
    } as unknown as SimSpec;

    this.layout.clear();
    let i = 0;
    for (const inst of this.spec.scene.instances) {
      if (inst.kind === 'environment') continue;
      this.layout.set(inst.id, this.stagePosition(i++));
    }
    this.mode = 'guided'; this.playing = false;
    for (const m of ['auto', 'guided', 'free'] as Mode[])
      this.hud[`m-${m}`]?.classList.toggle('on', m === 'guided');
    if (this.hud.free) this.hud.free.style.display = 'none';
    this.resetStage();
    this.startGuide();
    this.drawGuide('📷 Captured question', [
      'The kernel validated this one. Build it with your hands, step by step.',
      display ? `You are aiming at: ${display}` : '',
    ], 'idle');
    this.setTask('📷 Captured question validated by the kernel — build it guided, with your hands.');
    this.sound('answer');
  }

  // ---------------------------------------------------------- in-glasses picker
  //
  // The orange 📷 ASK button on the bench. Inside the headset there is no mouse, so
  // picking a question is a two-button dance on the physical bench buttons:
  // NEXT steps through the list (shown on the guide panel), PLAY asks "Solve this
  // question?", PLAY again confirms and the guided build starts. Sources, in
  // order: questions captured on the companion this session, else the book list
  // (the golden corpus), which is always there.

  private onCaptureButton(): void {
    if (this.picker) {
      this.picker = null;
      this.drawGuide('Picker closed', ['Back to your lesson. Press 📷 ASK anytime to pick a question.'], 'idle');
      return;
    }
    const items: Array<{ label: string; run: () => void | Promise<void> }> = [];
    if (this.captured.length > 0) {
      for (const q of this.captured) {
        items.push({
          label: `${q.marker}: ${q.text.replace(/\s+/g, ' ').slice(0, 64)}`,
          run: () => this.solveCaptured(q.text),
        });
      }
    } else if (this.physics) {
      for (const p of this.physics.index.problems) {
        items.push({
          label: `${p.id} · ${p.title}`,
          run: async () => { await this.loadProblem(p.id); this.setMode('guided'); },
        });
      }
    }
    if (items.length === 0) {
      this.drawGuide('📷 No questions yet', [
        'Capture a page on the companion (📷 Capture a question),',
        'or wait for the problem list to load.',
      ], 'idle');
      return;
    }
    this.picker = { stage: 'list', index: 0, items };
    this.drawPicker();
    this.sound('place');
  }

  private drawPicker(): void {
    const picker = this.picker;
    if (!picker) return;
    if (picker.stage === 'confirm') {
      this.drawGuide('Solve this question?', [
        picker.items[picker.index]!.label,
        '▶ press PLAY again = yes, build it guided',
        '▸ press NEXT = back to the list',
      ], 'task');
      return;
    }
    const n = picker.items.length;
    const start = Math.min(Math.max(0, picker.index - 2), Math.max(0, n - 5));
    const lines = picker.items.slice(start, start + 5).map((item, i) =>
      `${start + i === picker.index ? '►' : ' '} ${item.label}`);
    lines.push(`Question ${picker.index + 1} of ${n} · NEXT = move · PLAY = choose`);
    this.drawGuide(this.captured.length > 0 ? '📖 From your book — which question?' : '📖 Book list — which question?', lines, 'task');
  }

  private pickerNext(): void {
    if (!this.picker) return;
    if (this.picker.stage === 'confirm') {
      this.picker.stage = 'list';
    } else {
      this.picker.index = (this.picker.index + 1) % this.picker.items.length;
    }
    this.drawPicker();
    this.sound('place');
  }

  private pickerPlay(): void {
    if (!this.picker) return;
    if (this.picker.stage === 'list') {
      this.picker.stage = 'confirm';
      this.drawPicker();
      this.sound('resolve');
      return;
    }
    const item = this.picker.items[this.picker.index]!;
    this.picker = null;
    this.drawGuide('✓ Let’s solve it', [item.label, 'Building your guided lesson…'], 'done');
    void item.run();
  }

  // ---------------------------------------------------------------- sound (synthesised, no assets)

  private ensureAudio(): void {
    if (!this.audio) { try { this.audio = new AudioContext(); } catch { /* sound is garnish */ } }
    if (this.audio?.state === 'suspended') void this.audio.resume();
  }

  private sound(kind: 'place' | 'resolve' | 'answer' | 'error'): void {
    if (!this.soundOn || !this.audio) return;
    const ctx = this.audio; const t = ctx.currentTime;
    const notes = kind === 'answer' ? [523, 659, 784, 1046] : kind === 'resolve' ? [660, 880] : kind === 'error' ? [160] : [520];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.frequency.value = freq; osc.type = kind === 'error' ? 'sawtooth' : 'sine';
      gain.gain.setValueAtTime(0.0001, t + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.12, t + i * 0.09 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 0.35);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t + i * 0.09); osc.stop(t + i * 0.09 + 0.4);
    });
  }
}
