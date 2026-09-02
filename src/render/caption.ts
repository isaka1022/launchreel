import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderSvg } from '../drivers/rsvg.js';
import { cacheKey } from '../order/media.js';
import { estimateMaxChars, textElement, wrapBalanced } from './svg-text.js';

/**
 * Draws one narration line as a transparent PNG the assembler composites over the picture with
 * `overlay`. ffmpeg's own `subtitles` filter would be the obvious way to burn captions in, but it
 * needs libass and this machine's build has neither libass nor libfreetype — the same reason
 * `card.ts` draws its text in SVG. Doing it this way also means the captions are set in the card
 * typeface rather than whatever a subtitle renderer would pick.
 */

const CAPTION_FONT = 'Arial, Hiragino Sans';
const CAPTION_TEXT = '#f5f6fa';
/** The card background at 78% — dark enough to hold white text over a bright terminal, still see-through. */
const CAPTION_BOX = '#111318';
const CAPTION_BOX_OPACITY = 0.78;

/** Fractions of the frame height: type size, gap from the bottom edge, padding inside the box. */
const FONT_RATIO = 0.036;
const BOTTOM_MARGIN_RATIO = 0.06;
const BOX_PADDING_X_RATIO = 0.6;
const BOX_PADDING_Y_RATIO = 0.45;
/** Captions wrap within this share of the frame so they never run to the edges. */
const MAX_WIDTH_RATIO = 0.8;

export interface CaptionLayout {
  width: number;
  height: number;
}

export function buildCaptionSvg(text: string, layout: CaptionLayout): string {
  const { width, height } = layout;
  const fontSize = Math.round(height * FONT_RATIO);
  const lineHeight = Math.round(fontSize * 1.35);
  const maxTextWidth = Math.round(width * MAX_WIDTH_RATIO);
  const lines = wrapBalanced(text, estimateMaxChars(text, fontSize, maxTextWidth));

  const paddingX = Math.round(fontSize * BOX_PADDING_X_RATIO);
  const paddingY = Math.round(fontSize * BOX_PADDING_Y_RATIO);
  const boxHeight = lines.length * lineHeight + paddingY * 2;
  const longest = Math.max(...lines.map((line) => line.length));
  const boxWidth = Math.min(width - paddingX * 2, Math.round(longest * fontSize * 0.58) + paddingX * 2);
  const boxX = Math.round((width - boxWidth) / 2);
  const boxY = height - Math.round(height * BOTTOM_MARGIN_RATIO) - boxHeight;

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect x="${boxX}" y="${boxY}" width="${boxWidth}" height="${boxHeight}" rx="${Math.round(fontSize * 0.35)}" fill="${CAPTION_BOX}" fill-opacity="${CAPTION_BOX_OPACITY}"/>`,
    textElement({
      x: Math.round(width / 2),
      blockTop: boxY + paddingY,
      fontSize,
      lineHeight,
      fontFamily: CAPTION_FONT,
      fill: CAPTION_TEXT,
      lines,
      anchor: 'middle',
    }),
    '</svg>',
  ].join('\n');
}

export interface RenderCaptionOptions extends CaptionLayout {
  outDir: string;
}

/** Rasterizes one caption and returns the PNG path. Identical text reuses the same file. */
export async function renderCaption(text: string, options: RenderCaptionOptions): Promise<string> {
  const { outDir, width, height } = options;
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const key = cacheKey([text, width, height]);
  const pngPath = join(outDir, `caption-${key}.png`);
  if (existsSync(pngPath)) return pngPath;

  const svgPath = join(outDir, `caption-${key}.svg`);
  writeFileSync(svgPath, buildCaptionSvg(text, { width, height }));
  try {
    await renderSvg({ svgPath, outPngPath: pngPath });
  } finally {
    try {
      unlinkSync(svgPath);
    } catch {
      // best-effort cleanup of the intermediate; the PNG is what matters
    }
  }
  return pngPath;
}
