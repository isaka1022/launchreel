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

/** Playback rate for a shot's footage: 0.5 halves the speed and doubles the on-screen length, 2 does the reverse. */
export const DEFAULT_SHOT_SPEED = 1;
/**
 * Past 4x nothing on a terminal is readable. Below 0.6x the picture stops reading as playback at
 * all — it is a still that drifts — so the honest way to carry the extra time is a held frame on
 * a finished screen, not a slower crawl through an unfinished one.
 */
export const MIN_SHOT_SPEED = 0.6;
export const MAX_SHOT_SPEED = 4;

export const shotSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(SHOT_KINDS),
  /** On-screen seconds. `fit.ts` may grow this to fit measured narration. */
  durationSec: z.number().positive().max(120),
  /** Human-readable purpose of the shot, used in reports and as a fallback caption. */
  label: z.string().min(1),
  /** Id of the footage `evidenceRange` reads from. Omit when the reel is built from a single recording. */
  source: z.string().min(1).optional(),
  /** For `terminal`/`screencast`: the [start, end] second range of the source recording. */
  evidenceRange: z.tuple([z.number().min(0), z.number().min(0)]).optional(),
  /** Playback rate for `evidenceRange`. Below 1 stretches short footage; above 1 skips through slow footage. */
  speed: z.number().min(MIN_SHOT_SPEED).max(MAX_SHOT_SPEED).optional(),
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

export function shotSpeed(shot: Shot): number {
  return shot.speed ?? DEFAULT_SHOT_SPEED;
}

/** On-screen seconds a shot's own footage can fill, after `speed`. Undefined when the shot has no footage. */
export function shotFootageSec(shot: Shot): number | undefined {
  if (!shot.evidenceRange) return undefined;
  return (shot.evidenceRange[1] - shot.evidenceRange[0]) / shotSpeed(shot);
}

/**
 * Seconds of real footage behind each shot, so the fitter knows how much of a stretched shot has
 * to be filled with a held frame. Shots with nothing behind them (cards, stills) are absent from
 * the map and are free to take any length.
 */
export function footageSecByShot(reel: Reel): Map<string, number> {
  const available = new Map<string, number>();
  for (const shot of reel.shots) {
    const seconds = shotFootageSec(shot);
    if (seconds !== undefined) available.set(shot.id, seconds);
  }
  return available;
}

/**
 * A shot may run slightly past its footage because the last frame is held. Beyond this the
 * shot is mostly a freeze and the model should be told to fix it.
 */
const EVIDENCE_SLACK_SEC = 0.5;

/** The model writes rounded seconds, so treat a hair past the end of the recording as in range. */
const ROUNDING_SLACK_SEC = 0.1;

/** Fallback id in a usage breakdown for shots that read the only recording and name no source. */
export const UNNAMED_SOURCE_ID = '(recording)';

export interface SourceUsage {
  source: string;
  shots: number;
  /** Seconds this source holds the screen for. */
  screenSec: number;
  /** Seconds of the source itself consumed — differs from `screenSec` wherever `speed` is not 1. */
  footageSec: number;
}

export interface ReelUsage {
  bySource: SourceUsage[];
  cardSec: number;
  stillSec: number;
  totalSec: number;
}

/** What the finished reel is actually made of, for the build report. */
export function reelUsage(reel: Reel): ReelUsage {
  const bySource = new Map<string, SourceUsage>();
  let cardSec = 0;
  let stillSec = 0;

  for (const shot of reel.shots) {
    if (shot.kind === 'card') cardSec += shot.durationSec;
    if (shot.kind === 'still') stillSec += shot.durationSec;
    if (!shot.evidenceRange) continue;

    const id = shot.source ?? UNNAMED_SOURCE_ID;
    const entry = bySource.get(id) ?? { source: id, shots: 0, screenSec: 0, footageSec: 0 };
    entry.shots += 1;
    entry.screenSec += shot.durationSec;
    entry.footageSec += shot.evidenceRange[1] - shot.evidenceRange[0];
    bySource.set(id, entry);
  }

  return { bySource: [...bySource.values()], cardSec, stillSec, totalSec: totalDurationSec(reel) };
}

