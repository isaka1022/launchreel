import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Measures a media file's duration via `ffprobe`. Used to get the real seconds behind a synthesized clip. */

const execFileAsync = promisify(execFile);

export async function probeDurationSec(path: string): Promise<number> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      path,
    ]));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT')) {
      throw new Error('ffprobe not found on PATH. Install ffmpeg (brew install ffmpeg) to probe media duration.');
    }
    throw new Error(`ffprobe failed on ${path}: ${message}`);
  }

  const seconds = Number(stdout.trim());
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`ffprobe returned an unreadable duration for ${path}: "${stdout.trim()}"`);
  }
  return seconds;
}
