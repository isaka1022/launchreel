import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chatCompletion, type ChatMessage, type ChatResponse, type ToolCall } from '../drivers/gmi.js';
import { readableSpans } from '../ingest/activity.js';
import { footageDurations, type FootageItem } from '../ingest/footage.js';
import { cardNarrationAdvisories, narrationBudgetAdvisories, narrationLineAdvisories, onsetAdvisories, repeatedRangeAdvisories } from '../timeline/fit.js';
import type { Recording } from '../ingest/types.js';
import { cacheKey } from '../order/media.js';
import { formatZodIssues } from '../report.js';
import { reelSchema, type Reel, validateAgainstFootage, validateAgainstRecording, validateReel } from '../timeline/schema.js';
import { buildLongFormMessages, buildMessages, buildToolSchema, narrationBudgetChars } from './prompt.js';

/**
 * Turns evidence into a validated Reel by calling MiniMax M3 with a forced tool call, then
 * feeding any schema/validation failures straight back to the model until it produces something
 * that parses and passes validation, or `maxRepairs` runs out. Two entry points share the loop:
 * `designReel` for a single recording, `designLongFormReel` for a pitch plus a set of footage.
 */

const TOOL_NAME = 'emit_reel';
/** Shared with `understand/rewrite.ts`, which calls the same model for narration shortening. */
export const M3_MODEL = 'MiniMaxAI/MiniMax-M3';
const DEFAULT_TARGET_DURATION_SEC = 30;
const DEFAULT_MAX_REPAIRS = 2;
/** Long-form reels are designed from a pitch and several recordings; the extra structure needs more room to get right. */
const LONG_FORM_MAX_REPAIRS = 4;
/** A thirty-shot timeline is a long tool call, and the driver's default cuts it off mid-generation. */
const LONG_FORM_TIMEOUT_MS = 900_000;
/**
 * The endpoint defaults to 4096 completion tokens, which a long-form timeline overruns silently:
 * the response comes back `finish_reason: "length"` with no tool call at all, and every repair
 * attempt hits the same wall.
 */
const DESIGN_MAX_COMPLETION_TOKENS = 32_768;
/**
 * How many attempts may be spent on quality complaints rather than validation failures. One round
 * per group, so the model gets a single instruction at a time and the important one is not diluted
 * — which means this has to keep pace with the number of groups `advise` returns, or the last
 * group is only ever reported, never acted on.
 */
const MAX_ADVISORY_ROUNDS = 3;

export interface DesignOptions {
  targetDurationSec?: number;
  language?: 'en' | 'ja';
  allowGenerated?: boolean;
  maxRepairs?: number;
  baseUrl?: string;
  timeoutMs?: number;
  /** Directory to read/write a cached design result. Keyed on the recording + these options. */
  cacheDir?: string;
  /** When true, a cache miss is a readable error instead of a network call — for reproducible offline runs. */
  offline?: boolean;
  /** Where to surface things the caller should know but that are not failures, e.g. a stale cached plan. */
  onNotice?: (message: string) => void;
}

