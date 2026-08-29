import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Runs `agg` (asciicast -> GIF) directly. Its GIF frame timing is coarse; callers normalize duration downstream. */

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;

/**
 * agg squeezes any idle gap longer than `--idle-time-limit` (default 5s), which silently moves
 * every later frame off the timestamps `ingest` reported. Raising it past any plausible gap keeps
 * agg's clock equal to the recording's own, which is what an `evidenceRange` is measured in.
 */
const IDLE_TIME_LIMIT_SEC = 86_400;

export interface RenderCastOptions {
  castPath: string;
  outGifPath: string;
  /** Both bounds are seconds in agg's output timeline, i.e. already divided by `speed`. */
  fromSec?: number;
  toSec?: number;
  /** Playback rate; agg divides every frame timestamp by it. */
  speed?: number;
  theme?: string;
  fontSize?: number;
  cols?: number;
  rows?: number;
}

export async function renderCast(options: RenderCastOptions): Promise<void> {
  const args: string[] = [];
  if (options.fromSec !== undefined && options.toSec !== undefined) {
    args.push('--select', `${options.fromSec}..${options.toSec}`);
  } else if (options.fromSec !== undefined) {
    args.push('--select', `${options.fromSec}..`);
  } else if (options.toSec !== undefined) {
    args.push('--select', `..${options.toSec}`);
  }

  // The GIF's own last-frame-duration would otherwise pad the clip by 3s (agg's default).
  args.push('--last-frame-duration', '0');
  args.push('--idle-time-limit', String(IDLE_TIME_LIMIT_SEC));
  if (options.speed !== undefined) args.push('--speed', String(options.speed));
  if (options.theme !== undefined) args.push('--theme', options.theme);
  if (options.fontSize !== undefined) args.push('--font-size', String(options.fontSize));
  if (options.cols !== undefined) args.push('--cols', String(options.cols));
  if (options.rows !== undefined) args.push('--rows', String(options.rows));
  args.push(options.castPath, options.outGifPath);

  try {
    await execFileAsync('agg', args, { maxBuffer: MAX_BUFFER_BYTES });
  } catch (err) {
    throw new Error(aggErrorMessage(err));
  }
}

function aggErrorMessage(err: unknown): string {
  if (isErrnoException(err) && err.code === 'ENOENT') {
    return 'agg not found on PATH. Install it with: brew install agg';
  }
  const message = err instanceof Error ? err.message : String(err);
  const stderr = hasStderr(err) ? err.stderr.trim() : '';
  return stderr.length > 0 ? `agg failed: ${message}\n${stderr}` : `agg failed: ${message}`;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function hasStderr(err: unknown): err is { stderr: string } {
  return typeof err === 'object' && err !== null && 'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string';
}
