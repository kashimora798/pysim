/**
 * The LLM boundary: prose problem -> typed `SceneSpec` -> `buildScene` -> `Scene`.
 *
 * This is the ONLY file in FieldForge that is allowed to talk to a language model, and the model
 * is allowed to do exactly one thing here: **fill a schema**. It never computes a physical value,
 * never picks a formula, never sees a number the kernel produced, and never gets a vote on whether
 * its own output is correct. It proposes; `buildScene` from `./resolve.js` disposes.
 *
 * That property is structural, not aspirational, and these are the four load-bearing parts:
 *
 * 1. **Closed vocabulary.** Every component kind, property key and relation kind offered to the
 *    model is derived from `kb.json` at runtime by `buildCatalogue` — nothing is hardcoded here.
 *    The JSON schema we send turns that vocabulary into `enum`s, so under constrained decoding an
 *    invented property name is not merely discouraged, it is ungrammatical.
 * 2. **Values stay strings.** A quantity leaves this file exactly as the model wrote it
 *    (`"2.0 uC"`, `"[0, 0, -9.81] m/s^2"`). We never parse a number, never convert a unit, never
 *    normalise to SI. The kernel's quantity parser owns that, so a unit mistake becomes a
 *    rejection with a dimension error rather than a silent factor of 100.
 * 3. **The real validator, not a copy.** The candidate goes through the same `buildScene` the
 *    corpus goes through. We do not re-implement its checks; re-implementing them is how the two
 *    halves of a validator drift.
 * 4. **No throw, ever.** `extractScene` resolves with `{ok: false, ...}` on any failure — bad JSON,
 *    HTTP 500, abort, a validator rejection — and always returns the partial `sceneSpec` it
 *    understood so the UI can open its scene builder pre-filled. Nothing here may throw into a
 *    render loop.
 *
 * ## Key handling (read this before deploying)
 *
 * FieldForge is a **static site**. There is no server to hide a secret in, so:
 *
 * - Do NOT put an API key in `.env`, `import.meta.env`, or any constant in this repo. Vite inlines
 *   `VITE_*` values into the bundle in plain text; "it is only on GitHub Pages" is not a mitigation,
 *   anyone can read the JS.
 * - For a deployed build, point `baseUrl` at a **serverless proxy you control** (a Worker / Lambda /
 *   Vercel function) that holds the key server-side, enforces a rate limit, and forwards to the real
 *   OpenAI-compatible endpoint. Leave `apiKey` undefined; the proxy injects it.
 * - For personal use, let the user paste their own key into a field and keep it in `localStorage`.
 *   It is then their key, their quota and their choice — which is a different trust story from
 *   shipping yours.
 *
 * Nothing in this file reads ambient configuration. `baseUrl`, `model` and `apiKey` arrive in an
 * injected `ExtractorConfig`, and `fetchImpl` can be overridden so the prompt builder and parser are
 * testable with no network and no key (see `scripts/check-extract.mts`).
 *
 * ## The model
 *
 * Written against Qwen3-8B over any OpenAI-compatible `/chat/completions` endpoint (vLLM, SGLang,
 * Ollama, OpenRouter, Together, …). Provider-specific niceties are opt-in, never assumed:
 * structured output is negotiated down a ladder (`json_schema` -> `json_object` -> plain
 * instruction), and Qwen3's `<think>` blocks are stripped from the reply whichever mode is in use.
 * To turn Qwen3's thinking off at the server, pass
 * `extraBody: {chat_template_kwargs: {enable_thinking: false}}` (vLLM/SGLang) — it is faster and the
 * extraction does not benefit from it.
 */

import type { KnowledgeBase } from './kernel.js';
import { buildScene } from './resolve.js';

// --------------------------------------------------------------------------- the wire shapes

/**
 * What `buildScene` eats — the same shape the corpus YAML authors by hand, where every value is a
 * human-unit string the kernel's quantity parser will read.
 *
 * ```yaml
 * instances:
 *   - {id: q1, kind: point_charge, set: {em.charge: "2.0 uC"}}
 * relations:
 *   - {kind: acts_on, from: q1, to: p1, set: {geometry.separation: "30 cm"}}
 * ```
 */
export interface SceneSpec {
  instances: SceneInstanceSpec[];
  relations: SceneRelationSpec[];
}

export interface SceneInstanceSpec {
  id: string;
  kind: string;
  label?: string;
  /** `"prop"` or `"prop@initial"` -> a quantity string. Never a parsed number. */
  set: Record<string, string>;
}

export interface SceneRelationSpec {
  kind: string;
  from: string;
  to: string;
  set: Record<string, string>;
}

/** One property of one instance at one state — what the resolver resolves. */
export interface TargetRef {
  instance: string;
  prop: string;
  state?: 'initial' | 'final';
}

/** `p.kinematics.speed@final`, the form the kernel prints and `SimSpec.target` carries. */
export const formatTarget = (t: TargetRef): string =>
  `${t.instance}.${t.prop}${t.state ? `@${t.state}` : ''}`;

/**
 * The scene type as `./resolve.js` actually defines it. Derived from the function rather than
 * imported by name, so this file does not break if a sibling agent renames its exported type.
 */
export type ValidatedScene = ReturnType<typeof buildScene>;

/**
 * The deliberate seam between two independently written files. The task fixes the call
 * (`buildScene(spec, kb)`) but not the name or exact shape of `resolve.ts`'s own parameter type, and
 * a typecheck of this file must not depend on a sibling's private naming choices. The *return* type
 * above is the real one, so callers still get real types out.
 */