export interface DesignAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** Problems that sent us back to the model. Empty on the successful attempt. */
  problems: string[];
  /** Quality complaints that sent us back to the model without being allowed to fail the build. */
  advisories?: string[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface DesignResult {
  reel: Reel;
  attempts: DesignAttempt[];
  /** Advisories the model never resolved. The reel is still buildable; the numbers go in the report. */
  advisories: string[];
  /** The plan fixture this design was read from or written to. Absent when no cacheDir was given. */
  cachePath?: string;
}

export async function designReel(recording: Recording, options: DesignOptions = {}): Promise<DesignResult> {
  const targetDurationSec = options.targetDurationSec ?? DEFAULT_TARGET_DURATION_SEC;
  const language = options.language ?? 'en';
  const allowGenerated = options.allowGenerated ?? false;

  return runDesignLoop({
    messages: buildMessages(recording, { targetDurationSec, language, toolName: TOOL_NAME }),
    validate: (reel) => validateAgainstRecording(reel, recording.durationSec),
    advise: (reel) => [
      narrationBudgetAdvisories(reel, narrationBudgetChars(targetDurationSec, language)),
      [...cardNarrationAdvisories(reel), ...narrationLineAdvisories(reel)],
    ],
    multiSource: false,
    cachePath: planCachePath(options.cacheDir, 'plan', [recording, targetDurationSec, language, allowGenerated]),
    allowGenerated,
    maxRepairs: options.maxRepairs ?? DEFAULT_MAX_REPAIRS,
    options,
  });
}

/**
 * Designs a two-to-three-minute reel from the pitch that states the argument and the footage that
 * can back it up. Each shot names the footage it reads via `Shot.source`, so a claim can be shown
 * with the recording that actually demonstrates it.
 */
export async function designLongFormReel(
  pitch: string,
  footage: FootageItem[],
  options: DesignOptions = {},
): Promise<DesignResult> {
  const targetDurationSec = options.targetDurationSec ?? DEFAULT_TARGET_DURATION_SEC;
  const language = options.language ?? 'en';
  const allowGenerated = options.allowGenerated ?? false;
  const durations = footageDurations(footage);
  const readable = new Map(
    footage.map((item) => [item.id, { spans: readableSpans(item.recording), durationSec: item.recording.durationSec }]),
  );

  return runDesignLoop({
    messages: buildLongFormMessages(pitch, footage, { targetDurationSec, language, toolName: TOOL_NAME }),
    validate: (reel) => validateAgainstFootage(reel, durations),
    advise: (reel) => [
      narrationBudgetAdvisories(reel, narrationBudgetChars(targetDurationSec, language)),
      [...cardNarrationAdvisories(reel), ...narrationLineAdvisories(reel)],
      [...onsetAdvisories(reel, readable), ...repeatedRangeAdvisories(reel)],
    ],
    multiSource: true,
    cachePath: planCachePath(options.cacheDir, 'plan-longform', [
      pitch,
      footage.map((f) => [f.id, f.recording]),
      targetDurationSec,
      language,
      allowGenerated,
    ]),
    allowGenerated,
    maxRepairs: options.maxRepairs ?? LONG_FORM_MAX_REPAIRS,
    options: { ...options, timeoutMs: options.timeoutMs ?? LONG_FORM_TIMEOUT_MS },
  });
}

function planCachePath(cacheDir: string | undefined, prefix: string, parts: unknown[]): string | undefined {
  return cacheDir === undefined ? undefined : join(cacheDir, `${prefix}-${cacheKey(parts)}.json`);
}

interface DesignLoop {
  messages: ChatMessage[];
  /** Checks the reel against whatever it claims to read from. Structural checks are applied on top. */
  validate: (reel: Reel) => string[];
  /**
   * Quality complaints worth another attempt, but never worth failing a build over, grouped
   * most-important first. Only the first non-empty group is sent: three kinds of complaint in one
   * turn produced a reel that fixed the small ones and ignored the one that mattered.
   */
  advise?: (reel: Reel) => string[][];
  cachePath: string | undefined;
  allowGenerated: boolean;
  /** Whether the shot schema offers a `source` field — see {@link buildToolSchema}. */
  multiSource: boolean;
  maxRepairs: number;
  options: DesignOptions;
}

async function runDesignLoop(loop: DesignLoop): Promise<DesignResult> {
  const { messages, cachePath, options } = loop;

  const toolSchema = buildToolSchema({ allowGenerated: loop.allowGenerated, multiSource: loop.multiSource });
  /** Keys everything the model was asked, schema included — narrowing the schema changes the design as surely as the prose does. */
  const promptHash = cacheKey([messages, toolSchema]);

  if (cachePath !== undefined && existsSync(cachePath)) {
    const cached = readCachedDesign(cachePath);
    const stale = cached.promptHash !== undefined && cached.promptHash !== promptHash;
    if (!stale) return { ...cached.result, cachePath };
    if (options.offline === true) {
      options.onNotice?.(`the cached plan was designed from an older prompt; --offline replays it unchanged (${cachePath})`);
      return { ...cached.result, cachePath };
    }
    options.onNotice?.('the prompt changed since the cached plan was designed; designing a new one');
  }
  if (options.offline === true) {
    throw new Error(
      `--offline: no cached plan at ${cachePath ?? '(no cacheDir given)'}. Run once without --offline to populate the cache.`,
    );
  }

  const tools = [
    {
      type: 'function' as const,
      function: {
        name: TOOL_NAME,
        description: 'Emit the designed Reel timeline.',
        parameters: toolSchema,
      },
    },
  ];

  const attempts: DesignAttempt[] = [];
  const totalAttempts = loop.maxRepairs + 1;
  let advisoryRounds = 0;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const response = await chatCompletion(
      {
        model: M3_MODEL,
        messages,
        tools,
        tool_choice: { type: 'function', function: { name: TOOL_NAME } },
        max_tokens: DESIGN_MAX_COMPLETION_TOKENS,
      },
      { baseUrl: options.baseUrl, timeoutMs: options.timeoutMs },
    );

    const usage = toUsage(response);
    const result = extractReel(response, loop.validate);

    if (result.reel !== undefined) {
      const groups = loop.advise?.(result.reel) ?? [];
      const advisories = groups.flat();
      attempts.push({ attempt, problems: [], advisories, usage });

      const next = groups.find((group) => group.length > 0);
      if (next !== undefined && advisoryRounds < MAX_ADVISORY_ROUNDS && attempt < totalAttempts && result.toolCall !== undefined) {
        advisoryRounds += 1;
        pushRepairTurn(messages, response, result.toolCall, next);
        continue;
      }

      const designResult: DesignResult = { reel: result.reel, attempts, advisories };
      if (cachePath !== undefined) writeCachedDesign(cachePath, designResult, promptHash);
      return { ...designResult, cachePath };
    }

    attempts.push({ attempt, problems: result.problems, usage });

    if (attempt === totalAttempts) {
      throw new Error(
        `M3 could not design a valid reel after ${attempt} attempt${attempt === 1 ? '' : 's'}:\n` +
          result.problems.map((p) => `  - ${p}`).join('\n'),
      );
    }

    if (result.toolCall === undefined) {
      messages.push({ role: 'user', content: `Problems with your response:\n${formatProblems(result.problems)}` });
      continue;
    }
    pushRepairTurn(messages, response, result.toolCall, result.problems);
  }

  throw new Error('unreachable: design loop exited without returning or throwing');
}

