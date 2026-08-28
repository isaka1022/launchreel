import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Rasterizes an SVG to PNG via `rsvg-convert`. `card.ts` uses this instead of ffmpeg's drawtext
 * because this machine's ffmpeg build has no drawtext filter (verified: `ffmpeg -filters` lists
 * none, the build has no libfreetype) — text is laid out in SVG and composited with ffmpeg instead.
 */

const execFileAsync = promisify(execFile);

export interface RenderSvgOptions {
  svgPath: string;
  outPngPath: string;
}

export async function renderSvg(options: RenderSvgOptions): Promise<void> {
  try {
    await execFileAsync('rsvg-convert', ['-o', options.outPngPath, options.svgPath]);
  } catch (err) {
    throw new Error(rsvgErrorMessage(err));
  }
}

function rsvgErrorMessage(err: unknown): string {
  if (isErrnoException(err) && err.code === 'ENOENT') {
    return 'rsvg-convert not found on PATH. Install it with: brew install librsvg';
  }
  const message = err instanceof Error ? err.message : String(err);
  const stderr = hasStderr(err) ? err.stderr.trim() : '';
  return stderr.length > 0 ? `rsvg-convert failed: ${message}\n${stderr}` : `rsvg-convert failed: ${message}`;
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function hasStderr(err: unknown): err is { stderr: string } {
  return typeof err === 'object' && err !== null && 'stderr' in err && typeof (err as { stderr: unknown }).stderr === 'string';
}