const validate = buildScene as unknown as (spec: SceneSpec, kb: KnowledgeBase) => ValidatedScene;

/** Fixed by the Python kernel (`kernel/kb.py::STATES`); a state is per-binding, never a property. */
export const STATES = ['initial', 'final'] as const;
export type State = (typeof STATES)[number];

// --------------------------------------------------------------------------- configuration

/**
 * A minimal structural `fetch`. Narrower than the DOM lib's on purpose: it is trivial to stub in a
 * node script, and the global `fetch` satisfies it without a cast.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}>;

/**
 * How hard we lean on the provider to constrain the output.
 *
 * - `json_schema` — constrained decoding against our derived schema. Best; needs vLLM/SGLang
 *   (xgrammar/outlines), OpenRouter or OpenAI.
 * - `json_object` — "valid JSON" only; the vocabulary rides on the prompt.
 * - `none` — nothing but the prompt instruction. Always available, always parsed tolerantly.
 * - `auto` — start at `json_schema` and step down on a provider rejection.
 */
export type ResponseFormatMode = 'auto' | 'json_schema' | 'json_object' | 'none';

/** Everything the boundary needs, injected. Never read from the environment. See the file header. */
export interface ExtractorConfig {
  /** OpenAI-compatible base, with or without a trailing slash: `https://your-proxy.example/v1`. */
  baseUrl: string;
  /** Served model id, e.g. `"qwen3-8b"` or `"Qwen/Qwen3-8B"`. */
  model: string;
  /** Omit when a serverless proxy injects the key. Never a literal in this repo. */
  apiKey?: string;
  /** Default 0 — extraction is transcription, not invention. */
  temperature?: number;
  topP?: number;
  /** Default 2048. A scene is small; thinking tokens are not. */
  maxTokens?: number;
  /** Total model calls, including repairs. Default 3, clamped to 1..6. */
  maxAttempts?: number;
  /** Per-request timeout. Default 60_000. */
  timeoutMs?: number;
  /** Extra headers, e.g. `HTTP-Referer` for OpenRouter. */
  headers?: Readonly<Record<string, string>>;
  /** Merged into the request body — e.g. `{chat_template_kwargs: {enable_thinking: false}}`. */
  extraBody?: Readonly<Record<string, unknown>>;
  /** Default `'auto'`. */
  responseFormat?: ResponseFormatMode;
  /** Test/SSR override. Defaults to the global `fetch`. */
  fetchImpl?: FetchLike;
  /** Caller-owned cancellation, combined with the per-request timeout. */
  signal?: AbortSignal;
  /** Progress callback; fired once per attempt, after it is scored. */
  onAttempt?: (attempt: ExtractAttempt) => void;
}

// --------------------------------------------------------------------------- results

export interface ExtractAttempt {
  /** 1-based. */
  n: number;
  mode: Exclude<ResponseFormatMode, 'auto'>;
  /** Raw assistant text, `<think>` stripped. Empty when the call itself failed. */
  raw: string;
  /** Validator / parser errors this attempt produced. Empty means it passed. */
  errors: string[];
  /** Non-fatal observations: duplicate keys dropped, a target the kb cannot reach, … */
  warnings: string[];
  ok: boolean;
  ms: number;
  /** Token usage if the provider reported it. */
  usage?: { prompt?: number; completion?: number; total?: number };
}

export interface ExtractResult {
  /** True only if `buildScene` accepted the spec and the target validated. */
  ok: boolean;
  /** Present iff `ok`. The validated scene, typed by `resolve.ts`. */
  scene?: ValidatedScene;
  /**
   * Always present. On failure this is the best partial understanding — possibly
   * `{instances: [], relations: []}` — so the UI can open its builder with whatever was read.
   */
  sceneSpec: SceneSpec;
  /** Present when a syntactically valid target was read, even if the scene was rejected. */
  target?: TargetRef;
  /** Human-readable, in the kernel's own wording. Empty iff `ok`. */
  errors: string[];
  /** One entry per model call; `attempts.length` is the count. */
  attempts: ExtractAttempt[];
  /** Raw text of the last attempt, for a "show me what the model said" affordance. */
  raw: string;
  /** Free-text assumptions the model declared it had to make. Shown, never trusted. */
  assumptions: string[];
  /** The model's own note about what it was unsure of. */
  notes: string;
}

// --------------------------------------------------------------------------- the catalogue

export interface CatalogueSlot {
  prop: string;
  required: boolean;
  /** The component's own default, as authored (`"-1.602176634e-19 C"`). */
  default: string | null;
}

export interface CatalogueComponent {
  kind: string;
  label: string;
  tags: string[];
  /** First sentence of the kb description — enough to choose `electron` over `charged_particle`. */
  summary: string;
  /** `role: settable` slots the problem is expected to state. */
  settable: CatalogueSlot[];
  /** `role: observable` slots: legal targets, and legal givens only as `prop@initial`. */
  observable: string[];
  /** `role: intrinsic` slots: arrive stocked, must not be restated. */
  intrinsic: CatalogueSlot[];
}

export interface CatalogueRelation {
  kind: string;
  /** Component kinds a formula role will accept at the far end. */
  farEndKinds: string[];
  /** Properties this relation makes derivable. */
  enables: string[];
  /** How to read the direction in English. Absent for a relation kind we have no phrasing for. */
  reads?: string;
}

export interface CatalogueProperty {
  prop: string;
  symbol: string;
  unit: string;
  rank: 'scalar' | 'vector';
  kind: 'lumped' | 'field' | 'pair';
  /** True when some formula can produce it. A target with no producer is a dead end. */
  producible: boolean;
}

