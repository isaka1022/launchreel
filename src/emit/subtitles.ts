/**
 * Subtitles are generated from the same placement the narration audio is mixed at, never from the
 * planned times, so a caption cannot drift away from the voice it belongs to.
 */

export interface SubtitleCue {
  startSec: number;
  endSec: number;
  text: string;
}

/** Longer lines are split rather than left to the renderer, which would run them off the frame. */
const MAX_CHARS_PER_LINE = 42;

export function toSrt(cues: SubtitleCue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.startSec)} --> ${srtTime(cue.endSec)}\n${wrap(cue.text)}\n`)
    .join('\n');
}

/** `HH:MM:SS,mmm`, the only timecode form SRT accepts. */
export function srtTime(sec: number): string {
  const clamped = Math.max(0, sec);
  const ms = Math.round(clamped * 1000);
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)},${pad(rest, 3)}`;
}

/** Breaks on whitespace into at most two balanced lines; a single long word is left alone. */
export function wrap(text: string, maxChars = MAX_CHARS_PER_LINE): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  if (collapsed.length <= maxChars) return collapsed;

  // Two even lines beat one long one even when neither half fits the measure: a player wraps an
  // over-long line wherever it likes, which is how a caption ends up with one word on its own line.
  const words = collapsed.split(' ');
  let fitting: string | undefined;
  let fittingDelta = Number.POSITIVE_INFINITY;
  let balanced = collapsed;
  let balancedDelta = Number.POSITIVE_INFINITY;
  for (let i = 1; i < words.length; i++) {
    const head = words.slice(0, i).join(' ');
    const tail = words.slice(i).join(' ');
    const delta = Math.abs(head.length - tail.length);
    if (delta < balancedDelta) {
      balanced = `${head}\n${tail}`;
      balancedDelta = delta;
    }
    if (Math.max(head.length, tail.length) <= maxChars && delta < fittingDelta) {
      fitting = `${head}\n${tail}`;
      fittingDelta = delta;
    }
  }
  return fitting ?? balanced;
}
