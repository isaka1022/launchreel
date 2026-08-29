import { shotSpans, totalDurationSec, type MusicSpec, type Reel } from './schema.js';

/**
 * Music 3.0 ignores a requested length, so whether one render covers a two-minute reel is only
 * knowable after measuring what came back — observed lengths run from ~80s to ~173s. This decides
 * *where* one track would hand over to the next and carves the reel into the matching pieces, so
 * `snap.ts` can be run per piece and each track only answers for the cuts it is actually playing
 * under. Pure: no generation, no ffmpeg, no measurement — callers pass the lengths they measured.
 */

/** A track change is only allowed to land on a shot boundary; a chapter card is the preferred one. */
export interface SwitchPoint {
  shotIndex: number;
  atSec: number;
  isChapter: boolean;
}

export interface MusicSegment {
  /** 1-based, for reports. */
  index: number;
  fromShot: number;
  /** Exclusive. */
  toShot: number;
  startSec: number;
  endSec: number;
}

export function musicSwitchPoints(reel: Reel): SwitchPoint[] {
  const spans = shotSpans(reel);
  return spans.slice(1).map((span, i) => ({
    shotIndex: i + 1,
    atSec: span.start,
    isChapter: reel.shots[i + 1]?.kind === 'card',
  }));
}

export interface SegmentBoundaryOptions {
  startSec: number;
  /** How far into the reel the track in hand can actually reach. */
  trackDurationSec: number;
  totalSec: number;
  /** Never leave a tail shorter than this; run the current track to the end instead. */
  minSegmentSec: number;
}

/**
 * The last chapter card the current track still covers — falling back to the last plain cut when
 * the stretch holds no card. `undefined` means the track reaches the end of the reel.
 */
export function nextSegmentBoundary(points: SwitchPoint[], options: SegmentBoundaryOptions): SwitchPoint | undefined {
  const { startSec, trackDurationSec, totalSec, minSegmentSec } = options;
  if (totalSec - startSec <= trackDurationSec) return undefined;

  const reachable = points.filter(
    (p) => p.atSec > startSec && p.atSec - startSec <= trackDurationSec && totalSec - p.atSec >= minSegmentSec,
  );
  const chapters = reachable.filter((p) => p.isChapter);
  const pool = chapters.length > 0 ? chapters : reachable;
  return pool[pool.length - 1];
}

/**
 * The tracks long enough to play a whole segment without running out into silence. Falls back to
 * the full set when none reaches — then a held pad is the best available answer and the caller
 * still gets to pick the one that fits the cuts best.
 */
export function tracksCovering<T>(tracks: T[], spanSec: number, durationOf: (track: T) => number): T[] {
  const covering = tracks.filter((track) => durationOf(track) >= spanSec);
  return covering.length > 0 ? covering : tracks;
}

export function segment(reel: Reel, index: number, fromShot: number, toShot: number): MusicSegment {
  const spans = shotSpans(reel);
  const startSec = spans[fromShot]?.start ?? 0;
  const endSec = spans[toShot - 1]?.end ?? totalDurationSec(reel);
  return { index, fromShot, toShot, startSec, endSec };
}

function inSegment(hitPoint: number, segment: MusicSegment): boolean {
  return hitPoint >= segment.startSec && hitPoint < segment.endSec;
}

/**
 * The slice of the reel one track plays under, rebased to start at zero — which is where the
 * track itself starts, so `scoreTrack`/`snapReel` can be handed it unmodified.
 */
export function segmentSubReel(reel: Reel, segment: MusicSegment): Reel {
  return {
    ...reel,
    shots: reel.shots.slice(segment.fromShot, segment.toShot),
    narration: [],
    hitPoints: reel.hitPoints.filter((h) => inSegment(h, segment)).map((h) => h - segment.startSec),
  };
}

/**
 * Folds a snapped slice back into the whole. `snapReel` only ever moves boundaries *between* the
 * shots it was given, so the slice's own length — and therefore every later segment's start — is
 * unchanged.
 */
export function applySegmentReel(reel: Reel, segment: MusicSegment, sub: Reel): Reel {
  const shots = [...reel.shots];
  shots.splice(segment.fromShot, segment.toShot - segment.fromShot, ...sub.shots);

  let taken = 0;
  const hitPoints = reel.hitPoints.map((h) => {
    if (!inSegment(h, segment)) return h;
    const snapped = sub.hitPoints[taken++];
    return snapped === undefined ? h : snapped + segment.startSec;
  });

  return { ...reel, shots, hitPoints };
}

/**
 * Each segment gets its own brief so the model does not hand back the same render twice — the
 * cache key is the caption, so an identical caption would replay the previous segment's audio.
 */
const SEGMENT_DIRECTIONS = [
  '',
  ' Second movement: same palette, new texture — shift the rhythm from the opening.',
  ' Third movement: darker and more insistent than what came before.',
  ' Final movement: resolve and land.',
];

export function musicSpecForSegment(spec: MusicSpec, index: number, durationSec: number): MusicSpec {
  const direction = SEGMENT_DIRECTIONS[index] ?? ` Movement ${index + 1}: new texture, same palette.`;
  return { ...spec, caption: `${spec.caption}${direction}`, targetDurationSec: durationSec };
}