export interface Catalogue {
  /** `kb.contentHash` — a catalogue is only valid for the bundle it came from. */
  hash: string;
  components: CatalogueComponent[];
  relations: CatalogueRelation[];
  properties: CatalogueProperty[];
  states: readonly State[];
  /** The compact vocabulary block that goes into the system prompt. */
  text: string;
}

/**
 * Direction annotations, keyed by relation kind.
 *
 * These are *annotations on a derived set*, never the source of truth: the set of relation kinds
 * comes from `kb.formulas[].roles[].via`, and a kind with no entry here is still listed, just
 * without an English reading. Add a `via` to the Python kb and this file keeps working.
 *
 * (The chain resolver searches both directions — `relations_from` and `relations_into` — so a
 * reversed relation still binds. The phrasing is here to make the common case read naturally in the
 * scene builder, not to gate validity.)
 */
const RELATION_READINGS: Readonly<Record<string, string>> = {
  acts_on: 'from = the source, to = the object or probe it acts on',
  inside: 'from = the object in the region, to = the region',
  inside_cavity_of: 'from = the object in the cavity, to = the body containing the cavity',
  series_a: 'from = the series_pair, to = its first member',
  series_b: 'from = the series_pair, to = its second member',
  parallel_a: 'from = the parallel_pair, to = its first member',
  parallel_b: 'from = the parallel_pair, to = its second member',
  loads: 'from = the circuit_loop, to = the load it drives',
  driven_by: 'from = the circuit_loop, to = the battery driving it',
  charged_through: 'from = the capacitor, to = the resistor it charges through',
};

const firstSentence = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  const stop = flat.search(/\.(\s|$)/);
  const cut = stop === -1 ? flat : flat.slice(0, stop + 1);
  return cut.length > 180 ? `${cut.slice(0, 177).trimEnd()}…` : cut;
};

/**
 * Derive the entire extraction vocabulary from the knowledge base.
 *
 * Exported so it can be unit-tested and eyeballed: `buildCatalogue(kb).text` is literally what the
 * model is shown. Nothing about physics is encoded here — only a re-projection of `kb.json`.
 */
export function buildCatalogue(kb: KnowledgeBase): Catalogue {
  // Which properties some formula can produce. `kb.solvers` is the kernel's own index.
  const producible = new Set<string>();
  for (const [prop, formulaKeys] of Object.entries(kb.solvers ?? {})) {
    if (formulaKeys && formulaKeys.length > 0) producible.add(prop);
  }

  const properties: CatalogueProperty[] = Object.entries(kb.properties)
    .map(([prop, def]) => ({
      prop,
      symbol: def.symbol,
      unit: def.unit,
      rank: def.rank,
      kind: def.kind,
      producible: producible.has(prop),
    }))
    .sort((a, b) => a.prop.localeCompare(b.prop));

  const components: CatalogueComponent[] = Object.entries(kb.components)
    .map(([kind, def]) => {
      const settable: CatalogueSlot[] = [];
      const observable: string[] = [];
      const intrinsic: CatalogueSlot[] = [];
      for (const [prop, slot] of Object.entries(def.slots)) {
        if (slot.role === 'settable') {
          settable.push({ prop, required: slot.required, default: slot.default });
        } else if (slot.role === 'observable') {
          observable.push(prop);
        } else {
          intrinsic.push({ prop, required: slot.required, default: slot.default });
        }
      }
      const byProp = (a: CatalogueSlot, b: CatalogueSlot) => a.prop.localeCompare(b.prop);
      return {
        kind,
        label: def.label,
        tags: [...def.tags],
        summary: firstSentence(def.description ?? ''),
        // Required slots first: that is the order a problem statement is read in.
        settable: settable.sort((a, b) => Number(b.required) - Number(a.required) || byProp(a, b)),
        observable: observable.sort((a, b) => a.localeCompare(b)),
        intrinsic: intrinsic.sort(byProp),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind));

  // Relation kinds are whatever the physics can actually bind through: every non-null `via` on
  // every formula role. Computed, never listed.
  const viaKinds = new Map<string, { farEnd: Set<string>; enables: Set<string> }>();
  for (const formula of Object.values(kb.formulas)) {
    for (const role of Object.values(formula.roles ?? {})) {
      const via = role?.via;
      if (typeof via !== 'string' || via.length === 0) continue;
      let entry = viaKinds.get(via);
      if (!entry) {
        entry = { farEnd: new Set(), enables: new Set() };
        viaKinds.set(via, entry);
      }
      for (const k of role.kinds ?? []) entry.farEnd.add(k);
      if (formula.solvesFor) entry.enables.add(formula.solvesFor);
    }
  }

  const relations: CatalogueRelation[] = [...viaKinds.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, entry]) => {
      const reads = RELATION_READINGS[kind];
      return {
        kind,
        farEndKinds: [...entry.farEnd].sort(),
        enables: [...entry.enables].sort(),
        ...(reads ? { reads } : {}),
      };
    });

  const catalogue: Catalogue = {
    hash: kb.contentHash,
    components,
    relations,
    properties,
    states: STATES,
    text: '',
  };
  return { ...catalogue, text: renderCatalogue(catalogue) };
}

