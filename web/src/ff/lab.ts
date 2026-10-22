/**
 * The lab: a lit room around the bench, so the experience reads as a real physics lab.
 *
 * Two worlds, one switch:
 *
 *   - In passthrough (an immersive-ar session) the room is the user's own room. Everything this
 *     file builds that would cover reality (walls, floor, worktable, mat) is hidden, and only a
 *     transparent shadow-catcher stays, so parts look like they sit on the real desk.
 *   - On desktop, or in a headset session with no passthrough, the lab is shown: epoxy floor,
 *     painted walls, a steel-legged oak worktable, an ESD mat under the interactive area, a
 *     whiteboard, a bench power supply, an oscilloscope and a task lamp.
 *
 * Everything is procedural (no downloads, a few dozen meshes, one shadow map), so the lab works
 * offline and costs a Quest almost nothing. Image-based light comes from the toolkit's own
 * `IBLTexture` ("room"); IWSDK already keeps that light in passthrough while hiding backgrounds.
 *
 * Nothing here touches physics. It owns light, materials, the room, and the desktop camera.
 */

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  HemisphereLight,
  IBLTexture,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PCFSoftShadowMap,
  PlaneGeometry,
  RepeatWrapping,
  ShadowMaterial,
  SRGBColorSpace,
  Vector3,
  createSystem,
  type Entity,
  type Material,
  type Object3D,
} from '@iwsdk/core';

import { Bench as BenchComp } from './components.js';

// --------------------------------------------------------------------------- shared helpers

/** Let an object (and everything under it) cast and receive shadows. */
export function castShadows(root: Object3D, receive = true): void {
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh === true) {
      mesh.castShadow = true;
      mesh.receiveShadow = receive;
    }
  });
}

/** A canvas-drawn texture, in the colour space the renderer expects. */
export function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, width, height);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const std = (color: number, roughness = 0.6, metalness = 0, extra: Partial<MeshStandardMaterial> = {}): MeshStandardMaterial =>
  Object.assign(new MeshStandardMaterial({ color, roughness, metalness }), extra);

/** Emoji and pictographs: the 3D panel font cannot draw them (they show as empty boxes). */
export function stripPictographs(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, '').replace(/\s{2,}/g, ' ').trim();
}

// --------------------------------------------------------------------------- palette

export const LAB_PALETTE = {
  ink: '#1c2b33',
  slate: '#0d181d',
  slate2: '#14252c',
  line: '#2a4a52',
  teal: '#2dd4bf',
  tealDeep: '#0f766e',
  amber: '#f5a524',
  rose: '#fb7185',
  paper: '#f4efe4',
  paperEdge: '#d9d1bf',
  mute: '#8fb3b8',
} as const;

// --------------------------------------------------------------------------- the lab itself

/** Interactive mat size, matching `BenchSystem` (0.9 x 0.6 m). */
const MAT = { w: 0.9, d: 0.6 };
const TABLE_H = 0.76; // worktable height under the interactive plane

function woodTexture(): CanvasTexture {
  const tex = canvasTexture(1024, 512, (ctx, w, h) => {
    ctx.fillStyle = '#b48a5e';
    ctx.fillRect(0, 0, w, h);
    // long soft grain lines, slightly wavy, in two tones
    for (let i = 0; i < 90; i += 1) {
      const y = (i / 90) * h + Math.sin(i * 1.7) * 2;
      ctx.strokeStyle = i % 3 === 0 ? 'rgba(92,62,36,0.16)' : 'rgba(255,236,205,0.07)';
      ctx.lineWidth = 1 + (i % 4) * 0.6;
      ctx.beginPath();
      ctx.moveTo(0, y);
      for (let x = 0; x <= w; x += 64) ctx.lineTo(x, y + Math.sin(x / 130 + i) * 3);
      ctx.stroke();
    }
    // plank seams
    ctx.strokeStyle = 'rgba(60,38,20,0.35)';
    ctx.lineWidth = 2;
    for (const y of [h * 0.33, h * 0.66]) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  });
  tex.wrapS = RepeatWrapping;
  tex.wrapT = RepeatWrapping;
  return tex;
}

