import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFfmpeg } from "../drivers/ffmpeg.js";
import { probeDurationSec } from "../drivers/probe.js";
import { renderSvg } from "../drivers/rsvg.js";
import {
  charWidthRatio,
  estimateMaxChars,
  textElement,
  wrapBalanced,
  wrapText,
} from "./svg-text.js";
import { cacheKey } from "../order/media.js";
import type { Shot } from "../timeline/schema.js";
import { verifyDuration, type RenderedShot } from "./terminal.js";

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
export const DEFAULT_BACKGROUND = "#111318";

/** Bumped when the card's motion changes, so cached renders of the old look are not reused. */
const CARD_MOTION_VERSION = 2;
/** The title settles in first; the rest follows once the eye has landed on it. */
const TITLE_FADE_SEC = 0.5;
const REST_DELAY_SEC = 0.45;
const REST_FADE_SEC = 0.5;

const TITLE_FONT = "Arial, Hiragino Sans";
const COMMAND_FONT = "Menlo, Courier New, monospace";

interface ThemeColors {
  title: string;
  subtitle: string;
  commandBox: string;
  commandText: string;
}

const THEME_COLORS: Record<"dark" | "light", ThemeColors> = {
  dark: {
    title: "#f5f6fa",
    subtitle: "#9aa0ac",
    commandBox: "#1c2029",
    commandText: "#7ee7c7",
  },
  light: {
    title: "#14161b",
    subtitle: "#55596a",
    commandBox: "#e7e9ee",
    commandText: "#0a7a5c",
  },
};

export interface RenderCardShotOptions {
  outDir: string;
  fps?: number;
  width?: number;
  height?: number;
  background?: string;
  theme?: "dark" | "light";
}