/** The compact vocabulary block. Kept terse: an 8B model reads a table far better than prose. */
function renderCatalogue(cat: Catalogue): string {
  const out: string[] = [];

  out.push('## PROPERTIES  (key | symbol | unit to write values in | rank | solvable?)');
  for (const p of cat.properties) {
    out.push(
      `  ${p.prop} | ${p.symbol} | ${p.unit || '(dimensionless)'} | ${p.rank}` +
        `${p.producible ? '' : ' | NOT SOLVABLE — never a target'}`,
    );
  }

  out.push('');
  out.push('## COMPONENTS  (kind — label [tags])');
  out.push('##   set:   properties this kind accepts as givens  (* = required)');
  out.push('##   solve: properties solving produces — legal targets; as a given only `prop@initial`');
  out.push('##   auto:  arrives stocked with these; do NOT restate them');
  for (const c of cat.components) {
    out.push(`  ${c.kind} — ${c.label} [${c.tags.join(', ')}]`);
    if (c.summary) out.push(`      ${c.summary}`);
    const set = c.settable.map((s) => (s.required ? `${s.prop}*` : s.prop));
    out.push(`      set:   ${set.length > 0 ? set.join(', ') : '(nothing)'}`);
    if (c.observable.length > 0) out.push(`      solve: ${c.observable.join(', ')}`);
    if (c.intrinsic.length > 0) {
      out.push(`      auto:  ${c.intrinsic.map((s) => `${s.prop}=${s.default ?? '?'}`).join(', ')}`);
    }
  }

  out.push('');
  out.push('## RELATIONS  (kind | direction | far end must be one of | makes derivable)');
  for (const r of cat.relations) {
    out.push(
      `  ${r.kind} | ${r.reads ?? 'from = the subject, to = the other end'} | ` +
        `${r.farEndKinds.join(', ') || 'any'} | ${r.enables.join(', ')}`,
    );
  }

  return out.join('\n');
}

// --------------------------------------------------------------------------- the output schema

/**
 * JSON schema for the reply, with the catalogue baked in as `enum`s.
 *
 * Two shape decisions matter:
 *
 * - `set` is an **array of `{prop, state, value}`**, not a free-form object. A map keyed by property
 *   name cannot be expressed in a closed schema (OpenAI strict mode forbids open
 *   `additionalProperties`, and several grammar backends handle it poorly), whereas an array of
 *   entries lets `prop` be an `enum` of real property keys. Under constrained decoding the model
 *   then *cannot* emit a property that does not exist.
 * - every property is `required` and every object is `additionalProperties: false`, which is what
 *   OpenAI-compatible `strict: true` demands. "No state" is the empty string rather than `null`,
 *   because `null` in a union type is the part grammar backends disagree about most.
 */
export function buildResponseSchema(cat: Catalogue): Record<string, unknown> {
  const propKeys = cat.properties.map((p) => p.prop);
  const stateEnum = ['', ...cat.states];

  const setEntry = {
    type: 'object',
    description: 'One given. `value` is a quantity string with its unit, exactly as stated.',
    properties: {
      prop: { type: 'string', enum: propKeys },
      state: {
        type: 'string',
        enum: stateEnum,
        description: '"" normally; "initial" for a stated starting condition; "final" is a target.',
      },
      value: {
        type: 'string',
        description: 'e.g. "2.0 uC", "30 cm", "0 m/s", "[0, 0, -9.81] m/s^2". Never a bare number.',
      },
    },
    required: ['prop', 'state', 'value'],
    additionalProperties: false,
  };

  return {
    type: 'object',
    properties: {
      instances: {
        type: 'array',
        description: 'Every object the problem places. One per physical object, plus any tool.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Short, unique, lowercase: q1, e1, cap, r1, loop.' },
            kind: { type: 'string', enum: cat.components.map((c) => c.kind) },
            label: { type: 'string', description: 'Optional display name; "" to use the default.' },
            set: { type: 'array', items: setEntry },
          },
          required: ['id', 'kind', 'label', 'set'],
          additionalProperties: false,
        },
      },
      relations: {
        type: 'array',
        description: 'How the instances are connected. Omit entries you are unsure of.',
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: cat.relations.map((r) => r.kind) },
            from: { type: 'string', description: 'An instance id declared above.' },
            to: { type: 'string', description: 'An instance id declared above.' },
            set: { type: 'array', items: setEntry },
          },
          required: ['kind', 'from', 'to', 'set'],
          additionalProperties: false,
        },
      },
      target: {
        type: 'object',
        description: 'The single quantity the question asks for.',
        properties: {
          instance: { type: 'string' },
          prop: { type: 'string', enum: propKeys },
          state: { type: 'string', enum: stateEnum },
        },
        required: ['instance', 'prop', 'state'],
        additionalProperties: false,
      },
      assumptions: {
        type: 'array',
        description: 'Anything you had to assume because the problem did not say it.',
        items: { type: 'string' },
      },
      notes: { type: 'string', description: 'What you were unsure about. "" if nothing.' },
    },
    required: ['instances', 'relations', 'target', 'assumptions', 'notes'],
    additionalProperties: false,
  };
}

// --------------------------------------------------------------------------- the prompt