function whiteboardTexture(): CanvasTexture {
  return canvasTexture(1024, 576, (ctx, w, h) => {
    ctx.fillStyle = '#f7f8f6';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#cfd6d4';
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, w - 10, h - 10);
    ctx.fillStyle = '#1d4e89';
    ctx.font = '600 54px "Segoe Print","Bradley Hand",cursive,system-ui';
    ctx.fillText('V = I R', 70, 110);
    ctx.fillStyle = '#b3261e';
    ctx.fillText('F = k q\u2081q\u2082 / r\u00B2', 70, 200);
    ctx.fillStyle = '#1a7f4b';
    ctx.fillText('E = F / q', 70, 290);
    ctx.fillStyle = '#1d4e89';
    ctx.fillText('R\u209B = R\u2081 + R\u2082', 520, 110);
    ctx.fillText('1/R\u209A = 1/R\u2081 + 1/R\u2082', 520, 200);
    // a hand-drawn series loop
    ctx.strokeStyle = '#1c2b33';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.rect(560, 290, 300, 190);
    ctx.stroke();
    ctx.clearRect(600, 280, 70, 20);
    ctx.fillStyle = '#f7f8f6';
    ctx.fillRect(610, 282, 50, 16);
    ctx.strokeRect(610, 282, 50, 16);
    ctx.fillStyle = '#1c2b33';
    ctx.font = '500 34px system-ui';
    ctx.fillText('+', 540, 392);
    ctx.fillText('\u2212', 536, 440);
  });
}

function scopeScreenTexture(): CanvasTexture {
  return canvasTexture(512, 384, (ctx, w, h) => {
    ctx.fillStyle = '#04120c';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(80,255,170,0.18)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i += 1) {
      ctx.beginPath();
      ctx.moveTo((i * w) / 10, 0);
      ctx.lineTo((i * w) / 10, h);
      ctx.stroke();
    }
    for (let i = 1; i < 8; i += 1) {
      ctx.beginPath();
      ctx.moveTo(0, (i * h) / 8);
      ctx.lineTo(w, (i * h) / 8);
      ctx.stroke();
    }
    ctx.strokeStyle = '#4dffa6';
    ctx.lineWidth = 3;
    ctx.shadowColor = '#4dffa6';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const y = h / 2 + Math.sin((x / w) * Math.PI * 6) * (h * 0.28);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  });
}

function psuDisplayTexture(volts: string, amps: string): CanvasTexture {
  return canvasTexture(512, 128, (ctx, w, h) => {
    ctx.fillStyle = '#120a02';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#ffb23e';
    ctx.font = '700 78px ui-monospace,Menlo,Consolas,monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(volts, 24, h / 2 + 4);
    ctx.fillText(amps, w / 2 + 24, h / 2 + 4);
    ctx.font = '600 22px system-ui';
    ctx.fillStyle = 'rgba(255,178,62,0.7)';
    ctx.fillText('V', w / 2 - 36, h - 22);
    ctx.fillText('A', w - 40, h - 22);
  });
}

