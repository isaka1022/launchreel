import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { renderCast } from '../drivers/agg.js';
import { runFfmpeg } from '../drivers/ffmpeg.js';
import { probeDurationSec } from '../drivers/probe.js';
import { cacheKey } from '../order/media.js';
import type { Shot } from '../timeline/schema.js';

/**
 * Renders a `terminal`/`screencast` shot's evidenceRange to GIF via `agg`, then transcodes to an
 * mp4 normalized to exactly `shot.durationSec`. agg's GIF frame timing is only accurate to 1/100s
 * and pads for `--last-frame-duration`, so ffmpeg — not agg — gets the final say on duration.
 */

const DEFAULT_FPS = 30;
const DEFAULT_THEME = 'monokai';
const DEFAULT_FONT_SIZE = 20;

/** How far a rendered clip's measured duration may drift from its target before we treat it as a bug. */
export const DURATION_TOLERANCE_SEC = 0.1;

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
    await transcodeNormalized(gifPath, outPath, shot.durationSec, rawDurationSec, fps, options.width);
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

async function transcodeNormalized(
  inPath: string,
  outPath: string,
  targetSec: number,
  sourceSec: number,
  fps: number,
  width: number | undefined,
): Promise<void> {
  const scaleFilter = width !== undefined ? `scale=${width}:-2` : 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const filters = [scaleFilter];
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
