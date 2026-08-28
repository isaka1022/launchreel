import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Runs the `ffmpeg` binary directly. `ffprobe` reads go through the existing `probe.ts`. */

const execFileAsync = promisify(execFile);
const MAX_BUFFER_BYTES = 20 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2000;

export interface RunFfmpegOptions {
  timeoutMs?: number;
}

export interface RunFfmpegResult {
  stderr: string;
}

export async function runFfmpeg(args: string[], options: RunFfmpegOptions = {}): Promise<void> {
  await runFfmpegCapture(args, options);
}

/** Same as {@link runFfmpeg} but also returns stderr — needed to read loudnorm's analysis-pass JSON. */
export async function runFfmpegCapture(args: string[], options: RunFfmpegOptions = {}): Promise<RunFfmpegResult> {
  try {
    const { stderr } = await execFileAsync('ffmpeg', args, { maxBuffer: MAX_BUFFER_BYTES, timeout: options.timeoutMs });
    return { stderr };
  } catch (err) {
    throw new Error(ffmpegErrorMessage(err));
  }
}

let cachedFilters: Set<string> | undefined;

/** Names of filters this ffmpeg build supports, from `ffmpeg -filters`. Cached for the process lifetime. */
export async function listFfmpegFilters(): Promise<Set<string>> {
  if (cachedFilters) return cachedFilters;
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-filters'], { maxBuffer: MAX_BUFFER_BYTES }));
  } catch (err) {
    throw new Error(ffmpegErrorMessage(err));
  }
  const filters = new Set<string>();
  for (const line of stdout.split('\n')) {
    // Each filter line has a "IN->OUT" type signature (e.g. "AA->A"); the token right before it is the name.
    const tokens = line.trim().split(/\s+/);
    const sigIndex = tokens.findIndex((t) => /^[A-Za-z|]*->[A-Za-z|]*$/.test(t));
    if (sigIndex > 0) filters.add(tokens[sigIndex - 1]!);
  }
  cachedFilters = filters;
  return filters;
}

function ffmpegErrorMessage(err: unknown): string {
  if (isErrnoException(err) && err.code === 'ENOENT') {
    return 'ffmpeg not found on PATH. Install it with: brew install ffmpeg';
  }
  const message = err instanceof Error ? err.message : String(err);
  const stderr = hasStderr(err) ? err.stderr.trim() : '';
  const tail = stderr.slice(-STDERR_TAIL_CHARS);
  return tail.length > 0 ? `ffmpeg failed: ${message}\n${tail}` : `ffmpeg failed: ${message}`;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function hasStderr(err: unknown): err is { stderr: string } {
  return typeof err === 'object' && err !== null && 'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string';
}
