import { MIN_SHOT_SPEED, shotSpans, shotSpeed, type NarrationLine, type Reel, type Shot, type ShotSpan } from './schema.js';
import type { TimeSpan } from '../ingest/activity.js';
import { charsPerSecond, estimateSpeechSeconds } from '../speech-rate.js';

/**
 * Closes the gap between narration length (measured or estimated) and the shot durations
 * M3 designed. Pure: returns instructions for the caller to carry out — grown shot
 * durations, rewrite budgets, atempo factors — never touches ffmpeg, TTS, or a model.
 */

export type FitTier = 'fits' | 'extended' | 'needs-rewrite' | 'compressed' | 'held';

export interface LineFit {
  lineId: string;
  shotId: string;
  /** Measured (or estimated) speech duration in seconds. */
  speechSec: number;
  /** Start time on the master timeline. */
  atSec: number;
  tier: FitTier;
  /** For 'needs-rewrite': the character budget to hand back to the model. */
  rewriteBudgetChars?: number;
  /** For 'compressed': the atempo factor to apply (>1 speeds up). */
  atempo?: number;
}

export interface ShotFit {
  shotId: string;
  originalDurationSec: number;
  durationSec: number;
  /** Seconds of freeze-frame appended because the source material is shorter. */
  holdSec: number;
}

export interface FitReport {
  shots: ShotFit[];
  lines: LineFit[];
  totalDurationSec: number;
  /** Set when at least one line came back as 'needs-rewrite'. */
  needsRewrite: boolean;
}

export interface FitOptions {
  /** Measured wav duration per narration line id. Missing entries fall back to estimateSpeechSeconds. */
  measured?: Map<string, number>;
  /** Available source seconds per shot (e.g. how much terminal recording exists). */
  availableSec?: Map<string, number>;
  /** Gap left between two narration lines inside the same shot. Default 0.5. */
  lineGapSec?: number;
  /** Padding kept at the head and tail of a shot around its narration. Default 0.3 each. */
  padSec?: number;
  /** Max shot duration before we stop extending and ask for a rewrite. Default 20. */
  maxShotSec?: number;
  /** Max atempo we are willing to apply. Default 1.06. */
  maxAtempo?: number;
}

const DEFAULT_LINE_GAP_SEC = 0.5;
const DEFAULT_PAD_SEC = 0.3;
const DEFAULT_MAX_SHOT_SEC = 20;
/** Exported so callers (the `build` ladder) can report the ceiling `compressToFit` defaults to. */
export const DEFAULT_MAX_ATEMPO = 1.06;

interface ShotLineCalc {
  line: NarrationLine;
  speechSec: number;
}

