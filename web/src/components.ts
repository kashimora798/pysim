/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * The component manifest. The editor imports this to build its inspector, so a component missing
 * from here cannot be authored in a scene.
 */

import { defineComponents } from '@iwsdk/core';

import {
  Bench,
  Environment,
  Part,
  Terminal,
  Wire,
  WireDrag,
} from './ff/components.js';
import { Robot } from './robot-component.js';

export default defineComponents([
  Bench,
  Part,
  Terminal,
  Wire,
  WireDrag,
  Environment,
  // Starter sample; safe to remove with the robot scene node.
  Robot,
]);