function pushRepairTurn(messages: ChatMessage[], response: ChatResponse, toolCall: ToolCall, problems: string[]): void {
  messages.push({ role: 'assistant', content: response.choices?.[0]?.message.content ?? null, tool_calls: [toolCall] });
  messages.push({ role: 'tool', tool_call_id: toolCall.id, content: formatProblems(problems) });
}

interface ExtractResult {
  reel?: Reel;
  problems: string[];
  toolCall?: ToolCall;
}

function extractReel(response: ChatResponse, validate: (reel: Reel) => string[]): ExtractResult {
  const toolCall = response.choices?.[0]?.message.tool_calls?.[0];
  if (toolCall === undefined) {
    const finishReason = response.choices?.[0]?.finish_reason;
    const why = finishReason === undefined ? '' : ` (finish_reason: ${finishReason})`;
    return { problems: [`model did not call the "${TOOL_NAME}" tool${why}`] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch (err) {
    return { problems: [`tool call arguments were not valid JSON: ${errMessage(err)}`], toolCall };
  }

  const parsed = reelSchema.safeParse(raw);
  if (!parsed.success) {
    return { problems: formatZodIssues(parsed.error).split('\n'), toolCall };
  }

  const problems = [...validateReel(parsed.data), ...validate(parsed.data)];
  if (problems.length > 0) {
    return { problems, toolCall };
  }

  return { reel: parsed.data, problems: [], toolCall };
}

interface CachedDesign {
  reel: Reel;
  attempts: DesignAttempt[];
  advisories?: string[];
  /**
   * Digest of the messages the plan was designed from. Absent in plans written before this was
   * recorded, which are taken at face value rather than declared stale on no evidence.
   */
  promptHash?: string;
}

function readCachedDesign(path: string): { result: DesignResult; promptHash: string | undefined } {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CachedDesign;
  const parsed = reelSchema.safeParse(raw.reel);
  if (!parsed.success) throw new Error(`cached plan at ${path} is invalid:\n${formatZodIssues(parsed.error)}`);
  return {
    result: { reel: parsed.data, attempts: raw.attempts, advisories: raw.advisories ?? [] },
    promptHash: raw.promptHash,
  };
}

function writeCachedDesign(path: string, result: DesignResult, promptHash: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const cached: CachedDesign = { ...result, promptHash };
  writeFileSync(path, `${JSON.stringify(cached, null, 2)}\n`);
}

function formatProblems(problems: string[]): string {
  return problems.map((p) => `- ${p}`).join('\n');
}

function toUsage(response: ChatResponse): DesignAttempt['usage'] {
  const usage = response.usage;
  if (usage === undefined) return undefined;
  return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