export function fitReel(reel: Reel, options: FitOptions = {}): { reel: Reel; report: FitReport } {
  const lineGapSec = options.lineGapSec ?? DEFAULT_LINE_GAP_SEC;
  /** Master-time point where the next narration line may begin. Only ever moves forward. */
  let narrationFreeSec = 0;
  const padSec = options.padSec ?? DEFAULT_PAD_SEC;
  const maxShotSec = options.maxShotSec ?? DEFAULT_MAX_SHOT_SEC;

  const originalSpans = shotSpans(reel);

  const linesByShot = new Map<string, NarrationLine[]>();
  for (const line of reel.narration) {
    const list = linesByShot.get(line.shotId);
    if (list) list.push(line);
    else linesByShot.set(line.shotId, [line]);
  }
  for (const list of linesByShot.values()) list.sort((a, b) => (a.atSec ?? 0) - (b.atSec ?? 0));

  const newShots: Shot[] = [];
  const shotFits: ShotFit[] = [];
  const lineFits: LineFit[] = [];
  const newSpanByShotId = new Map<string, ShotSpan>();
  let needsRewrite = false;
  let masterCursor = 0;

  for (const shot of reel.shots) {
    const calc: ShotLineCalc[] = (linesByShot.get(shot.id) ?? []).map((line) => ({
      line,
      speechSec: options.measured?.get(line.id) ?? estimateSpeechSeconds(line.text),
    }));
    const speechSum = calc.reduce((sum, c) => sum + c.speechSec, 0);
    const needed = calc.length > 0 ? padSec * 2 + speechSum + lineGapSec * (calc.length - 1) : 0;

    // A card only needs to be up for as long as it takes to read, or to say its narration. The
    // model tends to give every shot the same few seconds, and on a card that is dead air.
    let durationSec = shot.kind === 'card' && shot.card ? cardReadSec(shot.card) : shot.durationSec;
    let tier: FitTier = 'fits';
    let budgetSecTotal = 0;

    if (calc.length > 0) {
      if (needed <= durationSec) {
        tier = 'fits';
      } else if (needed <= maxShotSec) {
        tier = 'extended';
        durationSec = needed;
      } else {
        tier = 'needs-rewrite';
        durationSec = maxShotSec;
        needsRewrite = true;
        budgetSecTotal = Math.max(0, maxShotSec - padSec * 2 - lineGapSec * (calc.length - 1));
      }
    }

    const available = options.availableSec?.get(shot.id);
    const holdSec = available !== undefined && durationSec > available ? durationSec - available : 0;

    const shotStart = masterCursor;
    for (const { line, speechSec } of calc) {
      // The model decides which shot a line belongs to; where it lands inside that shot is decided
      // here from the measured speech. Its proposed atSec is only an ordering hint — as a time it
      // refers to the plan's timeline, which this loop is in the middle of replacing.
      const atSec = Math.max(shotStart + padSec, narrationFreeSec);
      narrationFreeSec = atSec + speechSec + lineGapSec;

      const lineFit: LineFit = { lineId: line.id, shotId: shot.id, speechSec, atSec, tier };
      if (tier === 'needs-rewrite') {
        const share = speechSum > 0 ? speechSec / speechSum : 0;
        lineFit.rewriteBudgetChars = Math.max(0, Math.floor(budgetSecTotal * share * charsPerSecond(line.text)));
      }
      lineFits.push(lineFit);
    }

    // The last card stays up after the last word so the music can settle instead of being cut off
    // mid-bar; footage ending the reel has its own motion to carry that.
    if (shot === reel.shots[reel.shots.length - 1] && shot.kind === 'card') durationSec += OUTRO_HOLD_SEC;

    newShots.push({ ...shot, durationSec });
    shotFits.push({ shotId: shot.id, originalDurationSec: shot.durationSec, durationSec, holdSec });
    newSpanByShotId.set(shot.id, { shotId: shot.id, start: shotStart, end: shotStart + durationSec });
    masterCursor += durationSec;
  }

  const newHitPoints = reel.hitPoints.map((hit) => {
    const origSpan = findSpan(hit, originalSpans);
    const relative = (hit - origSpan.start) / (origSpan.end - origSpan.start);
    const newSpan = newSpanByShotId.get(origSpan.shotId)!;
    return newSpan.start + relative * (newSpan.end - newSpan.start);
  });

  const newReel: Reel = { ...reel, shots: newShots, hitPoints: newHitPoints };
  const report: FitReport = { shots: shotFits, lines: lineFits, totalDurationSec: masterCursor, needsRewrite };
  return { reel: newReel, report };
}

/** Music tail after the final line, when the reel closes on a card. Matches the assembler's fade-out. */
export const OUTRO_HOLD_SEC = 2.5;

/** Floor for a card with almost nothing on it; below this a card flashes rather than reads. */
const CARD_MIN_SEC = 3;
const CARD_BASE_SEC = 1.5;
const CARD_SEC_PER_WORD = 0.3;

/** How long a viewer needs to read a card: a settle-in, plus a beat per word across all its text. */
export function cardReadSec(card: { title: string; subtitle?: string | undefined; command?: string | undefined }): number {
  const text = [card.title, card.subtitle ?? '', card.command ?? ''].join(' ');
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return Math.max(CARD_MIN_SEC, CARD_BASE_SEC + words * CARD_SEC_PER_WORD);
}

/** First span containing `hit`; falls back to the last span for a hit at (or past) the end. */
function findSpan(hit: number, spans: ShotSpan[]): ShotSpan {
  for (const span of spans) {
    if (hit >= span.start && hit < span.end) return span;
  }
  return spans[spans.length - 1]!;
}