const SYSTEM_RULES = `You translate a physics problem into a SCENE for a deterministic physics kernel.

You are a transcriber, not a solver. The kernel does all the physics.

HARD RULES
1. NEVER compute, estimate, simplify or answer anything. No arithmetic. No unit conversion.
   Copy each number and its unit exactly as the problem states them: "2.0 uC" stays "2.0 uC",
   "30 cm" stays "30 cm". Writing "0.3 m" instead of "30 cm" is an error even though it is equal.
2. Use ONLY the component kinds, property keys and relation kinds in the catalogue below.
   If the problem needs something the catalogue does not have, choose the closest kind and say so
   in "notes". Never invent a key.
3. Set a property only where the catalogue lists it under "set:" for that kind. A property under
   "solve:" is produced by solving — setting it would be asserting the answer. The one exception is
   a stated starting condition, which goes in with state "initial" ("released from rest" ->
   kinematics.speed, state "initial", value "0 m/s").
4. Do NOT restate anything under "auto:". An electron already carries its charge and mass.
5. "target" is the ONE quantity the question asks for. Use state "final" when the question asks
   for a value after something happens ("how fast is it moving when it reaches..."), otherwise "".
6. Write a vector as a bracketed triple with a unit: "[0, 0, -9.81] m/s^2". A magnitude is a
   separate scalar property — read the property list and pick the right rank.
7. Distances BETWEEN two objects belong on the relation, not on either object.
8. Prefer the most specific kind. A named particle kind beats a generic one when the problem names
   it, because the specific kind arrives stocked with its own constants.
9. Reply with JSON only. No prose, no markdown fence, no explanation outside the JSON.`;

/** The shape example is built from the live catalogue, so it can never drift from the vocabulary. */
function renderShapeExample(cat: Catalogue): string {
  const withRequired = cat.components.find((c) => c.settable.some((s) => s.required));
  const anySettable = cat.components.find((c) => c.settable.length > 0);
  const host = withRequired ?? anySettable ?? cat.components[0];
  const slot = host?.settable[0]?.prop ?? cat.properties[0]?.prop ?? 'geometry.length';
  const unit = cat.properties.find((p) => p.prop === slot)?.unit ?? '';
  const solvable = cat.properties.find((p) => p.producible);
  const targetProp = host?.observable[0] ?? solvable?.prop ?? slot;
  const relation = cat.relations[0];

  const example = {
    instances: [
      {
        id: 'a1',
        kind: host?.kind ?? 'environment',
        label: '',
        set: [{ prop: slot, state: '', value: `12 ${unit}`.trim() }],
      },
      { id: 'b1', kind: relation?.farEndKinds[0] ?? (host?.kind ?? 'environment'), label: '', set: [] },
    ],
    relations: relation
      ? [{ kind: relation.kind, from: 'a1', to: 'b1', set: [] as unknown[] }]
      : ([] as unknown[]),
    target: { instance: 'a1', prop: targetProp, state: '' },
    assumptions: [],
    notes: '',
  };

  return `REPLY SHAPE (this example shows the shape only — it is not physics):\n${JSON.stringify(
    example,
    null,
    2,
  )}`;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * The opening two messages. Exported so a test can assert the vocabulary actually reached the
 * prompt without standing up a server.
 */
export function buildPrompt(text: string, cat: Catalogue, mode: ResponseFormatMode): ChatMessage[] {
  const jsonOnly =
    mode === 'json_schema'
      ? ''
      : '\n\nYour entire reply must be one JSON object and nothing else. Do not wrap it in ```.';

  return [
    {
      role: 'system',
      content: `${SYSTEM_RULES}\n\n${cat.text}\n\n${renderShapeExample(cat)}${jsonOnly}`,
    },
    { role: 'user', content: `PROBLEM\n${text.trim()}\n\nExtract the scene.` },
  ];
}

/** The repair turn: hand the validator's own wording back, because it already names the fix. */
function buildRepairMessages(raw: string, errors: string[]): ChatMessage[] {
  return [
    { role: 'assistant', content: raw || '(no reply)' },
    {
      role: 'user',
      content:
        'The physics kernel REJECTED that scene. Each line is the kernel speaking; it names what ' +
        'is wrong and usually what is allowed instead.\n\n' +
        errors.map((e) => `- ${e}`).join('\n') +
        '\n\nFix exactly these problems and reply with the complete corrected JSON object. Keep ' +
        'everything that was not complained about, including the original unit strings.',
    },
  ];
}

// --------------------------------------------------------------------------- parsing the reply

/** Qwen3 emits a reasoning block; some servers also leave an unterminated one on a cut-off reply. */
export function stripThinking(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '')
    .replace(/<think>[\s\S]*$/i, '')
    .trim();
}

/** Strip a markdown fence, with or without a language tag. */
function stripFence(text: string): string {
  const fenced = /```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```/.exec(text);
  return (fenced?.[1] ?? text).trim();
}

/**
 * The first balanced JSON object in a string, respecting string literals and escapes.
 *
 * Needed because a small model under a plain instruction will occasionally prepend a sentence, and
 * a greedy `/{[\s\S]*}/` grabs trailing commentary that then fails to parse.
 */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** What the model is asked to produce, before any normalisation. */
interface RawSetEntry {
  prop?: unknown;
  state?: unknown;
  value?: unknown;
}

interface RawExtraction {
  instances?: unknown;
  relations?: unknown;
  target?: unknown;
  assumptions?: unknown;
  notes?: unknown;
}

/** Tolerant JSON read. Returns a message instead of throwing — this is a boundary, not a parser. */
export function parseExtraction(text: string): { value: RawExtraction } | { error: string } {
  const cleaned = stripFence(stripThinking(text));
  if (cleaned.length === 0) return { error: 'the model returned an empty reply' };

  const candidates = [cleaned, firstJsonObject(cleaned)].filter(
    (c): c is string => typeof c === 'string' && c.length > 0,
  );
  let last = 'no JSON object found in the reply';
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        last = 'the reply parsed as JSON but was not an object';
        continue;
      }
      return { value: parsed as RawExtraction };
    } catch (err) {
      last = `the reply is not valid JSON: ${(err as Error).message}`;
    }
  }
  return { error: last };
}

