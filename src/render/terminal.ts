import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { renderCast } from '../drivers/agg.js';
import { runFfmpeg, runFfmpegCapture } from '../drivers/ffmpeg.js';
import { probeDurationSec, probeVideoDimensions } from '../drivers/probe.js';
import { cacheKey } from '../order/media.js';
import type { Shot } from '../timeline/schema.js';

/**
 * Renders a `terminal`/`screencast` shot's evidenceRange to GIF via `agg`, then transcodes to an
 * mp4 normalized to exactly `shot.durationSec`. agg's GIF frame timing is only accurate to 1/100s
 * and pads for `--last-frame-duration`, so ffmpeg — not agg — gets the final say on duration.
 *
 * A recorded terminal is usually taller than the text actually printed into it, so before
 * scaling we crop the GIF down to the region that has content, detected with ffmpeg's
 * `cropdetect` filter over the whole clip.
 */

const DEFAULT_FPS = 30;
const DEFAULT_THEME = 'monokai';
const DEFAULT_FONT_SIZE = 20;

/** How far a rendered clip's measured duration may drift from its target before we treat it as a bug. */
export const DURATION_TOLERANCE_SEC = 0.1;

/**
 * `cropdetect` black-level threshold, measured directly against agg's raw GIF output (not the
 * transcoded mp4 — h264's YUV round-trip shifts the background's measured brightness). Sweeping
 * limit=20..48 over every terminal shot in examples/self showed background (#272822) holds the
 * frame at full size through 36, opens up to the correct full-text rect at 38, and starts
 * clipping glyphs by 40. 38 is the lowest value that reliably clears the background.
 */
const CROPDETECT_LIMIT = 38;

/** Extra margin (px) added around the detected content rect so antialiased glyph edges and the cursor block never get clipped. */
const CROP_PADDING_PX = 40;

/** Below this fraction of the source frame's area, a "detection" is treated as a cropdetect failure rather than real content. */
const MIN_CROP_AREA_RATIO = 0.2;

export interface RenderShotOptions {
  castPath: string;
  outDir: string;
  fps?: number;
  theme?: string;
  fontSize?: number;
  width?: number;
}

export interface RenderedShot {
  path: string;
  durationSec: number;
}

export async function renderTerminalShot(shot: Shot, options: RenderShotOptions): Promise<RenderedShot> {
  if (!shot.evidenceRange) {
    throw new Error(`shot "${shot.id}" is kind "${shot.kind}" but has no evidenceRange — cannot render`);
  }

  const fps = options.fps ?? DEFAULT_FPS;
  const theme = options.theme ?? DEFAULT_THEME;
  const fontSize = options.fontSize ?? DEFAULT_FONT_SIZE;
  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });

  const [fromSec, toSec] = shot.evidenceRange;
  const key = cacheKey([
    shot.id,
    shot.kind,
    fromSec,
    toSec,
    shot.durationSec,
    fps,
    theme,
    fontSize,
    options.width,
    options.castPath,
  ]);
  const outPath = join(options.outDir, `${shot.id}-${key}.mp4`);
  if (existsSync(outPath)) return { path: outPath, durationSec: await probeDurationSec(outPath) };

  const gifPath = join(options.outDir, `${shot.id}-${key}-src.gif`);
  await renderCast({ castPath: options.castPath, outGifPath: gifPath, fromSec, toSec, theme, fontSize });

  try {
    const rawDurationSec = await probeDurationSec(gifPath);
    const cropRect = await detectContentCrop(gifPath);
    await transcodeNormalized(gifPath, outPath, shot.durationSec, rawDurationSec, fps, options.width, cropRect);
  } finally {
    try {
      unlinkSync(gifPath);
    } catch {
      // best-effort cleanup of the intermediate GIF; the mp4 is what matters
    }
  }

  const durationSec = await probeDurationSec(outPath);
  verifyDuration(shot.id, shot.durationSec, durationSec);
  return { path: outPath, durationSec };
}

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DetectedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Runs `cropdetect` over the whole GIF and returns the padded, clamped content rect — or
 * `undefined` when detection isn't trustworthy (nothing found, or a suspiciously small area),
 * in which case callers should render uncropped rather than risk cutting off real content.
 */
