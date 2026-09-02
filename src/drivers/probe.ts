import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Reads media metadata via `ffprobe`. Used to get real durations/dimensions behind synthesized clips. */

const execFileAsync = promisify(execFile);

async function runFfprobe(args: string[], path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('ffprobe', args);
    return stdout;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT')) {
      throw new Error('ffprobe not found on PATH. Install ffmpeg (brew install ffmpeg) to probe media.');
    }
    throw new Error(`ffprobe failed on ${path}: ${message}`);
  }
}

export async function probeDurationSec(path: string): Promise<number> {
  const stdout = await runFfprobe(
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    path,
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`ffprobe returned an unreadable duration for ${path}: "${stdout.trim()}"`);
  }
  return seconds;
}

/**
 * Length of one stream rather than of the container. The two differ when a filter cuts the audio
 * short, which the container duration hides because it reports the longest stream.
 */
export async function probeStreamDurationSec(path: string, stream: 'v:0' | 'a:0'): Promise<number> {
  const stdout = await runFfprobe(
    ['-v', 'error', '-select_streams', stream, '-show_entries', 'stream=duration', '-of', 'default=noprint_wrappers=1:nokey=1', path],
    path,
  );
  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`ffprobe returned an unreadable ${stream} duration for ${path}: "${stdout.trim()}"`);
  }
  return seconds;
}

export interface VideoDimensions {
  width: number;
  height: number;
}

export async function probeVideoDimensions(path: string): Promise<VideoDimensions> {
  const stdout = await runFfprobe(
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', path],
    path,
  );
  const [widthStr, heightStr] = stdout.trim().split('x');
  const width = Number(widthStr);
  const height = Number(heightStr);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`ffprobe returned unreadable dimensions for ${path}: "${stdout.trim()}"`);
  }
  return { width, height };
}