// --------------------------------------------------------------------------- normalisation

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(asString).filter((s) => s.length > 0) : [];

const asState = (v: unknown): State | undefined => {
  const s = asString(v);
  return (STATES as readonly string[]).includes(s) ? (s as State) : undefined;
};

/**
 * `[{prop, state, value}]` -> `{"prop@state": "value"}`, the form `buildScene` reads.
 *
 * Also accepts the object form `{"em.charge": "2.0 uC"}`, because a model running without
 * constrained decoding writes that about a third of the time and it is unambiguous.
 */
function normaliseSet(raw: unknown, where: string, warnings: string[]): Record<string, string> {
  const set: Record<string, string> = {};
  const put = (key: string, value: string) => {
    if (key.length === 0 || value.length === 0) return;
    if (key in set && set[key] !== value) {
      warnings.push(`${where}: ${key} was given twice ("${set[key]}" then "${value}"); kept the last`);
    }
    set[key] = value;
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (entry === null || typeof entry !== 'object') continue;
      const e = entry as RawSetEntry;
      const prop = asString(e.prop);
      const state = asState(e.state);
      put(state ? `${prop}@${state}` : prop, asString(e.value));
    }
    return set;
  }

  if (raw !== null && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      put(asString(key), typeof value === 'number' ? String(value) : asString(value));
    }
  }
  return set;
}

interface Normalised {
  spec: SceneSpec;
  target?: TargetRef;
  assumptions: string[];
  notes: string;
  warnings: string[];
  /** Problems that make the spec unusable before the validator even sees it. */
  errors: string[];
}

/**
 * Shape-level normalisation only. Everything physical — does this kind carry this property, is the
 * dimension right, is the rank right — is `buildScene`'s to judge, and is deliberately not
 * duplicated here.
 */
function normalise(raw: RawExtraction): Normalised {
  const warnings: string[] = [];
  const errors: string[] = [];

  const instances: SceneInstanceSpec[] = [];
  const seen = new Set<string>();
  const rawInstances = Array.isArray(raw.instances) ? raw.instances : [];
  if (!Array.isArray(raw.instances)) errors.push('the reply has no `instances` array');

  for (const [i, entry] of rawInstances.entries()) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { id?: unknown; kind?: unknown; label?: unknown; set?: unknown };
    const id = asString(e.id) || `i${i + 1}`;
    if (seen.has(id)) {
      errors.push(`duplicate instance id ${JSON.stringify(id)}`);
      continue;
    }
    seen.add(id);
    const label = asString(e.label);
    instances.push({
      id,
      kind: asString(e.kind),
      ...(label ? { label } : {}),
      set: normaliseSet(e.set, id, warnings),
    });
  }
  if (instances.length === 0 && errors.length === 0) {
    errors.push('the reply placed no instances, so there is no scene to validate');
  }

  const relations: SceneRelationSpec[] = [];
  for (const entry of Array.isArray(raw.relations) ? raw.relations : []) {
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { kind?: unknown; from?: unknown; to?: unknown; set?: unknown };
    const kind = asString(e.kind);
    const from = asString(e.from);
    const to = asString(e.to);
    if (kind.length === 0 || from.length === 0 || to.length === 0) {
      warnings.push(
        `dropped a relation missing kind/from/to: ${JSON.stringify({ kind, from, to })}`,
      );
      continue;
    }
    relations.push({ kind, from, to, set: normaliseSet(e.set, `relation ${kind}`, warnings) });
  }

  let target: TargetRef | undefined;
  const rawTarget = raw.target;
  if (rawTarget !== null && typeof rawTarget === 'object' && !Array.isArray(rawTarget)) {
    const t = rawTarget as { instance?: unknown; prop?: unknown; state?: unknown };
    const instance = asString(t.instance);
    const prop = asString(t.prop);
    const state = asState(t.state);
    if (instance.length > 0 && prop.length > 0) {
      target = { instance, prop, ...(state ? { state } : {}) };
    }
  }
  if (!target) {
    errors.push(
      'the reply has no usable `target`: it needs {instance, prop, state} naming the one ' +
        'quantity the question asks for',
    );
  }

  return {
    spec: { instances, relations },
    ...(target ? { target } : {}),
    assumptions: asStringArray(raw.assumptions),
    notes: asString(raw.notes),
    warnings,
    errors,
  };
}

/**
 * Validate the target the way `kernel/scene.py::load_problem` does, plus one reachability check.
 *
 * This is the only validation this file owns, because `buildScene` never sees the target. It is
 * pure bookkeeping against `kb` — no physics is computed, and the wording matches the kernel's so
 * the repair turn reads as one voice.
 */
function validateTarget(target: TargetRef, spec: SceneSpec, kb: KnowledgeBase): string[] {
  const errors: string[] = [];
  const prop = kb.properties[target.prop];

  if (!prop) {
    errors.push(`target names unknown property ${JSON.stringify(target.prop)}`);
  }

  const instance = spec.instances.find((i) => i.id === target.instance);
  if (!instance) {
    const ids = spec.instances.map((i) => i.id).join(', ') || '(none)';
    errors.push(
      `target names unknown instance ${JSON.stringify(target.instance)}. The scene declares: ${ids}`,
    );
  }

  if (prop && instance) {
    const given = Object.keys(instance.set).some(
      (key) => key === target.prop || key.startsWith(`${target.prop}@`),
    );
    const producible = (kb.solvers?.[target.prop] ?? []).length > 0;
    if (!producible && !given) {
      const component = kb.components[instance.kind];
      const solvable = component
        ? Object.entries(component.slots)
            .filter(([p, s]) => s.role === 'observable' && (kb.solvers?.[p] ?? []).length > 0)
            .map(([p]) => p)
        : [];
      errors.push(
        `nothing in the knowledge base produces ${JSON.stringify(target.prop)} and the scene does ` +
          `not give it, so that target cannot be reached. A ${JSON.stringify(instance.kind)} can ` +
          `be solved for: ${solvable.join(', ') || '(nothing — pick a different instance)'}`,
      );
    }
  }

  return errors;
}

