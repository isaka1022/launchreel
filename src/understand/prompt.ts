import { z } from 'zod';
import type { ChatMessage } from '../drivers/gmi.js';
import type { Evidence, Recording } from '../ingest/types.js';
import { reelSchema, shotSchema } from '../timeline/schema.js';

/**
 * Builds the tool schema and chat messages handed to MiniMax M3. The schema is derived from
 * `reelSchema` (via `z.toJSONSchema`) rather than hand-written, so the two can't drift apart.
 */

export interface ToolSchemaOptions {
  allowGenerated: boolean;
}

const GENERATED_KIND = 'generated';

/** JSON Schema for the `emit_reel` tool call. Drops "generated" from `kind` unless allowed. */
export function buildToolSchema(options: ToolSchemaOptions): unknown {
  const schema = z.toJSONSchema(reelSchema, {
    override: (ctx) => {
      if (options.allowGenerated) return;
      if (ctx.zodSchema !== shotSchema.shape.kind) return;
      const kinds = ctx.jsonSchema.enum;
      if (Array.isArray(kinds)) {
        ctx.jsonSchema.enum = kinds.filter((k) => k !== GENERATED_KIND);
      }
    },
  });
  delete schema.$schema;
  return schema;
}

export interface BuildMessagesOptions {
  targetDurationSec: number;
  language: 'en' | 'ja';
  toolName: string;
}

export function buildMessages(recording: Recording, options: BuildMessagesOptions): ChatMessage[] {
  return [
    { role: 'system', content: buildSystemPrompt(options) },
    { role: 'user', content: buildUserPrompt(recording, options) },
  ];
}

function buildSystemPrompt(options: BuildMessagesOptions): string {
  const languageInstruction =
    options.language === 'ja'
      ? 'Write all narration, labels, and card text in Japanese.'
      : 'Write all narration, labels, and card text in English.';

  return [
    'You design short launch-video timelines ("Reels") from evidence captured in a terminal recording.',
    `Call the "${options.toolName}" tool exactly once with the complete Reel — do not respond with plain text.`,
    languageInstruction,
    'Every "terminal" or "screencast" shot needs an evidenceRange [start, end] in seconds, measured from the start of the recording.',
    "A shot's evidenceRange must lie within the recording's total duration, and its durationSec must not exceed the length of that range — a shot cannot show more footage than exists.",
    'If the previous call failed validation, fix exactly the problems listed and call the tool again.',
  ].join('\n');
}

function buildUserPrompt(recording: Recording, options: BuildMessagesOptions): string {
  const durationLabel = recording.durationSec.toFixed(2);
  const lines: string[] = [
    `Recording duration: ${durationLabel}s`,
    ...(recording.title !== undefined ? [`Recording title: ${recording.title}`] : []),
    `Target reel duration: about ${options.targetDurationSec}s`,
    '',
    'Evidence (timestamps are seconds from the start of the recording):',
    ...recording.evidence.map(formatEvidence),
    '',
    `IMPORTANT: the recording is only ${durationLabel}s long. Every evidenceRange must fall within ` +
      `[0, ${durationLabel}], and no shot's durationSec may exceed the span of its own evidenceRange.`,
  ];
  return lines.join('\n');
}

function formatEvidence(evidence: Evidence): string {
  const duration = evidence.durationSec !== undefined ? ` (+${evidence.durationSec.toFixed(2)}s)` : '';
  return `[${evidence.t.toFixed(2)}s${duration}] ${evidence.kind}: ${evidence.text}`;
}
