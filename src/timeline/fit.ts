import { shotSpans, type NarrationLine, type Reel, type Shot, type ShotSpan } from './schema.js';
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
  const padSec = options.padSec ?? DEFAULT_PAD_SEC;
  const maxShotSec = options.maxShotSec ?? DEFAULT_MAX_SHOT_SEC;

  const originalSpans = shotSpans(reel);

  const linesByShot = new Map<string, NarrationLine[]>();
  for (const line of reel.narration) {
    const list = linesByShot.get(line.shotId);
    if (list) list.push(line);
    else linesByShot.set(line.shotId, [line]);
  }

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

    let durationSec = shot.durationSec;
    let tier: FitTier = 'fits';
    let budgetSecTotal = 0;

    if (calc.length > 0) {
      if (needed <= shot.durationSec) {
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
    let cursor = padSec;
    for (const { line, speechSec } of calc) {
      const atSec = line.atSec ?? shotStart + cursor;
      cursor = (line.atSec !== undefined ? line.atSec - shotStart : cursor) + speechSec + lineGapSec;

      const lineFit: LineFit = { lineId: line.id, shotId: shot.id, speechSec, atSec, tier };
      if (tier === 'needs-rewrite') {
        const share = speechSum > 0 ? speechSec / speechSum : 0;
        lineFit.rewriteBudgetChars = Math.max(0, Math.floor(budgetSecTotal * share * charsPerSecond(line.text)));
      }
      lineFits.push(lineFit);
    }

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