// --------------------------------------------------------------------------- the API call

interface ChatResponse {
  choices?: Array<{
    message?: { content?: unknown; reasoning_content?: unknown };
    finish_reason?: unknown;
  }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
  error?: { message?: unknown } | string;
}

const chatUrl = (baseUrl: string): string => {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`;
};

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Text out of a reply, tolerating the array-of-parts content shape some gateways return. */
function messageText(res: ChatResponse): string {
  const content = res.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part !== null && typeof part === 'object' && 'text' in part
          ? asString((part as { text?: unknown }).text)
          : '',
      )
      .join('');
  }
  return '';
}

class ApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, statusText: string, body: string) {
    super(`the model endpoint returned ${status} ${statusText}`.trim());
    this.status = status;
    this.body = body;
  }
}

/** A 4xx that is specifically a complaint about `response_format`, so the ladder can step down. */
const isResponseFormatRejection = (err: unknown): boolean => {
  if (!(err instanceof ApiError)) return false;
  if (err.status < 400 || err.status >= 500) return false;
  return /response_format|json_schema|json_object|guided|grammar|structured|schema/i.test(err.body);
};

const defaultFetch: FetchLike = (url, init) =>
  // Wrapped rather than passed by reference: an unbound `fetch` is not callable in every engine.
  fetch(url, init) as unknown as ReturnType<FetchLike>;

async function callModel(
  messages: ChatMessage[],
  mode: Exclude<ResponseFormatMode, 'auto'>,
  schema: Record<string, unknown>,
  config: ExtractorConfig,
): Promise<{ text: string; usage?: ExtractAttempt['usage'] }> {
  const doFetch = config.fetchImpl ?? defaultFetch;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature ?? 0,
    max_tokens: config.maxTokens ?? 2048,
    stream: false,
    ...(config.topP === undefined ? {} : { top_p: config.topP }),
    ...(mode === 'json_schema'
      ? {
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'fieldforge_scene', strict: true, schema },
          },
        }
      : {}),
    ...(mode === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
    ...(config.extraBody ?? {}),
  };

  const controller = new AbortController();
  const timeoutMs = config.timeoutMs ?? 60_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const external = config.signal;
  const relay = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', relay);
  }

  try {
    const res = await doFetch(chatUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...(config.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new ApiError(res.status, res.statusText ?? '', text);

    let parsed: ChatResponse;
    try {
      parsed = JSON.parse(text) as ChatResponse;
    } catch {
      throw new Error('the model endpoint returned a body that is not JSON');
    }
    if (parsed.error !== undefined) {
      const message =
        typeof parsed.error === 'string' ? parsed.error : asString(parsed.error.message);
      throw new Error(`the model endpoint reported an error: ${message || 'unspecified'}`);
    }

    const usage = parsed.usage
      ? {
          ...(num(parsed.usage.prompt_tokens) === undefined
            ? {}
            : { prompt: num(parsed.usage.prompt_tokens) }),
          ...(num(parsed.usage.completion_tokens) === undefined
            ? {}
            : { completion: num(parsed.usage.completion_tokens) }),
          ...(num(parsed.usage.total_tokens) === undefined
            ? {}
            : { total: num(parsed.usage.total_tokens) }),
        }
      : undefined;

    return { text: messageText(parsed), ...(usage ? { usage } : {}) };
  } finally {
    clearTimeout(timer);
    if (external) external.removeEventListener('abort', relay);
  }
}

// --------------------------------------------------------------------------- the boundary itself

export interface ExtractOptions {
  kb: KnowledgeBase;
  config: ExtractorConfig;
  /** Reuse a catalogue across calls instead of re-deriving it. Must match `kb.contentHash`. */
  catalogue?: Catalogue;
}

const MODE_LADDER: Array<Exclude<ResponseFormatMode, 'auto'>> = ['json_schema', 'json_object', 'none'];

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Turn a student's prose into a validated `Scene`, or into an honest account of why not.
 *
 * Resolves — never rejects. Up to `maxAttempts` model calls: the first extracts, each later one is
 * handed the validator's own error text, which is specific enough (*"a 'point_charge' does not
 * carry 'mechanics.mass'. It carries: …"*) that a small model usually repairs itself in one turn.
 *
 * On failure the caller still gets `sceneSpec` — whatever was understood — so the UI opens its
 * structured scene builder pre-filled instead of showing a dead end. A wrong extraction must
 * surface as an editable scene, never as a wrong number presented as truth.
 */
export async function extractScene(text: string, options: ExtractOptions): Promise<ExtractResult> {
  const { kb, config } = options;
  const attempts: ExtractAttempt[] = [];

  const fail = (errors: string[], partial?: Partial<ExtractResult>): ExtractResult => ({
    ok: false,
    sceneSpec: { instances: [], relations: [] },
    errors,
    attempts,
    raw: '',
    assumptions: [],
    notes: '',
    ...partial,
  });

  const problem = text.trim();
  if (problem.length === 0) return fail(['no problem text was given']);
  if (!config.baseUrl || !config.model) {
    return fail([
      'the extractor is not configured: `baseUrl` and `model` are required. Point `baseUrl` at a ' +
        'serverless proxy that holds the API key, or supply a user-pasted key as `apiKey`.',
    ]);
  }

  let catalogue: Catalogue;
  try {
    catalogue =
      options.catalogue && options.catalogue.hash === kb.contentHash
        ? options.catalogue
        : buildCatalogue(kb);
  } catch (err) {
    return fail([`cannot read the knowledge base: ${(err as Error).message}`]);
  }
  if (catalogue.components.length === 0) {
    return fail(['the knowledge base declares no components, so there is no vocabulary to extract into']);
  }

  const schema = buildResponseSchema(catalogue);
  const maxAttempts = clamp(Math.trunc(config.maxAttempts ?? 3), 1, 6);
  const requested = config.responseFormat ?? 'auto';
  let modeIndex = requested === 'auto' ? 0 : MODE_LADDER.indexOf(requested);
  if (modeIndex < 0) modeIndex = 0;
  // Stepping down the ladder is a provider-capability retry, not a repair, so it gets its own
  // small budget and does not spend an attempt the student is waiting on.
  let downgrades = requested === 'auto' ? MODE_LADDER.length - 1 : 0;

  let messages = buildPrompt(problem, catalogue, MODE_LADDER[modeIndex] ?? 'none');
  let best: ExtractResult | null = null;

  for (let n = 1; n <= maxAttempts; n += 1) {
    const mode = MODE_LADDER[modeIndex] ?? 'none';
    const started = Date.now();

    let raw = '';
    let usage: ExtractAttempt['usage'];
    try {
      const reply = await callModel(messages, mode, schema, config);
      raw = stripThinking(reply.text);
      usage = reply.usage;
    } catch (err) {
      if (isResponseFormatRejection(err) && downgrades > 0) {
        downgrades -= 1;
        modeIndex = Math.min(modeIndex + 1, MODE_LADDER.length - 1);
        const next = MODE_LADDER[modeIndex] ?? 'none';
        messages = buildPrompt(problem, catalogue, next);
        attempts.push({
          n,
          mode,
          raw: '',
          errors: [`the endpoint rejected ${mode}; retrying with ${next}`],
          warnings: [],
          ok: false,
          ms: Date.now() - started,
        });
        config.onAttempt?.(attempts[attempts.length - 1]!);
        n -= 1; // a capability negotiation, not an extraction attempt
        continue;
      }
      const aborted = config.signal?.aborted === true;
      const message = aborted
        ? 'the request was cancelled'
        : err instanceof ApiError
          ? `${err.message}${err.body ? `: ${err.body.slice(0, 400)}` : ''}`
          : `the model call failed: ${(err as Error).message}`;
      const attempt: ExtractAttempt = {
        n,
        mode,
        raw: '',
        errors: [message],
        warnings: [],
        ok: false,
        ms: Date.now() - started,
      };
      attempts.push(attempt);
      config.onAttempt?.(attempt);
      best ??= fail([message]);
      if (aborted) break;
      continue;
    }

    const record = (errors: string[], warnings: string[], ok: boolean): ExtractAttempt => {
      const attempt: ExtractAttempt = {
        n,
        mode,
        raw,
        errors,
        warnings,
        ok,
        ms: Date.now() - started,
        ...(usage ? { usage } : {}),
      };
      attempts.push(attempt);
      config.onAttempt?.(attempt);
      return attempt;
    };

    const parsed = parseExtraction(raw);
    if ('error' in parsed) {
      const errors = [parsed.error];
      record(errors, [], false);
      best ??= fail(errors, { raw });
      messages = [...messages, ...buildRepairMessages(raw, errors)];
      continue;
    }

    const normalised = normalise(parsed.value);
    const shape = { ...normalised, raw };

    // `buildScene` is the authority. We hand it the candidate and keep whatever it says, verbatim.
    let scene: ValidatedScene | undefined;
    const errors = [...normalised.errors];
    if (errors.length === 0) {
      try {
        scene = validate(normalised.spec, kb);
      } catch (err) {
        errors.push((err as Error).message);
      }
      if (normalised.target) errors.push(...validateTarget(normalised.target, normalised.spec, kb));
    }

    if (errors.length === 0 && scene !== undefined && normalised.target) {
      record([], shape.warnings, true);
      return {
        ok: true,
        scene,
        sceneSpec: normalised.spec,
        target: normalised.target,
        errors: [],
        attempts,
        raw,
        assumptions: normalised.assumptions,
        notes: normalised.notes,
      };
    }

    record(errors, shape.warnings, false);
    // Keep the richest partial we have seen: a later attempt can regress.
    const partial: ExtractResult = {
      ok: false,
      sceneSpec: normalised.spec,
      ...(normalised.target ? { target: normalised.target } : {}),
      errors,
      attempts,
      raw,
      assumptions: normalised.assumptions,
      notes: normalised.notes,
    };
    if (best === null || partial.sceneSpec.instances.length >= best.sceneSpec.instances.length) {
      best = partial;
    }
    messages = [...messages, ...buildRepairMessages(raw, errors)];
  }

  const result = best ?? fail(['extraction produced nothing usable']);
  // `attempts` is accumulated by reference above, but `best` may be an earlier snapshot.
  return { ...result, attempts };
}
