import type { Recording } from './types.js';

/**
 * Where a recording's screen actually changes. A terminal session is mostly waiting: the
 * pauses a shot's `evidenceRange` lands on are frozen pixels, so both the prompt (which spans
 * are worth showing) and the fitter (trimming dead air off the head of a range) need them
 * separated from the moments something is drawn.
 */

/** A [start, end] stretch measured in the recording's own seconds. */
export interface TimeSpan {
  startSec: number;
  endSec: number;
}

/** Below this an "active" stretch is a single redraw, not something a shot can be built on. */
export const MIN_ACTIVE_SPAN_SEC = 0.3;

/** Merged, sorted stretches where nothing is drawn, clamped to the recording. */
export function pauseSpans(recording: Recording): TimeSpan[] {
  const raw: TimeSpan[] = [];
  for (const evidence of recording.evidence) {
    if (evidence.kind !== 'pause' || evidence.durationSec === undefined) continue;
    const startSec = Math.max(0, Math.min(evidence.t, recording.durationSec));
    const endSec = Math.max(startSec, Math.min(evidence.t + evidence.durationSec, recording.durationSec));
    if (endSec > startSec) raw.push({ startSec, endSec });
  }
  return mergeSpans(raw);
}

/** The complement of {@link pauseSpans} inside [0, durationSec], dropping stretches too short to show. */
export function activeSpans(recording: Recording, minSpanSec: number = MIN_ACTIVE_SPAN_SEC): TimeSpan[] {
  const spans: TimeSpan[] = [];
  let cursor = 0;
  for (const pause of pauseSpans(recording)) {
    if (pause.startSec - cursor >= minSpanSec) spans.push({ startSec: cursor, endSec: pause.startSec });
    cursor = Math.max(cursor, pause.endSec);
  }
  if (recording.durationSec - cursor >= minSpanSec) spans.push({ startSec: cursor, endSec: recording.durationSec });
  return spans;
}

/**
 * Characters on screen a shot needs to land on before it reads as a page rather than a bare
 * prompt. Measured against the sampled reels: an opening command line alone runs 50-70, the
 * first real block of output clears 200.
 */
export const MIN_READABLE_CHARS = 150;

/**
 * Active spans that leave enough text on screen to be worth cutting to. The first span of a
 * recording is usually the command being echoed with nothing printed yet — the screen is a
 * prompt and a cursor, which is the emptiest frame a terminal video can hold.
 */
export function readableSpans(recording: Recording, minChars: number = MIN_READABLE_CHARS): TimeSpan[] {
  return activeSpans(recording).filter((span) => drawnCharsBy(recording, span.endSec) >= minChars);
}

/** Characters drawn to the screen at or before `atSec`, as a stand-in for how full the screen looks. */
export function drawnCharsBy(recording: Recording, atSec: number): number {
  return recording.evidence
    .filter((e) => (e.kind === 'output' || e.kind === 'command') && e.t <= atSec)
    .reduce((sum, e) => sum + e.text.length, 0);
}

/** Seconds of a recording where something is drawn — what is really available to cut from. */
export function activeSec(recording: Recording, minSpanSec: number = MIN_ACTIVE_SPAN_SEC): number {
  return activeSpans(recording, minSpanSec).reduce((sum, span) => sum + (span.endSec - span.startSec), 0);
}

function mergeSpans(spans: TimeSpan[]): TimeSpan[] {
  const sorted = [...spans].sort((a, b) => a.startSec - b.startSec);
  const merged: TimeSpan[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.startSec <= last.endSec) {
      last.endSec = Math.max(last.endSec, span.endSec);
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}
