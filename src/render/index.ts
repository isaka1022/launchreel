import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { runFfmpeg } from '../drivers/ffmpeg.js';
import { probeDurationSec } from '../drivers/probe.js';
import { parseCast } from '../ingest/cast.js';
import { parseTape } from '../ingest/tape.js';
import { cacheKey } from '../order/media.js';
import type { Reel, Shot } from '../timeline/schema.js';
import { renderCard } from './card.js';
import { renderTerminalShot, verifyDuration, type RenderedShot } from './terminal.js';

/** Renders every shot in a Reel to mp4, dispatching by `kind`. See terminal.ts and card.ts for the per-kind renderers. */

const DEFAULT_FPS = 30;

/** One entry per footage id, for reels whose shots read from more than one recording. */
export type SourceMap = Map<string, { path: string; durationSec: number }>;

export interface RenderOptions {
  castPath?: string;
  /** Takes precedence over `castPath`; a shot's `source` picks the entry, or the sole entry when it has none. */
  sources?: SourceMap;
  outDir: string;
  fps?: number;
  onProgress?: (shotId: string, index: number, total: number) => void;
}

export async function renderShots(reel: Reel, options: RenderOptions): Promise<Map<string, RenderedShot>> {
  const fps = options.fps ?? DEFAULT_FPS;
  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });

  const sources = options.sources ?? singletonSource(options.castPath);

  const results = new Map<string, RenderedShot>();
  const total = reel.shots.length;
  for (let i = 0; i < total; i++) {
    const original = reel.shots[i]!;
    const source = original.evidenceRange ? resolveSource(original, sources) : undefined;
    const shot = source !== undefined ? clampEvidenceRangeToRecording(original, source.durationSec) : original;
    const rendered = await renderShot(shot, options.outDir, fps, source?.path);
    results.set(shot.id, rendered);
    options.onProgress?.(shot.id, i + 1, total);
  }
  return results;
}

/** A `castPath` with no readable duration still renders — the clamp is skipped and `agg` reports any real problem. */
function singletonSource(castPath: string | undefined): SourceMap {
  if (castPath === undefined) return new Map();
  return new Map([[castPath, { path: castPath, durationSec: loadRecordingDurationSec(castPath) ?? Infinity }]]);
}

function resolveSource(shot: Shot, sources: SourceMap): { path: string; durationSec: number } | undefined {
  if (sources.size === 0) return undefined;
  if (shot.source === undefined) {
    if (sources.size === 1) return [...sources.values()][0];
    throw new Error(
      `shot "${shot.id}" has an evidenceRange but no source, and the footage set has ${sources.size} recordings: ` +
        `${[...sources.keys()].join(', ')}`,
    );
  }
  const found = sources.get(shot.source);
  if (found === undefined) {
    throw new Error(`shot "${shot.id}" reads from unknown source "${shot.source}" — known sources: ${[...sources.keys()].join(', ')}`);
  }
  return found;
}

/**
 * Reads the source recording once so evidenceRange ends can be clamped to what it actually
 * covers — a plan can ask for a range whose end sits fractionally past the last real frame (see
 * cast.ts), which `agg --select` rejects outright. Read failures are logged and otherwise
 * ignored; the shot then renders unclamped and any real problem surfaces from `agg` itself.
 */
function loadRecordingDurationSec(castPath: string): number | undefined {
  try {
    const ext = extname(castPath).toLowerCase();
    const content = readFileSync(castPath, 'utf8');
    if (ext === '.cast') return parseCast(content).durationSec;
    if (ext === '.tape') return parseTape(content).durationSec;
    const parsed: unknown = JSON.parse(content);
    const durationSec = (parsed as { durationSec?: unknown } | null)?.durationSec;
    return typeof durationSec === 'number' ? durationSec : undefined;
  } catch (err) {
    console.error(`render: could not read recording duration from "${castPath}" for range clamping (${errMessage(err)})`);
    return undefined;
  }
}

/**
 * Clamps a shot's evidenceRange end down to the recording's actual duration. Left alone (not
 * thrown) when the clamp would collapse or invert the range — that's a real planning bug, not
 * clock drift, and should fail loudly from the renderer instead of being silently patched here.
 */
export function clampEvidenceRangeToRecording(shot: Shot, recordingDurationSec: number): Shot {
  if (!shot.evidenceRange) return shot;
  const [fromSec, toSec] = shot.evidenceRange;
  if (toSec <= recordingDurationSec || recordingDurationSec <= fromSec) return shot;

  console.error(
    `render: shot "${shot.id}" evidenceRange end ${toSec.toFixed(3)}s is beyond the recording (${recordingDurationSec.toFixed(3)}s); clamped to ${recordingDurationSec.toFixed(3)}s`,
  );
  return { ...shot, evidenceRange: [fromSec, recordingDurationSec] };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
