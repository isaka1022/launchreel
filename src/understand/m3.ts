import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { chatCompletion, type ChatResponse, type ToolCall } from '../drivers/gmi.js';
import type { Recording } from '../ingest/types.js';
import { cacheKey } from '../order/media.js';
import { formatZodIssues } from '../report.js';
import { reelSchema, type Reel, validateAgainstRecording, validateReel } from '../timeline/schema.js';
import { buildMessages, buildToolSchema } from './prompt.js';

/**
 * Turns a Recording into a validated Reel by calling MiniMax M3 with a forced tool call, then
 * feeding any schema/validation failures straight back to the model until it produces something
 * that parses and passes `validateReel`, or `maxRepairs` runs out.
 */

const TOOL_NAME = 'emit_reel';
const MODEL = 'MiniMaxAI/MiniMax-M3';
const DEFAULT_TARGET_DURATION_SEC = 30;
const DEFAULT_MAX_REPAIRS = 2;

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
}

export interface DesignAttempt {
  /** 1-based attempt number. */
  attempt: number;
  /** Problems that sent us back to the model. Empty on the successful attempt. */
  problems: string[];
  usage?: { promptTokens: number; completionTokens: number };
}

export interface DesignResult {
  reel: Reel;
  attempts: DesignAttempt[];
}

export async function designReel(recording: Recording, options: DesignOptions = {}): Promise<DesignResult> {
  const targetDurationSec = options.targetDurationSec ?? DEFAULT_TARGET_DURATION_SEC;
  const language = options.language ?? 'en';
  const allowGenerated = options.allowGenerated ?? false;
  const maxRepairs = options.maxRepairs ?? DEFAULT_MAX_REPAIRS;

  const cachePath =
    options.cacheDir !== undefined
      ? join(options.cacheDir, `plan-${cacheKey([recording, targetDurationSec, language, allowGenerated])}.json`)
      : undefined;

  if (cachePath !== undefined && existsSync(cachePath)) {
    return readCachedDesign(cachePath);
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
        parameters: buildToolSchema({ allowGenerated }),
      },
    },
  ];

  const messages = buildMessages(recording, { targetDurationSec, language, toolName: TOOL_NAME });
  const attempts: DesignAttempt[] = [];
  const totalAttempts = maxRepairs + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const response = await chatCompletion(
      {
        model: MODEL,
        messages,
        tools,
        tool_choice: { type: 'function', function: { name: TOOL_NAME } },
      },
      { baseUrl: options.baseUrl, timeoutMs: options.timeoutMs },
    );

    const usage = toUsage(response);
    const result = extractReel(response, recording);

    if (result.reel !== undefined) {
      attempts.push({ attempt, problems: [], usage });
      const designResult: DesignResult = { reel: result.reel, attempts };
      if (cachePath !== undefined) writeCachedDesign(cachePath, designResult);
      return designResult;
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
    messages.push({ role: 'assistant', content: response.choices[0]?.message.content ?? null, tool_calls: [result.toolCall] });
    messages.push({ role: 'tool', tool_call_id: result.toolCall.id, content: formatProblems(result.problems) });
  }

  throw new Error('unreachable: designReel loop exited without returning or throwing');
}

interface ExtractResult {
  reel?: Reel;
  problems: string[];
  toolCall?: ToolCall;
}

function extractReel(response: ChatResponse, recording: Recording): ExtractResult {
  const toolCall = response.choices[0]?.message.tool_calls?.[0];
  if (toolCall === undefined) {
    return { problems: [`model did not call the "${TOOL_NAME}" tool`] };
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

  const problems = [
    ...validateReel(parsed.data),
    ...validateAgainstRecording(parsed.data, recording.durationSec),
  ];
  if (problems.length > 0) {
    return { problems, toolCall };
  }

  return { reel: parsed.data, problems: [], toolCall };
}

interface CachedDesign {
  reel: Reel;
  attempts: DesignAttempt[];
}

function readCachedDesign(path: string): DesignResult {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as CachedDesign;
  const parsed = reelSchema.safeParse(raw.reel);
  if (!parsed.success) throw new Error(`cached plan at ${path} is invalid:\n${formatZodIssues(parsed.error)}`);
  return { reel: parsed.data, attempts: raw.attempts };
}

function writeCachedDesign(path: string, result: DesignResult): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
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
