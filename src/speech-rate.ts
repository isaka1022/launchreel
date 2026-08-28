/**
 * Speaking-rate model, shared by the timeline fitter and the OTIO emitter so the two can't
 * drift apart. Used only before real audio exists — once a wav has been synthesized, its
 * probed duration wins everywhere.
 */

const CJK_PATTERN = /[　-ヿ㐀-䶿一-鿿豈-﫿]/;

export const CJK_CHARS_PER_SEC = 7.5;
export const LATIN_CHARS_PER_SEC = 14;

/** Shortest clip we are willing to place, so a one-word line still reads on screen. */
export const MIN_SPEECH_SEC = 0.6;

export function charsPerSecond(text: string): number {
  return CJK_PATTERN.test(text) ? CJK_CHARS_PER_SEC : LATIN_CHARS_PER_SEC;
}

export function estimateSpeechSeconds(text: string): number {
  return Math.max(MIN_SPEECH_SEC, text.trim().length / charsPerSecond(text));
}