/** The three fields that only mean something on a shot that plays footage. */
const FOOTAGE_FIELDS = ['evidenceRange', 'source', 'speed'] as const;

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
    const readsFootage = shot.kind === 'terminal' || shot.kind === 'screencast';
    if (readsFootage && !shot.evidenceRange) {
      problems.push(`shot "${shot.id}" is kind "${shot.kind}" but has no evidenceRange`);
    }
    if (shot.evidenceRange && shot.evidenceRange[0] >= shot.evidenceRange[1]) {
      problems.push(`shot "${shot.id}" has an empty evidenceRange`);
    }
    // A card/still/generated shot renders from its own text or asset, so the playback fields are dead weight on it.
    if (!readsFootage) {
      const stray = FOOTAGE_FIELDS.filter((field) => shot[field] !== undefined);
      if (stray.length > 0) {
        problems.push(`shot "${shot.id}" is kind "${shot.kind}" but sets ${stray.join(', ')} — none of it is ever played`);
      }
    } else if (!shot.evidenceRange) {
      if (shot.source !== undefined) problems.push(`shot "${shot.id}" names a source but has no evidenceRange to read from it`);
      if (shot.speed !== undefined) problems.push(`shot "${shot.id}" sets a speed but has no evidenceRange to play`);
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
  return reel.shots.flatMap((shot) => rangeProblems(shot, recordingDurationSec, ''));
}

function rangeProblems(shot: Shot, durationSec: number, sourceLabel: string): string[] {
  if (!shot.evidenceRange) return [];
  const problems: string[] = [];
  const [from, to] = shot.evidenceRange;
  if (to > durationSec + ROUNDING_SLACK_SEC) {
    problems.push(`shot "${shot.id}" reads up to ${to}s but the recording${sourceLabel} is only ${durationSec.toFixed(2)}s long`);
  }
  if (from > durationSec) {
    problems.push(`shot "${shot.id}" starts at ${from}s, past the end of the recording${sourceLabel}`);
  }
  return problems;
}

/**
 * Checks a designed reel against a named set of footage — the multi-source counterpart of
 * {@link validateAgainstRecording}. Kept apart from `validateReel` so a caller that has no
 * footage list (the `fit`/`emit` subcommands, a reel read off disk) can still validate structure.
 */
export function validateAgainstFootage(reel: Reel, footageDurationSec: Map<string, number>): string[] {
  const problems: string[] = [];
  const ids = [...footageDurationSec.keys()];
  const soleId = ids.length === 1 ? ids[0] : undefined;

  for (const shot of reel.shots) {
    if (!shot.evidenceRange) continue;
    const id = shot.source ?? soleId;
    if (id === undefined) {
      problems.push(`shot "${shot.id}" has no source — name one of: ${ids.join(', ')}`);
      continue;
    }
    const durationSec = footageDurationSec.get(id);
    if (durationSec === undefined) {
      problems.push(`shot "${shot.id}" reads from unknown source "${id}" — known sources: ${ids.join(', ')}`);
      continue;
    }
    problems.push(...rangeProblems(shot, durationSec, ` of source "${id}"`));
  }
  return problems;
}

export interface SourceCoverage {
  source: string;
  /** Union of every range read from this source — a stretch used twice is counted once. */
  usedSec: number;
  availableSec: number;
}

/** How much of each recording the reel ever reaches, so an unused half of the footage is visible. */
export function sourceCoverage(reel: Reel, availableSec: Map<string, number>): SourceCoverage[] {
  const ids = [...availableSec.keys()];
  const soleId = ids.length === 1 ? ids[0] : undefined;
  const rangesBySource = new Map<string, [number, number][]>();

  for (const shot of reel.shots) {
    const range = shot.evidenceRange;
    if (range === undefined) continue;
    const id = shot.source ?? soleId ?? UNNAMED_SOURCE_ID;
    const list = rangesBySource.get(id);
    if (list) list.push([range[0], range[1]]);
    else rangesBySource.set(id, [[range[0], range[1]]]);
  }

  return [...rangesBySource].map(([source, ranges]) => ({
    source,
    usedSec: unionSec(ranges),
    availableSec: availableSec.get(source) ?? 0,
  }));
}

function unionSec(ranges: [number, number][]): number {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cursor = -Infinity;
  for (const [from, to] of sorted) {
    total += Math.max(0, to - Math.max(from, cursor));
    cursor = Math.max(cursor, to);
  }
  return total;
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
    const available = shotFootageSec(shot);
    if (available === undefined) continue;
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
