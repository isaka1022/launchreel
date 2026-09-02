/**
 * Text layout for the SVG the renderers hand to `rsvg-convert`. rsvg has no idea how wide a string
 * will be until it draws it, so every line break has to be decided here from an estimate of the
 * glyph width — shared by the cards and the captions so both break text the same way.
 */

/** Ratio of glyph advance to font size. CJK is effectively full-width; Latin averages far narrower. */
const LATIN_CHAR_RATIO = 0.58;
const CJK_CHAR_RATIO = 1.05;

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function hasCjk(text: string): boolean {
  return /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/.test(text);
}

export function charWidthRatio(text: string): number {
  return hasCjk(text) ? CJK_CHAR_RATIO : LATIN_CHAR_RATIO;
}

export function estimateMaxChars(text: string, fontSize: number, maxWidthPx: number): number {
  return Math.max(4, Math.floor(maxWidthPx / (fontSize * charWidthRatio(text))));
}

export function wrapText(text: string, maxCharsPerLine: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return [text];

  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    for (const chunk of chunkWord(word, maxCharsPerLine)) {
      const candidate = current.length === 0 ? chunk : `${current} ${chunk}`;
      if (candidate.length > maxCharsPerLine && current.length > 0) {
        lines.push(current);
        current = chunk;
      } else {
        current = candidate;
      }
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [text];
}

/**
 * Wraps to the same number of lines as {@link wrapText} but at the narrowest measure that still
 * fits them, which stops a line break from stranding one word on a line of its own.
 */
export function wrapBalanced(text: string, maxCharsPerLine: number): string[] {
  const target = wrapText(text, maxCharsPerLine).length;
  if (target <= 1) return wrapText(text, maxCharsPerLine);

  let best = wrapText(text, maxCharsPerLine);
  for (let width = maxCharsPerLine - 1; width >= 4; width--) {
    const candidate = wrapText(text, width);
    if (candidate.length !== target) break;
    best = candidate;
  }
  return best;
}

export interface TextBlock {
  x: number;
  /** Top of the block; the first baseline is placed inside it, not on it. */
  blockTop: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  fill: string;
  lines: string[];
  bold?: boolean;
  anchor?: 'start' | 'middle';
}

export function textElement(block: TextBlock): string {
  const firstBaseline = block.blockTop + Math.round(block.fontSize * 0.82);
  const weightAttr = block.bold === true ? ' font-weight="bold"' : '';
  const anchorAttr = block.anchor === 'middle' ? ' text-anchor="middle"' : '';
  const tspans = block.lines
    .map((line, i) => `<tspan x="${block.x}" dy="${i === 0 ? 0 : block.lineHeight}">${escapeXml(line)}</tspan>`)
    .join('');
  return `<text x="${block.x}" y="${firstBaseline}" font-family="${block.fontFamily}"${weightAttr}${anchorAttr} font-size="${block.fontSize}" fill="${block.fill}">${tspans}</text>`;
}

function chunkWord(word: string, maxLen: number): string[] {
  if (word.length <= maxLen) return [word];
  const chunks: string[] = [];
  for (let i = 0; i < word.length; i += maxLen) chunks.push(word.slice(i, i + maxLen));
  return chunks;
}
