import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

/** Shared helpers for order/*: a stable cache key from request content, and saving a queue result to disk. */

export function cacheKey(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 12);
}

export async function downloadToFile(url: string, path: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`failed to download generated media: HTTP ${response.status} ${response.statusText}`);
  writeFileSync(path, Buffer.from(await response.arrayBuffer()));
}
