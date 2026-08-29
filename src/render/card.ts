import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg } from '../drivers/ffmpeg.js';
import { probeDurationSec } from '../drivers/probe.js';
import { renderSvg } from '../drivers/rsvg.js';
import { cacheKey } from '../order/media.js';
import type { Shot } from '../timeline/schema.js';
import { verifyDuration, type RenderedShot } from './terminal.js';

/**
 * Renders a `card` shot's title/subtitle/command to an mp4. Text is drawn in SVG and rasterized
 * with `rsvg-convert`, then held for the shot's duration with ffmpeg (see rsvg.ts for why).
 *
 * Fonts are real macOS families, confirmed present and resolving through fontconfig with
 * `fc-list`/`fc-match` and a rendered sample (not guessed): "Arial" -> Arial.ttf/Arial Bold.ttf,
 * "Hiragino Sans" -> ヒラギノ角ゴシック W4.ttc (covers Japanese), "Menlo" -> Menlo.ttc.
 */

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_FPS = 30;
/** Shared with `emit/assemble.ts` so letterbox padding matches a card's own background. */
export const DEFAULT_BACKGROUND = '#111318';

const TITLE_FONT = 'Arial, Hiragino Sans';
const COMMAND_FONT = 'Menlo, Courier New, monospace';

interface ThemeColors {
  title: string;
  subtitle: string;
  commandBox: string;
  commandText: string;
}

const THEME_COLORS: Record<'dark' | 'light', ThemeColors> = {
  dark: { title: '#f5f6fa', subtitle: '#9aa0ac', commandBox: '#1c2029', commandText: '#7ee7c7' },
  light: { title: '#14161b', subtitle: '#55596a', commandBox: '#e7e9ee', commandText: '#0a7a5c' },
};

export interface RenderCardShotOptions {
  outDir: string;
  fps?: number;
  width?: number;
  height?: number;
  background?: string;
  theme?: 'dark' | 'light';
}

export async function renderCard(shot: Shot, options: RenderCardShotOptions): Promise<RenderedShot> {
  if (!shot.card) throw new Error(`shot "${shot.id}" is kind "${shot.kind}" but has no card text`);

  const fps = options.fps ?? DEFAULT_FPS;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const background = options.background ?? DEFAULT_BACKGROUND;
  const themeName = options.theme ?? 'dark';
  const theme = THEME_COLORS[themeName];
  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });

  const key = cacheKey([shot.id, shot.card, shot.durationSec, fps, width, height, background, themeName]);
  const outPath = join(options.outDir, `${shot.id}-${key}.mp4`);
  if (existsSync(outPath)) return { path: outPath, durationSec: await probeDurationSec(outPath) };

  const svgPath = join(options.outDir, `${shot.id}-${key}.svg`);
  const pngPath = join(options.outDir, `${shot.id}-${key}.png`);
  writeFileSync(svgPath, buildCardSvg(shot.card, { width, height, background, theme }));

  try {
    await renderSvg({ svgPath, outPngPath: pngPath });
    await runFfmpeg([
      '-y',
      '-loop',
      '1',
      '-i',
      pngPath,
      '-t',
      shot.durationSec.toFixed(3),
      '-r',
      String(fps),
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-pix_fmt',
      'yuv420p',
      '-c:v',
      'libx264',
      outPath,
    ]);
  } finally {
    for (const tmpPath of [svgPath, pngPath]) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best-effort cleanup of intermediates; the mp4 is what matters
      }
    }
  }

  const durationSec = await probeDurationSec(outPath);
  verifyDuration(shot.id, shot.durationSec, durationSec);
  return { path: outPath, durationSec };
}

interface CardText {
  title: string;
  subtitle?: string | undefined;
  command?: string | undefined;
}

interface CardLayout {
  width: number;
  height: number;
  background: string;
  theme: ThemeColors;
}

