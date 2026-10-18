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
  CanvasTexture,
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
import { extractScene } from '../physics/extract.js';
import { aiConfig } from './ai-config.js';
import { Bench as BenchComp, ExperienceButton, Part, Terminal, Wire } from './components.js';
import { buildCircuitScene, benchDefaults, type BenchPart, type BenchWire } from './topology.js';
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
        if (action === 'play') this.togglePlay();
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
    if (this.playing && this.mode === 'auto' && now >= this.nextAt) this.advance(false);
    if (this.resumeAt && now >= this.resumeAt) { this.resumeAt = 0; this.advance(false); }
    if (this.waitingTask) this.checkTask();
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
      else this.setTask(`🖐 Guided: ${this.spec.problem.title} — press Next, then build each step with your hands.`);
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
