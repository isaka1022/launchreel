import { z } from 'zod';

/**
 * The intermediate representation M3 is asked to produce. Deliberately smaller and flatter
 * than OTIO: the model decides *what happens when*, and `emit/otio.ts` turns that into a
 * valid timeline deterministically. Nothing here mirrors an OTIO schema string.
 */

/**
 * `generated` needs a paid video model and is off by default; the other kinds cost nothing.
 * A developer launch video is carried by the real thing running, so generated B-roll is the
 * exception rather than the backbone.
 */
export const SHOT_KINDS = ['terminal', 'screencast', 'still', 'card', 'generated'] as const;

export const cardSchema = z.object({
  title: z.string().min(1),
  subtitle: z.string().optional(),
  /** Monospace line rendered under the subtitle, e.g. an install command. */
  command: z.string().optional(),
});

export const shotSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(SHOT_KINDS),
  /** On-screen seconds. `fit.ts` may grow this to fit measured narration. */
  durationSec: z.number().positive().max(120),
  /** Human-readable purpose of the shot, used in reports and as a fallback caption. */
  label: z.string().min(1),
  /** For `terminal`/`screencast`: the [start, end] second range of the source recording. */
  evidenceRange: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
  /** For `generated`: the prompt handed to the video model. */
  prompt: z.string().max(7000).optional(),
  /** For `still`: path to the image, relative to the project dir. */
  imagePath: z.string().optional(),
  /** For `card`: text rendered by ffmpeg, no external asset needed. */
  card: cardSchema.optional(),
});

export const narrationLineSchema = z.object({
  id: z.string().min(1),
  shotId: z.string().min(1),
  text: z.string().min(1),
  /** Explicit start on the master timeline. Omit to let `fit.ts` place it. */
  atSec: z.number().min(0).optional(),
});

export const musicSpecSchema = z.object({
  /** Structured Caption handed to Music 3.0. */
  caption: z.string().min(1),
  /** Section tags in order, e.g. ["[Intro]", "[Build]", "[Drop]", "[Outro]"]. */
  structureTags: z.array(z.string().min(1)).min(1),
  targetDurationSec: z.number().positive().max(300),
});

export const reelSchema = z.object({
  version: z.literal('launchreel/1'),
  title: z.string().min(1),
  fps: z.number().positive().default(30),
  shots: z.array(shotSchema).min(1),
  narration: z.array(narrationLineSchema).default([]),
  music: musicSpecSchema.optional(),
  /**
   * Seconds where a musical accent should land — cut points the score is expected to hit.
   * `snap.ts` scores candidate tracks by how many of these it can align to a real beat.
   */
  hitPoints: z.array(z.number().min(0)).default([]),
});

export type Shot = z.infer<typeof shotSchema>;
export type NarrationLine = z.infer<typeof narrationLineSchema>;
export type MusicSpec = z.infer<typeof musicSpecSchema>;
export type Reel = z.infer<typeof reelSchema>;

/** Cumulative start/end of each shot, in `shots` order. */
export interface ShotSpan {
  shotId: string;
  start: number;
  end: number;
}

export function shotSpans(reel: Reel): ShotSpan[] {
  let cursor = 0;
  return reel.shots.map((shot) => {
    const start = cursor;
    cursor += shot.durationSec;
    return { shotId: shot.id, start, end: cursor };
  });
}

export function totalDurationSec(reel: Reel): number {
  return reel.shots.reduce((sum, s) => sum + s.durationSec, 0);
}

/**
 * A shot may run slightly past its footage because the last frame is held. Beyond this the
 * shot is mostly a freeze and the model should be told to fix it.
 */
const EVIDENCE_SLACK_SEC = 0.5;

/** The model writes rounded seconds, so treat a hair past the end of the recording as in range. */
const ROUNDING_SLACK_SEC = 0.1;

