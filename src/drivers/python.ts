import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { TrackAnalysis } from '../timeline/snap.js';

/**
 * Runs `py/analyze.py` in the project's venv to measure a rendered track (tempo, beats,
 * segments, onsets). Kept separate from `timeline/snap.ts` so that file can stay a pure
 * function of the measurement, testable without spawning Python.
 */

const execFileAsync = promisify(execFile);

const moduleDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(moduleDir, '..', '..');
const DEFAULT_VENV_PYTHON = join(repoRoot, '.venv', 'bin', 'python');
const ANALYZE_SCRIPT = join(repoRoot, 'py', 'analyze.py');
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

export interface RunAnalyzeOptions {
  /** Number of structural segments to detect. Passed through as `--segments`. */
  segments?: number;
  /** Path to the venv's Python interpreter. Defaults to `<repo>/.venv/bin/python`. */
  venvPython?: string;
}

/** Analyzes an audio file by shelling out to `py/analyze.py`. */
export async function runAnalyze(audioPath: string, options: RunAnalyzeOptions = {}): Promise<TrackAnalysis> {
  const venvPython = options.venvPython ?? DEFAULT_VENV_PYTHON;
  if (!existsSync(venvPython)) {
    throw new Error(
      `Python venv not found at ${venvPython}. Run: python3 -m venv .venv && ./.venv/bin/pip install -r py/requirements.txt`,
    );
  }

  const args = [ANALYZE_SCRIPT, audioPath];
  if (options.segments !== undefined) args.push('--segments', String(options.segments));

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(venvPython, args, { maxBuffer: MAX_STDOUT_BYTES }));
  } catch (err) {
    throw new Error(`analyze.py failed for ${audioPath}: ${errMessage(err)}`);
  }

  return parseAnalysis(stdout);
}

function parseAnalysis(stdout: string): TrackAnalysis {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`analyze.py produced invalid JSON: ${stdout.slice(0, 500)}`);
  }
  if (!isTrackAnalysis(parsed)) {
    throw new Error(`analyze.py produced an unexpected shape: ${stdout.slice(0, 500)}`);
  }
  return parsed;
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number');
}

function isTrackAnalysis(value: unknown): value is TrackAnalysis {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.durationSec === 'number' &&
    typeof v.tempo === 'number' &&
    isNumberArray(v.beats) &&
    isNumberArray(v.segments) &&
    isNumberArray(v.onsets)
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