export function compressToFit(report: FitReport, maxAtempo: number = DEFAULT_MAX_ATEMPO): FitReport {
  const shotStarts = new Map<string, number>();
  const shotDurationById = new Map<string, number>();
  let cursor = 0;
  for (const shot of report.shots) {
    shotStarts.set(shot.shotId, cursor);
    shotDurationById.set(shot.shotId, shot.durationSec);
    cursor += shot.durationSec;
  }

  const byShot = new Map<string, LineFit[]>();
  for (const line of report.lines) {
    if (line.tier !== 'needs-rewrite') continue;
    const list = byShot.get(line.shotId);
    if (list) list.push(line);
    else byShot.set(line.shotId, [line]);
  }

  const atempoByShot = new Map<string, number>();
  for (const [shotId, groupLines] of byShot) {
    const shotStart = shotStarts.get(shotId);
    const durationSec = shotDurationById.get(shotId);
    if (shotStart === undefined || durationSec === undefined) continue;

    const sorted = [...groupLines].sort((a, b) => a.atSec - b.atSec);
    const first = sorted[0]!;
    const last = sorted[sorted.length - 1]!;
    const speechSum = groupLines.reduce((sum, l) => sum + l.speechSec, 0);
    const needed = last.atSec + last.speechSec + first.atSec - 2 * shotStart;
    const budgetSec = durationSec - needed + speechSum;
    atempoByShot.set(shotId, budgetSec > 0 ? speechSum / budgetSec : Infinity);
  }

  const lines = report.lines.map((line): LineFit => {
    if (line.tier !== 'needs-rewrite') return line;
    const atempo = atempoByShot.get(line.shotId);
    if (atempo === undefined || atempo > maxAtempo) return line;
    return { ...line, tier: 'compressed', atempo, rewriteBudgetChars: undefined };
  });

  return { ...report, lines, needsRewrite: lines.some((l) => l.tier === 'needs-rewrite') };
}

/**
 * The other half of fitting: once narration has decided how long a shot has to be, slow its
 * footage down enough to actually fill it, instead of running out and freezing on the last frame.
 * Only ever slows a shot — speeding one up would cut footage the model chose to show. Speeds are
 * floored at `MIN_SHOT_SPEED`; past that the footage genuinely cannot carry the shot and a held
 * frame is the honest result.
 */
/**
 * The model chooses where a shot starts — the moment its screen begins drawing. How much to play
 * from there is arithmetic, not judgement, so the range is grown to cover the shot instead of
 * being left as the sliver the onset itself occupies. Never shrinks a range, never runs past the
 * end of the recording.
 */
export function extendRangeToShot(reel: Reel, sourceDurations: Map<string, number>): Reel {
  const shots = reel.shots.map((shot) => {
    const range = shot.evidenceRange;
    if (range === undefined || shot.source === undefined) return shot;
    const sourceEnd = sourceDurations.get(shot.source);
    if (sourceEnd === undefined) return shot;
    const needed = range[0] + shot.durationSec * (shot.speed ?? 1);
    const end = Math.min(Math.max(range[1], needed), sourceEnd);
    return end > range[1] ? { ...shot, evidenceRange: [range[0], end] as [number, number] } : shot;
  });
  return { ...reel, shots };
}

export function stretchFootageToShots(reel: Reel, minSpeed: number = MIN_SHOT_SPEED): Reel {
  const shots = reel.shots.map((shot): Shot => {
    if (!shot.evidenceRange) return shot;
    const covering = (shot.evidenceRange[1] - shot.evidenceRange[0]) / shot.durationSec;
    if (covering >= shotSpeed(shot)) return shot;
    return { ...shot, speed: Math.max(minSpeed, Math.floor(covering * 100) / 100) };
  });
  return { ...reel, shots };
}

/**
 * A shot should open just before the screen starts drawing, so the viewer sees text arrive
 * rather than a page that finished printing before the cut. This is the lead-in kept ahead of
 * that moment: long enough to register the cut, short enough not to read as a dead beat.
 */
export const ONSET_LEAD_SEC = 0.4;

/** How far off the onset a shot may already sit before it is worth moving. */
export const ONSET_TOLERANCE_SEC = 0.5;

/**
 * Held past the end of the stretch a shot opens on. A terminal draws its output in a single
 * frame at the very end of that stretch, so a range that stops there renders the screen as it
 * was *before* the output — the command line and a cursor, and nothing else.
 */
export const ONSET_TAIL_SEC = 1;

/** A range is never shortened below this, so a snapped shot still has something to play. */
const MIN_RANGE_SEC = 0.5;

export interface SourceTiming {
  /** Stretches of this recording a shot may open on. */
  spans: TimeSpan[];
  durationSec: number;
}

export interface OnsetAlignment {
  shotId: string;
  /**
   * Seconds between the shot's first frame and the moment the screen starts drawing. Negative
   * means the shot opens that long before text appears; positive means it opens that far into a
   * stretch already in progress. Undefined when nothing after the range start ever draws.
   */
  offsetSec: number | undefined;
}

/** Where each footage shot sits relative to the moment its screen starts drawing. */
export function onsetAlignments(reel: Reel, timingBySource: Map<string, SourceTiming>): OnsetAlignment[] {
  const soleSource = timingBySource.size === 1 ? [...timingBySource.keys()][0] : undefined;

  return reel.shots.flatMap((shot): OnsetAlignment[] => {
    if (!shot.evidenceRange) return [];
    const timing = timingFor(shot, timingBySource, soleSource);
    if (timing === undefined) return [];
    const onset = onsetFor(shot.evidenceRange[0], timing.spans);
    return [{ shotId: shot.id, offsetSec: onset === undefined ? undefined : shot.evidenceRange[0] - onset }];
  });
}

