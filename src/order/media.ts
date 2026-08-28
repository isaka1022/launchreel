import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** Shared helpers for order/*: a stable cache key from request content, and saving a queue result to disk. */

/**
 * Sits next to the recording and is meant to be committed alongside it, so `--offline` is
 * reproducible for anyone who clones the project. Deliberately not named `.cache`: that name is
 * swept by cleanup tools and by common global gitignore rules.
 */
export const CACHE_DIR_NAME = 'launchreel-cache';

export function cacheKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

export async function downloadToFile(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download generated media: HTTP ${response.status} ${response.statusText}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}