function buildCardSvg(card: CardText, layout: CardLayout): string {
  const { width, height, background, theme } = layout;
  const paddingX = Math.round(width * 0.08);
  const maxTextWidth = width - paddingX * 2;
  const blockGap = Math.round(height * 0.045);

  const titleFontSize = Math.round(height * 0.09);
  const titleLineHeight = Math.round(titleFontSize * 1.15);
  const titleLines = wrapText(card.title, estimateMaxChars(card.title, titleFontSize, maxTextWidth));

  const subtitleFontSize = Math.round(height * 0.041);
  const subtitleLineHeight = Math.round(subtitleFontSize * 1.35);
  const subtitleLines =
    card.subtitle !== undefined ? wrapText(card.subtitle, estimateMaxChars(card.subtitle, subtitleFontSize, maxTextWidth)) : [];

  const commandFontSize = Math.round(height * 0.032);
  const commandLineHeight = Math.round(commandFontSize * 1.5);
  const commandLines =
    card.command !== undefined && card.command.trim() !== ''
      ? wrapText(card.command, estimateMaxChars(card.command, commandFontSize, maxTextWidth * 0.92))
      : [];
  const commandBoxPaddingX = Math.round(commandFontSize * 0.9);
  const commandBoxPaddingY = Math.round(commandFontSize * 0.7);
  const commandBoxHeight = commandLines.length > 0 ? commandLines.length * commandLineHeight + commandBoxPaddingY * 2 : 0;

  const titleBlockHeight = titleLines.length * titleLineHeight;
  const subtitleBlockHeight = subtitleLines.length > 0 ? blockGap + subtitleLines.length * subtitleLineHeight : 0;
  const commandBlockHeight = commandLines.length > 0 ? blockGap + commandBoxHeight : 0;
  const totalHeight = titleBlockHeight + subtitleBlockHeight + commandBlockHeight;

  let cursorY = Math.round((height - totalHeight) / 2);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
    `<rect width="${width}" height="${height}" fill="${background}"/>`,
  ];

  parts.push(textElement(paddingX, cursorY, titleFontSize, titleLineHeight, TITLE_FONT, theme.title, titleLines, true));
  cursorY += titleBlockHeight;

  if (subtitleLines.length > 0) {
    cursorY += blockGap;
    parts.push(
      textElement(paddingX, cursorY, subtitleFontSize, subtitleLineHeight, TITLE_FONT, theme.subtitle, subtitleLines, false),
    );
    cursorY += subtitleLines.length * subtitleLineHeight;
  }

  if (commandLines.length > 0) {
    cursorY += blockGap;
    const longestLine = Math.max(...commandLines.map((line) => line.length));
    const boxWidth = Math.min(maxTextWidth, Math.round(longestLine * commandFontSize * 0.62) + commandBoxPaddingX * 2);
    parts.push(
      `<rect x="${paddingX}" y="${cursorY}" width="${boxWidth}" height="${commandBoxHeight}" rx="${Math.round(commandFontSize * 0.4)}" fill="${theme.commandBox}"/>`,
    );
    const textX = paddingX + commandBoxPaddingX;
    parts.push(
      textElement(
        textX,
        cursorY + commandBoxPaddingY,
        commandFontSize,
        commandLineHeight,
        COMMAND_FONT,
        theme.commandText,
        commandLines,
        false,
      ),
    );
  }

  parts.push('</svg>');
  return parts.join('\n');
}

function textElement(
  x: number,
  blockTop: number,
  fontSize: number,
  lineHeight: number,
  fontFamily: string,
  fill: string,
  lines: string[],
  bold: boolean,
): string {
  const firstBaseline = blockTop + Math.round(fontSize * 0.82);
  const weightAttr = bold ? ' font-weight="bold"' : '';
  const tspans = lines
    .map((line, i) => `<tspan x="${x}" dy="${i === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`)
    .join('');
  return `<text x="${x}" y="${firstBaseline}" font-family="${fontFamily}"${weightAttr} font-size="${fontSize}" fill="${fill}">${tspans}</text>`;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function hasCjk(text: string): boolean {
  return /[　-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/.test(text);
}

function estimateMaxChars(text: string, fontSize: number, maxWidthPx: number): number {
  const avgCharWidth = hasCjk(text) ? fontSize * 1.05 : fontSize * 0.58;
  return Math.max(4, Math.floor(maxWidthPx / avgCharWidth));
}

function wrapText(text: string, maxCharsPerLine: number): string[] {
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

function chunkWord(word: string, maxLen: number): string[] {
  if (word.length <= maxLen) return [word];
  const chunks: string[] = [];
  for (let i = 0; i < word.length; i += maxLen) chunks.push(word.slice(i, i + maxLen));
  return chunks;
}
