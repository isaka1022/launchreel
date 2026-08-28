import { shotSpans, type Reel } from './schema.js';

/**
 * Music 3.0 can't be told "put a hit at 12s" — it renders on its own tempo. So instead of
 * fitting the music to the cut points, this fits the cut points to the music: measure the
 * rendered track (`drivers/python.ts` via `py/analyze.py`) and pull `reel.hitPoints` onto the
 * nearest real beat. Pure: takes a `TrackAnalysis`, never touches ffmpeg or a file.
 */

export interface TrackAnalysis {
  durationSec: number;
  tempo: number;
  beats: number[];
  segments: number[];
  onsets: number[];
}

export interface Alignment {
  /** The hit point we wanted to land on a beat. */
  hitPoint: number;
  /** The beat we snapped to, if one was close enough. */
  beat?: number;
  /** Seconds we had to move to reach it. Positive = later. */
  shiftSec?: number;
}

export interface TrackScore {
  /** How many hit points found a beat within tolerance. */
  hits: number;
  total: number;
  /** hits / total, 0..1. */
  ratio: number;
  /** Sum of absolute shifts across the hits — lower is tighter. */
  totalShiftSec: number;
  alignments: Alignment[];
}

export interface SnapOptions {
  /** A hit counts as landed when a beat is within this. Default 0.12. */
  toleranceSec?: number;
  /** We refuse to move a cut further than this. Default 0.6. */
  maxShiftSec?: number;
}

const DEFAULT_TOLERANCE_SEC = 0.12;
const DEFAULT_MAX_SHIFT_SEC = 0.6;
/** Shortest a shot may shrink to when a boundary shift eats into it. */
const MIN_SHOT_DURATION_SEC = 0.5;

interface NearestBeat {
  beat: number;
  distance: number;
}

function nearestBeat(hitPoint: number, beats: number[]): NearestBeat | undefined {
  let best: NearestBeat | undefined;
  for (const beat of beats) {
    const distance = Math.abs(beat - hitPoint);
    if (best === undefined || distance < best.distance) best = { beat, distance };
  }
  return best;
}

/** A beat counts as "found" when it's within maxShiftSec — the outer bound we'd ever move a cut. */
function alignHitPoint(hitPoint: number, beats: number[], maxShiftSec: number): Alignment {
  const nearest = nearestBeat(hitPoint, beats);
  if (nearest === undefined || nearest.distance > maxShiftSec) return { hitPoint };
  return { hitPoint, beat: nearest.beat, shiftSec: nearest.beat - hitPoint };
}

export function scoreTrack(hitPoints: number[], analysis: TrackAnalysis, options: SnapOptions = {}): TrackScore {
  const maxShiftSec = options.maxShiftSec ?? DEFAULT_MAX_SHIFT_SEC;
  const alignments = hitPoints.map((hitPoint) => alignHitPoint(hitPoint, analysis.beats, maxShiftSec));
  const hitAlignments = alignments.filter((a) => a.beat !== undefined);
  const totalShiftSec = hitAlignments.reduce((sum, a) => sum + Math.abs(a.shiftSec ?? 0), 0);
  return {
    hits: hitAlignments.length,
    total: hitPoints.length,
    ratio: hitPoints.length > 0 ? hitAlignments.length / hitPoints.length : 0,
    totalShiftSec,
    alignments,
  };
}

export function chooseBestTrack<T extends { analysis: TrackAnalysis }>(
  candidates: T[],
  hitPoints: number[],
  options: SnapOptions = {},
): { track: T; score: TrackScore } | undefined {
  let best: { track: T; score: TrackScore } | undefined;
  for (const track of candidates) {
    const score = scoreTrack(hitPoints, track.analysis, options);
    const isBetter =
      best === undefined ||
      score.hits > best.score.hits ||
      (score.hits === best.score.hits && score.totalShiftSec < best.score.totalShiftSec);
    if (isBetter) best = { track, score };
  }
  return best;
}

function nearestBoundaryIndex(hitPoint: number, boundaries: number[]): number | undefined {
  if (boundaries.length === 0) return undefined;
  let bestIndex = 0;
  let bestDistance = Math.abs(boundaries[0]! - hitPoint);
  for (let i = 1; i < boundaries.length; i++) {
    const distance = Math.abs(boundaries[i]! - hitPoint);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex;
}

export function snapReel(reel: Reel, analysis: TrackAnalysis, options: SnapOptions = {}): { reel: Reel; score: TrackScore } {
  const toleranceSec = options.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const score = scoreTrack(reel.hitPoints, analysis, options);

  const spans = shotSpans(reel);
  const boundaries = spans.slice(0, -1).map((s) => s.end);
  const durations = reel.shots.map((s) => s.durationSec);
  const movedIndices = new Set<number>();

  score.alignments.forEach((alignment, index) => {
    if (alignment.beat === undefined || alignment.shiftSec === undefined) return;
    if (Math.abs(alignment.shiftSec) <= toleranceSec) return; // already aligned, don't move

    const boundaryIndex = nearestBoundaryIndex(alignment.hitPoint, boundaries);
    if (boundaryIndex === undefined) return;

    const shift = alignment.shiftSec;
    const newPrev = durations[boundaryIndex]! + shift;
    const newNext = durations[boundaryIndex + 1]! - shift;
    if (newPrev < MIN_SHOT_DURATION_SEC || newNext < MIN_SHOT_DURATION_SEC) return;

    durations[boundaryIndex] = newPrev;
    durations[boundaryIndex + 1] = newNext;
    movedIndices.add(index);
  });

  const newShots = reel.shots.map((shot, i) => ({ ...shot, durationSec: durations[i]! }));
  const newHitPoints = reel.hitPoints.map((hitPoint, index) => {
    if (!movedIndices.has(index)) return hitPoint;
    return score.alignments[index]!.beat!;
  });

  const newReel: Reel = { ...reel, shots: newShots, hitPoints: newHitPoints };
  return { reel: newReel, score };
}