/**
 * Moves each footage shot's `evidenceRange` so it opens just before its screen starts drawing —
 * forward off dead air the shot would otherwise sit in, or back to the start of a stretch it
 * joined halfway through. Only the range start moves, so no shot loses the material it was
 * chosen for.
 */
export function snapRangeToOnset(reel: Reel, timingBySource: Map<string, SourceTiming>): Reel {
  const soleSource = timingBySource.size === 1 ? [...timingBySource.keys()][0] : undefined;

  const shots = reel.shots.map((shot): Shot => {
    if (!shot.evidenceRange) return shot;
    const timing = timingFor(shot, timingBySource, soleSource);
    if (timing === undefined) return shot;

    const [from, to] = shot.evidenceRange;
    const span = spanFor(from, timing.spans);
    if (span === undefined) return shot;

    const start = Math.abs(from - span.startSec) <= ONSET_TOLERANCE_SEC ? from : Math.max(0, span.startSec - ONSET_LEAD_SEC);
    const end = Math.min(timing.durationSec, Math.max(to, span.endSec + ONSET_TAIL_SEC));
    if (end - start < MIN_RANGE_SEC) return shot;
    if (start === from && end === to) return shot;
    return { ...shot, evidenceRange: [start, end] };
  });

  return { ...reel, shots };
}

/** Shots that show what an earlier shot already showed, which reads as a repeat rather than a cut. */
/**
 * The narration budget is stated in the prompt and routinely written past — 1275 characters
 * against a 945 budget on the long-form example. Every character over it becomes speech the
 * refit has to make room for, which it does by holding shots on their last frame, so an
 * unenforced budget is what turns half a product video into a freeze frame. Stated as an
 * advisory rather than a validation failure: a reel that runs long is still buildable.
 */
export function narrationBudgetAdvisories(reel: Reel, budgetChars: number): string[] {
  const written = reel.narration.reduce((sum, line) => sum + line.text.length, 0);
  if (written <= budgetChars) return [];

  const overBy = written - budgetChars;
  return [
    `the narration totals ${written} characters against a budget of ${budgetChars} — ${overBy} over. ` +
      'Cut whole sentences rather than trimming every line: the reel is stretched to fit whatever is written, ' +
      'so going over does not make it denser, it makes it longer and holds shots on a frozen frame.',
  ];
}

export function repeatedRangeAdvisories(reel: Reel, minOverlapRatio: number = REPEAT_OVERLAP_RATIO): string[] {
  const seen: { shotId: string; source: string; range: readonly [number, number] }[] = [];
  const advisories: string[] = [];

  for (const shot of reel.shots) {
    const range = shot.evidenceRange;
    if (range === undefined) continue;
    const source = shot.source ?? '';

    const earlier = seen.find(
      (other) => other.source === source && overlapRatio(other.range, range) >= minOverlapRatio,
    );
    if (earlier !== undefined) {
      advisories.push(
        `shot "${shot.id}" shows [${range[0].toFixed(2)}, ${range[1].toFixed(2)}] of "${source}", which shot ` +
          `"${earlier.shotId}" already showed — move it to a stretch of the recording no other shot uses`,
      );
    }
    seen.push({ shotId: shot.id, source, range });
  }
  return advisories;
}

/** Shots that do not open on the screen starting to draw, phrased as the fix the model has to make. */
export function onsetAdvisories(reel: Reel, timingBySource: Map<string, SourceTiming>): string[] {
  const soleSource = timingBySource.size === 1 ? [...timingBySource.keys()][0] : undefined;
  const advisories: string[] = [];

  for (const shot of reel.shots) {
    const range = shot.evidenceRange;
    if (range === undefined) continue;
    const timing = timingFor(shot, timingBySource, soleSource);
    if (timing === undefined) continue;

    const onset = onsetFor(range[0], timing.spans);
    if (onset === undefined) {
      advisories.push(`shot "${shot.id}" starts at ${range[0].toFixed(2)}s of "${shot.source ?? ''}", after which nothing is ever drawn`);
      continue;
    }
    const offset = range[0] - onset;
    if (Math.abs(offset) <= ONSET_TOLERANCE_SEC) continue;

    advisories.push(
      offset > 0
        ? `shot "${shot.id}" joins "${shot.source ?? ''}" ${offset.toFixed(2)}s after the screen started drawing at ${onset.toFixed(2)}s — start it there instead`
        : `shot "${shot.id}" opens on ${(-offset).toFixed(2)}s of a screen that is not moving; the next thing drawn is at ${onset.toFixed(2)}s — start it there instead`,
    );
  }
  return advisories;
}

