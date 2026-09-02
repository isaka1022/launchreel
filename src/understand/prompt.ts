import { z } from 'zod';
import type { ChatMessage } from '../drivers/gmi.js';
import { ONSET_LEAD_SEC } from '../timeline/fit.js';
import { readableSpans, type TimeSpan } from '../ingest/activity.js';
import type { FootageItem } from '../ingest/footage.js';
import type { Evidence, Recording } from '../ingest/types.js';
import { MAX_SHOT_SPEED, MIN_SHOT_SPEED, reelSchema, shotSchema } from '../timeline/schema.js';
import { CJK_CHARS_PER_SEC, LATIN_CHARS_PER_SEC } from '../speech-rate.js';

/**
 * Narration cannot fill a reel end to end — shots need a moment before and after a line, and
 * cards carry beats of their own. Without a budget the model writes to the argument and a 90s
 * target comes back as three minutes of speech.
 */
const NARRATION_SHARE_OF_REEL = 0.75;

export function narrationBudgetChars(targetDurationSec: number, language: 'en' | 'ja'): number {
  const rate = language === 'ja' ? CJK_CHARS_PER_SEC : LATIN_CHARS_PER_SEC;
  return Math.round(targetDurationSec * NARRATION_SHARE_OF_REEL * rate);
}

/**
 * Builds the tool schema and chat messages handed to MiniMax M3. The schema is derived from
 * `reelSchema` (via `z.toJSONSchema`) rather than hand-written, so the two can't drift apart.
 */

export interface ToolSchemaOptions {
  allowGenerated: boolean;
  /** True when the reel is designed against a footage set, so a shot has to name which recording it reads. */
  multiSource: boolean;
}

const GENERATED_KIND = 'generated';

/** On-screen seconds a shot can hold before the viewer stops reading it as a cut. */
const SHOT_SEC_MIN = 4;
const SHOT_SEC_MAX = 8;
/** Only a shot whose screen never settles earns more than this. */
const SHOT_SEC_HARD_MAX = 10;
/** Average shot lengths the target duration is divided by to get a shot count to aim for. */
const LOOSE_SHOT_AVG_SEC = 6;
const DENSE_SHOT_AVG_SEC = 4.5;

/**
 * JSON Schema for the `emit_reel` tool call. Narrowed to what the model is actually allowed to
 * decide: "generated" is dropped from `kind` unless allowed, `speed` is code's to compute from the
 * footage it has, and `source` only exists when there is a footage set to choose from.
 */
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
  const codeOwned = ['speed', ...(options.multiSource ? [] : ['source'])];
  for (const field of codeOwned) delete shotProperties(schema)[field];
  return schema;
}

/** The `properties` map of a shot inside a generated reel schema. Throws rather than silently no-op. */
function shotProperties(schema: Record<string, unknown>): Record<string, unknown> {
  const path = ['properties', 'shots', 'items', 'properties'];
  let node: unknown = schema;
  for (const key of path) {
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  if (node === null || typeof node !== 'object') throw new Error('reel tool schema has no shot properties to narrow');
  return node as Record<string, unknown>;
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
    'A recording is always shorter than the reel made from it. Fill the difference with "card" shots, never by holding a terminal on its last frame: ' +
      'a card standing still reads as punctuation, a frozen terminal reads as a broken video.',
    'Keep cards a minority of the shots, and never place two back to back.',
    'A card carries at most one line of narration — the shot is stretched to hold whatever is said on it, so a card ' +
      'the narration talks over becomes the longest shot in the reel.',
    'If the previous call failed validation, fix exactly the problems listed and call the tool again.',
  ].join('\n');
}