export async function renderCard(
  shot: Shot,
  options: RenderCardShotOptions,
): Promise<RenderedShot> {
  if (!shot.card)
    throw new Error(
      `shot "${shot.id}" is kind "${shot.kind}" but has no card text`,
    );

  const fps = options.fps ?? DEFAULT_FPS;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const background = options.background ?? DEFAULT_BACKGROUND;
  const themeName = options.theme ?? "dark";
  const theme = THEME_COLORS[themeName];
  if (!existsSync(options.outDir))
    mkdirSync(options.outDir, { recursive: true });

  const key = cacheKey([
    shot.id,
    shot.card,
    shot.durationSec,
    fps,
    width,
    height,
    background,
    themeName,
    CARD_MOTION_VERSION,
  ]);
  const outPath = join(options.outDir, `${shot.id}-${key}.mp4`);
  if (existsSync(outPath))
    return { path: outPath, durationSec: await probeDurationSec(outPath) };

  // Two layers: the title on the background, then the rest fading in over it a beat later — the
  // card is read in the order it was written, and a still that appears in stages never looks like
  // a frozen frame.
  const layers = (["title", "rest"] as const).map((layer) => ({
    svgPath: join(options.outDir, `${shot.id}-${key}-${layer}.svg`),
    pngPath: join(options.outDir, `${shot.id}-${key}-${layer}.png`),
    layer,
  }));
  for (const { svgPath, layer } of layers) {
    writeFileSync(
      svgPath,
      buildCardSvg(shot.card, { width, height, background, theme }, layer),
    );
  }

  try {
    for (const { svgPath, pngPath } of layers)
      await renderSvg({ svgPath, outPngPath: pngPath });
    await runFfmpeg([
      "-y",
      "-loop",
      "1",
      "-i",
      layers[0]!.pngPath,
      "-loop",
      "1",
      "-i",
      layers[1]!.pngPath,
      "-t",
      shot.durationSec.toFixed(3),
      "-r",
      String(fps),
      "-filter_complex",
      cardMotionFilter(background),
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      outPath,
    ]);
  } finally {
    for (const tmpPath of layers.flatMap(({ svgPath, pngPath }) => [
      svgPath,
      pngPath,
    ])) {
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

/** Fades the title layer in from the background, then the rest layer in over it by alpha. */
export function cardMotionFilter(background: string): string {
  const color = background.replace(/^#/, "0x");
  return (
    `[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,fade=t=in:st=0:d=${TITLE_FADE_SEC}:color=${color}[base];` +
    `[1:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,format=rgba,fade=t=in:st=${REST_DELAY_SEC}:d=${REST_FADE_SEC}:alpha=1[rest];` +
    "[base][rest]overlay=0:0:format=auto"
  );
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

/** Which of the card's parts a rendered layer carries. Positions are identical across layers. */
type CardLayer = "title" | "rest";

function buildCardSvg(
  card: CardText,
  layout: CardLayout,
  layer: CardLayer,
): string {
  const { width, height, background, theme } = layout;
  const paddingX = Math.round(width * 0.08);
  const maxTextWidth = width - paddingX * 2;
  const blockGap = Math.round(height * 0.045);

  const titleFontSize = fitTitleFontSize(card.title, height, maxTextWidth);
  const titleLineHeight = Math.round(titleFontSize * 1.15);
  const titleLines = wrapBalanced(
    card.title,
    estimateMaxChars(card.title, titleFontSize, maxTextWidth),
  );

  const subtitleFontSize = Math.round(height * 0.041);
  const subtitleLineHeight = Math.round(subtitleFontSize * 1.35);
  const subtitleLines =
    card.subtitle !== undefined
      ? wrapBalanced(
          card.subtitle,
          estimateMaxChars(card.subtitle, subtitleFontSize, maxTextWidth),
        )
      : [];

  const commandFontSize = Math.round(height * 0.032);
  const commandLineHeight = Math.round(commandFontSize * 1.5);
  const commandLines =
    card.command !== undefined && card.command.trim() !== ""
      ? wrapText(
          card.command,
          estimateMaxChars(card.command, commandFontSize, maxTextWidth * 0.92),
        )
      : [];
  const commandBoxPaddingX = Math.round(commandFontSize * 0.9);
  const commandBoxPaddingY = Math.round(commandFontSize * 0.7);
  const commandBoxHeight =
    commandLines.length > 0
      ? commandLines.length * commandLineHeight + commandBoxPaddingY * 2
      : 0;

  const titleBlockHeight = titleLines.length * titleLineHeight;
  const subtitleBlockHeight =
    subtitleLines.length > 0
      ? blockGap + subtitleLines.length * subtitleLineHeight
      : 0;
  const commandBlockHeight =
    commandLines.length > 0 ? blockGap + commandBoxHeight : 0;
  const totalHeight =
    titleBlockHeight + subtitleBlockHeight + commandBlockHeight;

  let cursorY = Math.round((height - totalHeight) / 2);
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">`,
  ];
  if (layer === "title")
    parts.push(
      `<rect width="${width}" height="${height}" fill="${background}"/>`,
    );
  const show = (part: CardLayer): boolean => part === layer;

  if (show("title"))
    parts.push(
      textElement({
        x: paddingX,
        blockTop: cursorY,
        fontSize: titleFontSize,
        lineHeight: titleLineHeight,
        fontFamily: TITLE_FONT,
        fill: theme.title,
        lines: titleLines,
        bold: true,
      }),
    );
  cursorY += titleBlockHeight;

  if (subtitleLines.length > 0) {
    cursorY += blockGap;
    if (show("rest"))
      parts.push(
        textElement({
          x: paddingX,
          blockTop: cursorY,
          fontSize: subtitleFontSize,
          lineHeight: subtitleLineHeight,
          fontFamily: TITLE_FONT,
          fill: theme.subtitle,
          lines: subtitleLines,
        }),
      );
    cursorY += subtitleLines.length * subtitleLineHeight;
  }

  if (commandLines.length > 0 && show("rest")) {
    cursorY += blockGap;
    const longestLine = Math.max(...commandLines.map((line) => line.length));
    const boxWidth = Math.min(
      maxTextWidth,
      Math.round(longestLine * commandFontSize * 0.62) + commandBoxPaddingX * 2,
    );
    parts.push(
      `<rect x="${paddingX}" y="${cursorY}" width="${boxWidth}" height="${commandBoxHeight}" rx="${Math.round(commandFontSize * 0.4)}" fill="${theme.commandBox}"/>`,
    );
    const textX = paddingX + commandBoxPaddingX;
    parts.push(
      textElement({
        x: textX,
        blockTop: cursorY + commandBoxPaddingY,
        fontSize: commandFontSize,
        lineHeight: commandLineHeight,
        fontFamily: COMMAND_FONT,
        fill: theme.commandText,
        lines: commandLines,
      }),
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}

/** Fractions of the frame height a title may occupy. Short titles grow into the measure; long ones stay readable. */
const TITLE_SIZE_MIN_RATIO = 0.075;
const TITLE_SIZE_MAX_RATIO = 0.155;

/**
 * A title set at a fixed size leaves a short one stranded in the left third of the frame with
 * two-thirds of the card empty — the giveaway that nothing composed it. Grow the type until the
 * longest line fills the measure instead, so "LaunchReel" and a full sentence both sit as a block
 * of text rather than as the same size on very different amounts of space.
 */
export function fitTitleFontSize(
  title: string,
  height: number,
  maxTextWidth: number,
): number {
  const min = Math.round(height * TITLE_SIZE_MIN_RATIO);
  const max = Math.round(height * TITLE_SIZE_MAX_RATIO);
  const widest = Math.max(
    ...wrapText(title, estimateMaxChars(title, min, maxTextWidth)).map(
      (line) => line.length,
    ),
  );
  if (widest <= 0) return min;
  const perChar = charWidthRatio(title);
  return Math.min(
    max,
    Math.max(min, Math.floor(maxTextWidth / (widest * perChar))),
  );
}