/** Overlap of two ranges as a share of the shorter one. */
const REPEAT_OVERLAP_RATIO = 0.75;

function overlapRatio(a: readonly [number, number], b: readonly [number, number]): number {
  const shorter = Math.min(a[1] - a[0], b[1] - b[0]);
  if (shorter <= 0) return 0;
  return Math.max(0, Math.min(a[1], b[1]) - Math.max(a[0], b[0])) / shorter;
}

function timingFor(shot: Shot, timingBySource: Map<string, SourceTiming>, soleSource: string | undefined): SourceTiming | undefined {
  const sourceId = shot.source ?? soleSource;
  return sourceId === undefined ? undefined : timingBySource.get(sourceId);
}

/** The stretch of drawing a range beginning at `fromSec` belongs to: the one it is inside, else the next. */
function spanFor(fromSec: number, spans: TimeSpan[]): TimeSpan | undefined {
  return spans.find((span) => fromSec < span.endSec);
}

function onsetFor(fromSec: number, spans: TimeSpan[]): number | undefined {
  return spanFor(fromSec, spans)?.startSec;
}

export interface MotionBreakdown {
  totalSec: number;
  /** On-screen seconds filled by a shot's own footage rather than a held frame. */
  footageSec: number;
  /** On-screen seconds where the recording behind the shot actually redraws — footage minus its own dead air. */
  changingSec: number;
  /** Seconds of title cards and stills: graphics that were never meant to move. */
  graphicSec: number;
  /**
   * Seconds a footage shot spends frozen on its last frame because the recording ran out. Kept
   * apart from `graphicSec`: a card standing still is the design working, a terminal standing
   * still is the design running short, and folding them together hides which one is happening.
   */
  heldSec: number;
}

/**
 * What the finished reel actually shows. `footageSec` is what the fitter can see; `changingSec`
 * is the part a viewer reads as motion, because a range laid over a pause in the recording plays
 * back as still as a held frame does.
 */
export function motionBreakdown(reel: Reel, activeBySource: Map<string, TimeSpan[]>): MotionBreakdown {
  const soleSource = activeBySource.size === 1 ? [...activeBySource.keys()][0] : undefined;
  let totalSec = 0;
  let footageSec = 0;
  let changingSec = 0;
  let graphicSec = 0;

  for (const shot of reel.shots) {
    totalSec += shot.durationSec;
    const range = shot.evidenceRange;
    if (range === undefined) {
      graphicSec += shot.durationSec;
      continue;
    }

    const speed = shotSpeed(shot);
    const played = Math.min(shot.durationSec, (range[1] - range[0]) / speed);
    footageSec += played;

    const sourceId = shot.source ?? soleSource;
    const active = sourceId === undefined ? undefined : activeBySource.get(sourceId);
    if (active === undefined) continue;
    changingSec += overlapSec(range[0], range[0] + played * speed, active) / speed;
  }

  return { totalSec, footageSec, changingSec, graphicSec, heldSec: totalSec - footageSec - graphicSec };
}

function overlapSec(fromSec: number, toSec: number, spans: TimeSpan[]): number {
  let sum = 0;
  for (const span of spans) {
    sum += Math.max(0, Math.min(toSec, span.endSec) - Math.max(fromSec, span.startSec));
  }
  return sum;
}

/**
 * Cards that carry more than one line of narration. A card is punctuation between chapters, so a
 * line spoken over one is a claim with no footage behind it — and because the refit stretches a
 * shot to hold whatever is said on it, stacking lines on a card turns a title screen into the
 * longest shot in the reel. Advisory rather than a failure: such a reel still builds.
 */
export function cardNarrationAdvisories(reel: Reel): string[] {
  const cardIds = new Set(reel.shots.filter((shot) => shot.kind === 'card').map((shot) => shot.id));
  const linesByShot = new Map<string, string[]>();
  for (const line of reel.narration) {
    if (!cardIds.has(line.shotId)) continue;
    linesByShot.set(line.shotId, [...(linesByShot.get(line.shotId) ?? []), line.id]);
  }

  return [...linesByShot]
    .filter(([, lines]) => lines.length > 1)
    .map(
      ([shotId, lines]) =>
        `card "${shotId}" carries ${lines.length} narration lines (${lines.join(', ')}) — a card holds at most one. ` +
        'Move the rest onto shots that show the footage backing them up, or cut them.',
    );
}
