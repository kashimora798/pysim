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
  ExperienceButton,
  Part,
  Terminal,
  Wire,
  WireDrag,
} from './ff/components.js';

export default defineComponents([
  Bench,
  Part,
  Terminal,
  Wire,
  WireDrag,
  Environment,
  ExperienceButton,
]);
