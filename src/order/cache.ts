import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Generated assets are cached under a key derived from the request that produced them, so redesigning
 * a plan does not overwrite the old assets — it writes new ones alongside. Nothing reads the old files
 * again, but they still ship to everyone who clones the repo. These helpers name the files an
 * `--offline` rebuild actually reads, so the rest can be dropped.
 */

/** The suffix `score` writes next to each candidate track once librosa has measured it. */
const ANALYSIS_SUFFIX = '.analysis.json';

export interface CacheDependencies {
  /** The plan fixture the design was read from. Absent when the build ran without a cache dir. */
  planPath?: string;
  /** One per narration line, including lines that were re-synthesized after a rewrite. */
  narrationPaths: string[];
  /** Every candidate, not just the selected one — `score` measures all of them on an offline replay. */
  musicPaths: string[];
}

/**
 * Absolute paths an `--offline` rebuild reads, each candidate track paired with the analysis sidecar
 * that lets the replay skip Python.
 */
export function collectCacheDependencies(deps: CacheDependencies): string[] {
  const paths = new Set<string>();
  if (deps.planPath !== undefined) paths.add(resolve(deps.planPath));
  for (const path of deps.narrationPaths) paths.add(resolve(path));
  for (const path of deps.musicPaths) {
    paths.add(resolve(path));
    paths.add(resolve(`${path}${ANALYSIS_SUFFIX}`));
  }
  return [...paths].sort();
}

export interface PruneResult {
  /** Paths that were removed, or that would be removed under `dryRun`. */
  removed: string[];
  removedBytes: number;
  keptBytes: number;
}

/**
 * Removes every file under `cacheDir` that `keep` does not name. Returns what it touched rather than
 * printing, so the caller decides how to report it and `dryRun` can share one code path with the real
 * thing.
 */
export function pruneCacheDir(cacheDir: string, keep: string[], options: { dryRun?: boolean } = {}): PruneResult {
  const kept = new Set(keep.map((path) => resolve(path)));
  const removed: string[] = [];
  let removedBytes = 0;
  let keptBytes = 0;

  for (const path of listFiles(resolve(cacheDir))) {
    const bytes = statSync(path).size;
    if (kept.has(path)) {
      keptBytes += bytes;
      continue;
    }
    removed.push(path);
    removedBytes += bytes;
    if (options.dryRun !== true) rmSync(path);
  }

  return { removed: removed.sort(), removedBytes, keptBytes };
}

function listFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listFiles(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}
