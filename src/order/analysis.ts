import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runAnalyze } from '../drivers/python.js';
import type { TrackAnalysis } from '../timeline/snap.js';

/**
 * Beat analysis is deterministic for a given audio file, so it is cached next to the track.
 * That keeps librosa off the `--offline` path entirely: replaying a build needs no Python.
 */
export async function analyzeTrack(trackPath: string, offline: boolean): Promise<TrackAnalysis> {
  const cachePath = `${trackPath}.analysis.json`;
  if (existsSync(cachePath)) {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as TrackAnalysis;
  }
  if (offline) {
    throw new Error(
      `--offline: no cached beat analysis at ${cachePath}. Run once without --offline to populate it.`,
    );
  }
  const analysis = await runAnalyze(trackPath);
  writeFileSync(cachePath, `${JSON.stringify(analysis, null, 2)}\n`);
  return analysis;
}