export class LabSystem extends createSystem({
  benches: { required: [BenchComp] },
}) {
  private bench?: Entity;
  private room?: Group;
  private lights?: Group;
  private surface?: Mesh;
  private grid?: Mesh;
  private catcher?: Mesh;
  private labMaterials: Material[] = [];
  private ar: boolean | null = null;
  private envApplied = false;

  // Desktop orbit (right-drag to turn, wheel to zoom). Left-drag stays free for grabbing parts.
  private azimuth = 0;
  private polar = 1.05; // radians from straight up
  private radius = 1.3;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private readonly target = new Vector3();
  private viewShift = 0;

  init(): void {
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    // Khronos "neutral" tone mapping keeps a part's real colour (a blue capacitor stays blue).
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.cleanupFuncs.push(this.queries.benches.subscribe('qualify', (e) => this.build(e), true));
    this.bindOrbit();
  }

  update(): void {
    this.applyEnvironment();
    this.syncPassthrough();
    this.driveDesktopCamera();
  }

  // ------------------------------------------------------------------ environment light

  /** Image-based light from the toolkit's built-in room, on the level root. Retries until it exists. */
  private applyEnvironment(): void {
    if (this.envApplied) return;
    const root = this.world.activeLevel?.value;
    if (root === undefined || root === null) return;
    root.addComponent(IBLTexture, { src: 'room', intensity: 0.55 });
    this.envApplied = true;
  }

  // ------------------------------------------------------------------ build

  private build(bench: Entity): void {
    if (this.bench || bench.object3D == null) return;
    this.bench = bench;
    const benchObject = bench.object3D;

    this.surface = benchObject.getObjectByName('BenchSurface') as Mesh | undefined;
    this.grid = benchObject.getObjectByName('BenchGrid') as Mesh | undefined;

    // Lights ride with the bench, so they re-anchor with it.
    const lights = new Group();
    lights.name = 'LabLights';
    const key = new DirectionalLight(0xfff1de, 1.7);
    key.position.set(0.7, 1.6, 0.9);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -0.6, right: 0.6, top: 0.6, bottom: -0.6, near: 0.4, far: 4 });
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.02;
    key.target.position.set(0, 0, 0);
    const rim = new DirectionalLight(0xa9d2ff, 0.5);
    rim.position.set(-1.1, 1.0, -1.0);
    lights.add(key, key.target, rim, new HemisphereLight(0xdbe9ff, 0x7a6a58, 0.45));
    benchObject.add(lights);
    this.lights = lights;

    // Always-on: a shadow catcher over the mat, so parts sit on the surface in passthrough too.
    const catcher = new Mesh(new PlaneGeometry(MAT.w, MAT.d), new ShadowMaterial({ opacity: 0.32 }));
    catcher.rotation.x = -Math.PI / 2;
    catcher.position.y = 0.0009;
    catcher.receiveShadow = true;
    catcher.name = 'LabShadowCatcher';
    benchObject.add(catcher);
    this.catcher = catcher;

    const room = this.buildRoom();
    benchObject.add(room);
    this.room = room;

    this.ar = null; // force the first style pass
    this.syncPassthrough();
  }

  private buildRoom(): Group {
    const room = new Group();
    room.name = 'LabRoom';
    const track = <M extends Material>(m: M): M => {
      this.labMaterials.push(m);
      return m;
    };

    // ---- the room shell: painted walls and ceiling seen from inside, epoxy floor
    const shell = new Mesh(
      new BoxGeometry(5.4, 3.3, 6.4),
      track(std(0xe3e6e4, 0.92, 0, { side: DoubleSide })),
    );
    shell.geometry.scale(-1, 1, 1); // inside-out: walls face the viewer
    shell.position.set(0, -TABLE_H + 1.65, 0);
    shell.name = 'LabShell';
    room.add(shell);

    const floor = new Mesh(new PlaneGeometry(5.4, 6.4), track(std(0x9aa1a4, 0.38, 0.05)));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -TABLE_H, 0);
    floor.receiveShadow = true;
    room.add(floor);

    // ceiling light panels (emissive, unlit, so they read as bright tubes under neutral mapping)
    const panel = track(new MeshBasicMaterial({ color: 0xffffff, toneMapped: false }));
    for (const x of [-1.3, 0, 1.3]) {
      const light = new Mesh(new PlaneGeometry(1.1, 0.28), panel);
      light.rotation.x = Math.PI / 2;
      light.position.set(x, -TABLE_H + 3.28, -0.6);
      room.add(light);
    }

    // ---- worktable: oak top, steel legs, lower shelf
    const wood = woodTexture();
    wood.repeat.set(2, 1);
    const top = new Mesh(new BoxGeometry(2.0, 0.045, 0.95), track(std(0xffffff, 0.55, 0, { map: wood })));
    top.position.set(0, -0.0245, -0.02);
    top.receiveShadow = true;
    room.add(top);

    const steel = track(std(0x8c97a3, 0.38, 0.7));
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = new Mesh(new BoxGeometry(0.05, TABLE_H - 0.03, 0.05), steel);
        leg.position.set(sx * 0.94, -(TABLE_H - 0.03) / 2 - 0.045, sz * 0.4 - 0.02);
        leg.castShadow = true;
        room.add(leg);
      }
    }
    const lower = new Mesh(new BoxGeometry(1.9, 0.02, 0.85), steel);
    lower.position.set(0, -0.52, -0.02);
    room.add(lower);

    // ---- the mat under the interactive area (above the worktable by a few mm)
    const mat = new Mesh(
      new BoxGeometry(MAT.w + 0.04, 0.004, MAT.d + 0.04),
      track(std(0x1e2f2b, 0.9, 0, { })),
    );
    mat.position.set(0, -0.0035, 0);
    mat.receiveShadow = true;
    room.add(mat);

    // ---- whiteboard on the back wall
    const board = new Mesh(
      new PlaneGeometry(1.7, 0.96),
      track(new MeshBasicMaterial({ map: whiteboardTexture(), toneMapped: false })),
    );
    board.position.set(-0.55, 1.05, -3.18);
    room.add(board);
    const frame = new Mesh(new BoxGeometry(1.76, 1.02, 0.02), steel);
    frame.position.set(-0.55, 1.05, -3.195);
    room.add(frame);

    // ---- wall shelf with parts bins
    const shelf = new Mesh(new BoxGeometry(1.4, 0.035, 0.28), track(std(0xb48a5e, 0.6)));
    shelf.position.set(1.25, 0.62, -3.05);
    room.add(shelf);
    const binColours = [0x2563eb, 0xdc2626, 0xf59e0b, 0x16a34a, 0x7c3aed, 0x0891b2];
    binColours.forEach((c, i) => {
      const bin = new Mesh(new BoxGeometry(0.17, 0.12, 0.2), track(std(c, 0.5)));
      bin.position.set(0.7 + i * 0.2, 0.62 + 0.0775, -3.05);
      bin.castShadow = true;
      room.add(bin);
    });

    // ---- instruments on the worktable, either side of the mat
    // oscilloscope
    const scope = new Group();
    scope.add(Object.assign(new Mesh(new BoxGeometry(0.34, 0.22, 0.3), track(std(0x2a3036, 0.5, 0.2))), { castShadow: true }));
    const screen = new Mesh(
      new PlaneGeometry(0.19, 0.14),
      track(new MeshBasicMaterial({ map: scopeScreenTexture(), toneMapped: false })),
    );
    screen.position.set(-0.04, 0.02, 0.1505);
    scope.add(screen);
    for (const [kx, ky] of [[0.105, 0.06], [0.105, 0.0], [0.105, -0.06]] as const) {
      const knob = new Mesh(new CylinderGeometry(0.014, 0.014, 0.02, 14), track(std(0xcfd4d8, 0.35, 0.8)));
      knob.rotation.x = Math.PI / 2;
      knob.position.set(kx, ky, 0.158);
      scope.add(knob);
    }
    scope.position.set(-0.68, 0.11, -0.3);
    scope.rotation.y = 0.22;
    room.add(scope);

    // bench power supply
    const psu = new Group();
    psu.add(Object.assign(new Mesh(new BoxGeometry(0.3, 0.13, 0.26), track(std(0x39424a, 0.5, 0.25))), { castShadow: true }));
    const display = new Mesh(
      new PlaneGeometry(0.2, 0.05),
      track(new MeshBasicMaterial({ map: psuDisplayTexture('12.00', '0.50'), toneMapped: false })),
    );
    display.position.set(0, 0.025, 0.1305);
    psu.add(display);
    for (const [kx, color] of [[-0.09, 0xd33d3d], [0.09, 0x222222]] as const) {
      const post = new Mesh(new CylinderGeometry(0.013, 0.013, 0.025, 14), track(std(color, 0.4, 0.3)));
      post.rotation.x = Math.PI / 2;
      post.position.set(kx, -0.035, 0.138);
      psu.add(post);
    }
    psu.position.set(0.66, 0.065, -0.3);
    psu.rotation.y = -0.18;
    room.add(psu);

    // task lamp: weighted base, two arms, shade, warm bulb
    const lamp = new Group();
    lamp.add(Object.assign(new Mesh(new CylinderGeometry(0.07, 0.08, 0.025, 24), track(std(0x20262b, 0.5, 0.4))), { castShadow: true }));
    const arm1 = new Mesh(new CylinderGeometry(0.008, 0.008, 0.34, 8), steel);
    arm1.position.set(0.03, 0.18, 0);
    arm1.rotation.z = -0.25;
    const arm2 = new Mesh(new CylinderGeometry(0.008, 0.008, 0.3, 8), steel);
    arm2.position.set(0.06, 0.4, 0);
    arm2.rotation.z = 0.95;
    const shade = new Mesh(new ConeGeometry(0.09, 0.12, 24, 1, true), track(std(0x2c6e49, 0.45, 0.3, { side: DoubleSide })));
    shade.position.set(-0.07, 0.52, 0);
    shade.rotation.z = Math.PI + 0.35;
    const bulb = new Mesh(new CylinderGeometry(0.03, 0.03, 0.05, 16), track(new MeshBasicMaterial({ color: 0xfff0cf, toneMapped: false })));
    bulb.position.set(-0.075, 0.49, 0);
    lamp.add(arm1, arm2, shade, bulb);
    lamp.position.set(0.82, 0, -0.18);
    room.add(lamp);

    return room;
  }

  // ------------------------------------------------------------------ passthrough switch

  /** True while an immersive session blends with the real world. */
  private isPassthrough(): boolean {
    const session = this.renderer.xr.getSession();
    return session !== null && session.environmentBlendMode !== 'opaque';
  }

  private syncPassthrough(): void {
    if (!this.room) return;
    const ar = this.isPassthrough();
    if (ar === this.ar) return;
    this.ar = ar;

    this.room.visible = !ar;
    const surfaceMaterial = this.surface?.material as MeshStandardMaterial | undefined;
    if (surfaceMaterial) {
      if (ar) {
        // over the real desk: the original faint tint, so reality shows through
        surfaceMaterial.color.set(0x0f1b1a);
        surfaceMaterial.transparent = true;
        surfaceMaterial.opacity = 0.35;
      } else {
        // in the lab the mat itself is drawn by the room; hide the old slab entirely
        surfaceMaterial.transparent = true;
        surfaceMaterial.opacity = 0;
      }
      surfaceMaterial.needsUpdate = true;
    }
    const gridMaterial = this.grid?.material as { color: Color; opacity: number } | undefined;
    if (gridMaterial) {
      gridMaterial.color.set(ar ? 0x3fd8c4 : 0xbfeee4);
      gridMaterial.opacity = ar ? 0.22 : 0.16;
    }
  }

  // ------------------------------------------------------------------ desktop camera

  private bindOrbit(): void {
    const el = this.renderer.domElement;
    const onContext = (e: Event) => e.preventDefault();
    const onDown = (e: PointerEvent) => {
      if (e.button !== 2) return;
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!this.dragging) return;
      this.azimuth -= (e.clientX - this.lastX) * 0.006;
      this.polar = Math.min(1.45, Math.max(0.25, this.polar - (e.clientY - this.lastY) * 0.005));
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === 2) this.dragging = false;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      this.radius = Math.min(2.3, Math.max(0.45, this.radius * (1 + Math.sign(e.deltaY) * 0.08)));
    };
    el.addEventListener('contextmenu', onContext);
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    this.cleanupFuncs.push(() => {
      el.removeEventListener('contextmenu', onContext);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
    });
  }

  /** Off-headset only: look at the bench from a seated three-quarter view you can orbit. */
  private driveDesktopCamera(): void {
    if (this.renderer.xr.isPresenting) {
      if (this.viewShift !== 0) {
        this.camera.clearViewOffset();
        this.viewShift = 0;
      }
      return;
    }
    if (!this.bench?.object3D) return;
    this.bench.object3D.getWorldPosition(this.target);
    this.target.y += 0.16;

    // Keep the scene clear of the HUD: shift the picture right by half the panel's width.
    const hud = document.getElementById('ff-hud');
    const shift = hud ? Math.round(hud.getBoundingClientRect().right / 2) : 0;
    const el = this.renderer.domElement;
    const key = shift * 100000 + el.clientWidth;
    if (key !== this.viewShift && el.clientWidth > 700) {
      this.viewShift = key;
      this.camera.setViewOffset(el.clientWidth, el.clientHeight, -shift, 0, el.clientWidth, el.clientHeight);
    }
    const sinP = Math.sin(this.polar);
    this.camera.position.set(
      this.target.x + this.radius * sinP * Math.sin(this.azimuth),
      this.target.y + this.radius * Math.cos(this.polar),
      this.target.z + this.radius * sinP * Math.cos(this.azimuth),
    );
    this.camera.lookAt(this.target);
  }
}
