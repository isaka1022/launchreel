import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runFfmpeg } from '../drivers/ffmpeg.js';
import { probeDurationSec } from '../drivers/probe.js';
import { cacheKey } from '../order/media.js';
import type { Reel, Shot } from '../timeline/schema.js';
import { renderCard } from './card.js';
import { renderTerminalShot, verifyDuration, type RenderedShot } from './terminal.js';

/** Renders every shot in a Reel to mp4, dispatching by `kind`. See terminal.ts and card.ts for the per-kind renderers. */

const DEFAULT_FPS = 30;

export interface RenderOptions {
  castPath?: string;
  outDir: string;
  fps?: number;
  onProgress?: (shotId: string, index: number, total: number) => void;
}

export async function renderShots(reel: Reel, options: RenderOptions): Promise<Map<string, RenderedShot>> {
  const fps = options.fps ?? DEFAULT_FPS;
  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });

  const results = new Map<string, RenderedShot>();
  const total = reel.shots.length;
  for (let i = 0; i < total; i++) {
    const shot = reel.shots[i]!;
    const rendered = await renderShot(shot, options.outDir, fps, options.castPath);
    results.set(shot.id, rendered);
    options.onProgress?.(shot.id, i + 1, total);
  }
  return results;
}

async function renderShot(shot: Shot, outDir: string, fps: number, castPath: string | undefined): Promise<RenderedShot> {
  if (shot.kind === 'terminal' || shot.kind === 'screencast') {
    if (castPath === undefined) {
      throw new Error(`shot "${shot.id}" is kind "${shot.kind}" and needs a source recording, but no castPath was given`);
    }
    return renderTerminalShot(shot, { castPath, outDir, fps });
  }
  if (shot.kind === 'card') return renderCard(shot, { outDir, fps });
  if (shot.kind === 'still') return renderStillShot(shot, outDir, fps);

  throw new Error(
    `shot "${shot.id}" is kind "generated" — generated video shots need a paid model and are not supported by this renderer`,
  );
}

async function renderStillShot(shot: Shot, outDir: string, fps: number): Promise<RenderedShot> {
  if (!shot.imagePath) throw new Error(`shot "${shot.id}" is kind "still" but has no imagePath`);
  if (!existsSync(shot.imagePath)) {
    throw new Error(`shot "${shot.id}" references imagePath "${shot.imagePath}" which does not exist`);
  }

  const key = cacheKey([shot.id, shot.kind, shot.imagePath, shot.durationSec, fps]);
  const outPath = join(outDir, `${shot.id}-${key}.mp4`);
  if (existsSync(outPath)) return { path: outPath, durationSec: await probeDurationSec(outPath) };

  await runFfmpeg([
    '-y',
    '-loop',
    '1',
    '-i',
    shot.imagePath,
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

  const durationSec = await probeDurationSec(outPath);
  verifyDuration(shot.id, shot.durationSec, durationSec);
  return { path: outPath, durationSec };
}