/**
 * Structural problems that make a reel unbuildable at any stage: dangling references,
 * duplicate ids, a kind missing the field it needs. Safe to run before and after fitting.
 */
export function validateReel(reel: Reel): string[] {
  const problems: string[] = [];
  const shotIds = new Set<string>();
  for (const shot of reel.shots) {
    if (shotIds.has(shot.id)) problems.push(`duplicate shot id "${shot.id}"`);
    shotIds.add(shot.id);
    if (shot.kind === 'generated' && !shot.prompt) {
      problems.push(`shot "${shot.id}" is kind "generated" but has no prompt`);
    }
    if (shot.kind === 'still' && !shot.imagePath) {
      problems.push(`shot "${shot.id}" is kind "still" but has no imagePath`);
    }
    if (shot.kind === 'card' && !shot.card) {
      problems.push(`shot "${shot.id}" is kind "card" but has no card text`);
    }
    if ((shot.kind === 'terminal' || shot.kind === 'screencast') && !shot.evidenceRange) {
      problems.push(`shot "${shot.id}" is kind "${shot.kind}" but has no evidenceRange`);
    }
    if (shot.evidenceRange && shot.evidenceRange[0] >= shot.evidenceRange[1]) {
      problems.push(`shot "${shot.id}" has an empty evidenceRange`);
    }
  }

  const lineIds = new Set<string>();
  for (const line of reel.narration) {
    if (lineIds.has(line.id)) problems.push(`duplicate narration id "${line.id}"`);
    lineIds.add(line.id);
    if (!shotIds.has(line.shotId)) {
      problems.push(`narration "${line.id}" references unknown shot "${line.shotId}"`);
    }
  }

  const total = totalDurationSec(reel);
  for (const hit of reel.hitPoints) {
    if (hit > total) problems.push(`hit point ${hit}s is past the reel end (${total}s)`);
  }

  return problems;
}

/**
 * Checks a designed reel against the footage it claims to use. Only points at what the model
 * alone can fix: a range that doesn't exist in the recording. A shot running longer than its
 * range is *not* a problem here — `fit.ts` fills the remainder with a held frame, and demanding
 * second-perfect durations from the model sends the repair loop in circles over fractions of a
 * second it can't reason about precisely.
 */
export function validateAgainstRecording(reel: Reel, recordingDurationSec: number): string[] {
  const problems: string[] = [];
  for (const shot of reel.shots) {
    if (!shot.evidenceRange) continue;
    const [from, to] = shot.evidenceRange;
    if (to > recordingDurationSec + ROUNDING_SLACK_SEC) {
      problems.push(
        `shot "${shot.id}" reads up to ${to}s but the recording is only ${recordingDurationSec.toFixed(2)}s long`,
      );
    }
    if (from > recordingDurationSec) {
      problems.push(`shot "${shot.id}" starts at ${from}s, past the end of the recording`);
    }
  }
  return problems;
}

/**
 * How much of each shot would be a frozen frame after fitting. Not a validation failure —
 * a held frame is a legitimate way to hold a beat — but past `HOLD_WARN_RATIO` the shot is
 * mostly a still and the reel is worth a second look.
 */
export const HOLD_WARN_RATIO = 0.5;

export function holdWarnings(reel: Reel): string[] {
  const warnings: string[] = [];
  for (const shot of reel.shots) {
    if (!shot.evidenceRange) continue;
    const available = shot.evidenceRange[1] - shot.evidenceRange[0];
    const held = shot.durationSec - available;
    if (held > EVIDENCE_SLACK_SEC && held / shot.durationSec > HOLD_WARN_RATIO) {
      warnings.push(
        `shot "${shot.id}" holds a frozen frame for ${held.toFixed(1)}s of its ${shot.durationSec.toFixed(1)}s ` +
          `(${Math.round((held / shot.durationSec) * 100)}%) — consider a shorter shot or more footage`,
      );
    }
  }
  return warnings;
}