async function detectContentCrop(gifPath: string): Promise<CropRect | undefined> {
  const source = await probeVideoDimensions(gifPath);
  const { stderr } = await runFfmpegCapture([
    '-i',
    gifPath,
    '-vf',
    // skip=0: cropdetect skips 2 frames by default, but agg only emits a new GIF frame per content
    // change — a short shot can have 2 frames total, which the default skip would silently drop.
    `cropdetect=limit=${CROPDETECT_LIMIT}:round=2:reset=0:skip=0`,
    '-f',
    'null',
    '-',
  ]);
  const detected = lastDetectedRect(stderr);
  if (!detected) return undefined;
  return padAndClampCrop(detected, source, CROP_PADDING_PX);
}

/** `cropdetect` logs one `crop=W:H:X:Y` line per frame; with `reset=0` the last line is the largest rect seen across the clip. */
export function lastDetectedRect(cropdetectStderr: string): DetectedRect | undefined {
  const matches = [...cropdetectStderr.matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
  const last = matches.at(-1);
  if (!last) return undefined;
  const [, w, h, x, y] = last;
  return { w: Number(w), h: Number(h), x: Number(x), y: Number(y) };
}

export function padAndClampCrop(
  detected: DetectedRect,
  source: { width: number; height: number },
  paddingPx: number,
): CropRect | undefined {
  const sourceArea = source.width * source.height;
  if (sourceArea <= 0 || (detected.w * detected.h) / sourceArea < MIN_CROP_AREA_RATIO) return undefined;

  const x0 = Math.max(0, detected.x - paddingPx);
  const y0 = Math.max(0, detected.y - paddingPx);
  const x1 = Math.min(source.width, detected.x + detected.w + paddingPx);
  const y1 = Math.min(source.height, detected.y + detected.h + paddingPx);

  const x = roundDownToEven(x0);
  const y = roundDownToEven(y0);
  const w = roundDownToEven(x1 - x);
  const h = roundDownToEven(y1 - y);
  if (w <= 0 || h <= 0) return undefined;
  return { x, y, w, h };
}

function roundDownToEven(n: number): number {
  return n - (n % 2);
}

async function transcodeNormalized(
  inPath: string,
  outPath: string,
  targetSec: number,
  sourceSec: number,
  fps: number,
  width: number | undefined,
  cropRect: CropRect | undefined,
): Promise<void> {
  const scaleFilter = width !== undefined ? `scale=${width}:-2` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const filters = cropRect ? [`crop=${cropRect.w}:${cropRect.h}:${cropRect.x}:${cropRect.y}`, scaleFilter] : [scaleFilter];
  if (sourceSec < targetSec) {
    filters.push(`tpad=stop_mode=clone:stop_duration=${(targetSec - sourceSec).toFixed(3)}`);
  }

  await runFfmpeg([
    '-y',
    '-i',
    inPath,
    '-vf',
    filters.join(','),
    '-t',
    targetSec.toFixed(3),
    '-r',
    String(fps),
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    'libx264',
    outPath,
  ]);
}

/** Throws when a rendered clip's measured duration drifts from its target by more than {@link DURATION_TOLERANCE_SEC}. */
export function verifyDuration(shotId: string, targetSec: number, actualSec: number): void {
  if (Math.abs(actualSec - targetSec) > DURATION_TOLERANCE_SEC) {
    throw new Error(
      `shot "${shotId}" rendered to ${actualSec.toFixed(2)}s but the target was ${targetSec.toFixed(2)}s ` +
        `(>${DURATION_TOLERANCE_SEC}s off)`,
    );
  }
}
