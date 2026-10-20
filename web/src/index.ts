/**
 * FieldForge: a physics bench that anchors to your real desk.
 *
 * The physics itself is not computed here. It is derived and dimensionally verified by the
 * Python kernel at build time, exported as JSON, and replayed or resolved live by these
 * systems. See `src/physics/kernel.ts` and `docs/architecture.md`.
 */

import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';

import { BenchSystem } from './ff/bench.js';
import { ExperienceSystem } from './ff/experience.js';
import { InventorySystem } from './ff/inventory.js';
import { TerminalSystem } from './ff/terminals.js';
import { WireSystem } from './ff/wire.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then((world) => {
  // Hand-pinch grabbing is enabled in iwsdk.config.json: without it a hand pinch grabs
  // nothing and the app silently fails the competition's hands-first requirement.

  // Registration order is meaningful. The bench anchors first so everything else can read
  // its transform; terminals qualify against `Part` before wires replay their initial
  // `qualify`; the experience (modes, player, solver bridge, trust card, probe) runs last
  // because it observes all of them.
  world.registerSystem(BenchSystem);
  world.registerSystem(TerminalSystem);
  world.registerSystem(WireSystem);
  world.registerSystem(InventorySystem);
  world.registerSystem(ExperienceSystem);
});
