/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * Where the LLM boundary gets its endpoint.
 *
 * The extractor is the ONLY place in FieldForge that may consult a model, and it never computes a
 * physical value — it fills a schema that the deterministic kernel then accepts or rejects. See
 * `src/physics/extract.ts`.
 *
 * ## Why the key is not in the bundle
 *
 * This app is a static site. Vite inlines every `VITE_*` variable into client JavaScript, so a key
 * placed there would be published with the app. The real key therefore lives in the server
 * environment (`.env.local`, gitignored, never `VITE_`-prefixed) and is reached through a small
 * proxy that adds the `Authorization` header. Two supported shapes:
 *
 *   - **proxy** (default): `VITE_FF_AI_PROXY=https://your-proxy.example/api/extract` — the
 *     browser POSTs to the proxy; the proxy injects the key and forwards to Featherless.
 *   - **personal**: the user pastes a key into a settings field; it is held in memory or
 *     `localStorage` on their own machine and sent only to the provider. Never committed.
 *
 * With neither configured, extraction is unavailable and the app degrades to Auto/Guided/Free
 * bench, which need no model at all. That degradation is the point: it is what lets the project
 * survive the competition's "take it away" test.
 */

import type { ExtractorConfig } from '../physics/extract.js';

/** Featherless serves an OpenAI-compatible chat-completions API. */
export const FEATHERLESS = {
  baseUrl: 'https://api.featherless.ai/v1',
  model: 'Qwen/Qwen3-8B',
} as const;

const STORAGE_KEY = 'fieldforge.ai.key';

/**
 * Qwen3 emits `<think>…</think>` before its answer unless told not to. The extractor strips those
 * blocks anyway, but turning thinking off saves tokens and latency, and extraction is
 * transcription rather than invention — there is nothing to reason about.
 */
const QWEN3_EXTRA_BODY = { chat_template_kwargs: { enable_thinking: false } };

function proxyUrl(): string | undefined {
  const raw = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_FF_AI_PROXY;
  return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/** A key the user pasted into their own browser. Personal use only; never shipped. */
export function personalKey(): string | undefined {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored && stored.trim().length > 0 ? stored.trim() : undefined;
  } catch {
    return undefined; // private mode, or storage blocked. Absence is not an error.
  }
}

export function rememberPersonalKey(key: string): void {
  try {
    if (key.trim().length === 0) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, key.trim());
  } catch {
    /* storage unavailable: the key simply will not persist between sessions */
  }
}

/**
 * Build the extractor config, or report why extraction cannot run.
 *
 * Returning a reason rather than throwing keeps the call site honest: the UI can show "AI is off,
 * use Auto mode" instead of failing a render.
 */
export function aiConfig(): { config: ExtractorConfig; via: 'proxy' | 'personal' } | null {
  const proxy = proxyUrl();
  if (proxy) {
    // The proxy holds the key and forwards to Featherless; the browser sends no credential.
    return {
      via: 'proxy',
      config: {
        baseUrl: proxy,
        model: FEATHERLESS.model,
        headers: { 'x-ff-upstream': FEATHERLESS.baseUrl },
        extraBody: QWEN3_EXTRA_BODY,
        temperature: 0,
        maxAttempts: 3,
      },
    };
  }

  const key = personalKey();
  if (key) {
    return {
      via: 'personal',
      config: {
        baseUrl: FEATHERLESS.baseUrl,
        model: FEATHERLESS.model,
        apiKey: key,
        extraBody: QWEN3_EXTRA_BODY,
        temperature: 0,
        maxAttempts: 3,
      },
    };
  }

  return null;
}