function buildUserPrompt(recording: Recording, options: BuildMessagesOptions): string {
  const durationLabel = recording.durationSec.toFixed(2);
  const lines: string[] = [
    `Recording duration: ${durationLabel}s`,
    ...(recording.title !== undefined ? [`Recording title: ${recording.title}`] : []),
    `Target reel duration: about ${options.targetDurationSec}s`,
    `Narration across the whole reel must total at most ${narrationBudgetChars(options.targetDurationSec, options.language)} ` +
      'characters. Going over makes the reel longer than it was asked for, not denser.',
    '',
    'Evidence (timestamps are seconds from the start of the recording):',
    ...recording.evidence.map(formatEvidence),
    '',
    `IMPORTANT: the recording is only ${durationLabel}s long. Every evidenceRange must fall within ` +
      `[0, ${durationLabel}], and no shot's durationSec may exceed the span of its own evidenceRange.`,
    ...cardBudgetLine(recording.durationSec, options.targetDurationSec),
  ];
  return lines.join('\n');
}

/**
 * States the arithmetic the model otherwise has to notice on its own: a reel longer than its
 * recording has seconds that no footage can cover, and those seconds become cards or frozen
 * terminals. Naming the figure is what stops it choosing the second one.
 */
function cardBudgetLine(recordingSec: number, targetDurationSec: number): string[] {
  const uncovered = targetDurationSec - recordingSec;
  if (uncovered <= 0) return [];
  return [
    `The recording covers ${recordingSec.toFixed(2)}s of a ${targetDurationSec}s reel, so at least ` +
      `${uncovered.toFixed(2)}s has no footage behind it. Spend those seconds on cards.`,
  ];
}

/**
 * The long-form counterpart of {@link buildMessages}: the story comes from the pitch rather than
 * from a single recording, and the footage is a set the model has to choose between. Same
 * convention — one forced tool call, seconds measured from the start of each recording.
 */
export function buildLongFormMessages(pitch: string, footage: FootageItem[], options: BuildMessagesOptions): ChatMessage[] {
  return [
    { role: 'system', content: buildLongFormSystemPrompt(footage, options) },
    { role: 'user', content: buildLongFormUserPrompt(pitch, footage, options) },
  ];
}

function buildLongFormSystemPrompt(footage: FootageItem[], options: BuildMessagesOptions): string {
  const ids = footage.map((item) => `"${item.id}"`).join(', ');
  return [
    'You design long-form product videos ("Reels") from a written pitch and a set of terminal recordings.',
    `Call the "${options.toolName}" tool exactly once with the complete Reel — do not respond with plain text.`,
    options.language === 'ja'
      ? 'Write all narration, labels, and card text in Japanese.'
      : 'Write all narration, labels, and card text in English.',
    '',
    'The narration follows the pitch\'s argument in its own order, in spoken language — do not read the pitch aloud.',
    'Break it into lines a person can say in one breath, one thought per line.',
    'Back every claim with the footage that demonstrates it: a shot that says setup is easy shows the setup recording.',
    `Every "terminal" or "screencast" shot needs a "source" naming its recording (${ids}) and an evidenceRange [start, end] in that recording's own seconds.`,
    '',
    'CUT RATE — the single thing that decides whether this watches like a product video or a screensaver:',
    `Give every shot ${SHOT_SEC_MIN}–${SHOT_SEC_MAX}s of durationSec. Go past ${SHOT_SEC_HARD_MAX}s only for a shot whose screen keeps ` +
      `changing the whole way through; a shot that arrives at its final screen early must be cut at ${SHOT_SEC_MAX}s, not held.`,
    'Reach the target duration by writing MORE shots, never by making shots longer.',
    '',
    'EVIDENCE RANGES — a terminal shot is carried by text appearing, so every range is built around that moment:',
    'Each source below lists its "active spans": the stretches where the screen is drawing. A span\'s START is the moment ' +
      'text appears, and that is what a shot has to show.',
    `Start every range AT a span start, or up to ${ONSET_LEAD_SEC}s before one. The viewer should land on the shot and ` +
      'watch the screen fill, not arrive at a page that finished printing before the cut.',
    'Never start a range in the middle of a span (the drawing is already half over), and never start it in the quiet ' +
      'between spans — that is a blank screen with a cursor, the worst frame in a video.',
    'It is fine for a range to run on past its span into the quiet: the shot holds a finished screen the viewer is still reading. ' +
      'Holding a finished screen is not a fault; opening on one is.',
    'No two shots may show the same stretch of a recording. Every span is worth a shot, and a recording with four spans ' +
      'can carry four different shots.',
    '',
    `Use "speed" to fit footage to the time you need: ${MIN_SHOT_SPEED}–1 stretches a short recording, 1–${MAX_SHOT_SPEED} skips through a slow one. ` +
      `${MIN_SHOT_SPEED} is a hard floor: slower than that a terminal stops looking like playback and looks broken. ` +
      'When a range still cannot fill a shot at that speed, leave it — the shot holds its last frame, which beats a crawl.',
    '',
    'Put a "card" shot at each chapter boundary: it names the section that follows and carries the cut between recordings.',
    'Never place two cards back to back, and keep cards a minority of the shots — they are punctuation, not content.',
    'A card carries at most one line of narration, and the closing card is not where the argument goes. The claims are ' +
      'made over the footage that demonstrates them; a card the narration keeps talking over stops being punctuation ' +
      'and becomes the longest shot in the reel, because the shot is stretched to hold whatever is said on it.',
    'Where the footage does not show something, do not stretch unrelated footage over it — use a card instead.',
    'If the previous call failed validation, fix exactly the problems listed and call the tool again.',
  ].join('\n');
}

/** Turns a target duration into the shot count that hits the cut rate above. */
export function shotCountRange(targetDurationSec: number): [number, number] {
  return [Math.round(targetDurationSec / LOOSE_SHOT_AVG_SEC), Math.round(targetDurationSec / DENSE_SHOT_AVG_SEC)];
}

function buildLongFormUserPrompt(pitch: string, footage: FootageItem[], options: BuildMessagesOptions): string {
  const spanTotal = footage.reduce((sum, item) => sum + readableSpans(item.recording).length, 0);
  const [minShots, maxShots] = shotCountRange(options.targetDurationSec);
  const lines: string[] = [
    'PITCH (the argument the video has to make):',
    pitch.trim(),
    '',
    'FOOTAGE (timestamps are seconds from the start of that recording):',
    ...footage.flatMap((item) => [
      '',
      `## source: ${item.id}  (${item.recording.durationSec.toFixed(2)}s)`,
      `active spans (the screen draws here and is worth reading afterwards; open every evidenceRange on one): ${formatSpans(readableSpans(item.recording))}`,
      ...item.recording.evidence.map(formatEvidence),
    ]),
    '',
    `Target reel duration: about ${options.targetDurationSec}s, reached with ${minShots}–${maxShots} shots.`,
    `Narration across the whole reel must total at most ${narrationBudgetChars(options.targetDurationSec, options.language)} ` +
      'characters. Going over makes the reel longer than it was asked for, not denser.',
    '',
    `There are ${spanTotal} active spans across the ${footage.length} recordings — ${spanTotal} different moments of text appearing, ` +
      'and each one can open a shot. Work through them rather than returning to the same few.',
    'Cards carry what the footage never shows, and mark the chapter boundaries — they are the remainder, not the plan.',
    'Each evidenceRange must fall inside its own source, and a source id must be one of the headings above.',
  ];
  return lines.join('\n');
}

function formatSpans(spans: TimeSpan[]): string {
  if (spans.length === 0) return 'none — this recording never changes on screen';
  return spans.map((s) => `${s.startSec.toFixed(2)}-${s.endSec.toFixed(2)}s`).join(', ');
}

function formatEvidence(evidence: Evidence): string {
  if (evidence.kind === 'pause' && evidence.durationSec !== undefined) {
    return `[${evidence.t.toFixed(2)}s] pause: screen frozen until ${(evidence.t + evidence.durationSec).toFixed(2)}s — nothing to show here`;
  }
  const duration = evidence.durationSec !== undefined ? ` (+${evidence.durationSec.toFixed(2)}s)` : '';
  return `[${evidence.t.toFixed(2)}s${duration}] ${evidence.kind}: ${evidence.text}`;
}
