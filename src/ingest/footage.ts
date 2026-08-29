import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { parseCast } from './cast.js';
import { parseTape } from './tape.js';
import type { Recording } from './types.js';

/**
 * A named set of recordings, so a shot's `evidenceRange` can say *which* recording it reads.
 * Ids are the filenames without their extension — the same string a person types on the command
 * line and the same one the model sees in the prompt.
 */

export type FootageKind = 'cast' | 'tape';

export interface FootageItem {
  id: string;
  path: string;
  kind: FootageKind;
  recording: Recording;
}

const EXTENSIONS: Record<string, FootageKind> = { '.cast': 'cast', '.tape': 'tape' };

export function footageIdFromPath(path: string): string {
  return basename(path, extname(path));
}

export function footageKindFromPath(path: string): FootageKind | undefined {
  return EXTENSIONS[extname(path).toLowerCase()];
}

/** Sorted so a directory listing gives the same reel on every machine. */
export function listFootageFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => footageKindFromPath(entry) !== undefined)
    .sort()
    .map((entry) => join(dir, entry));
}

export function loadFootage(paths: string[]): FootageItem[] {
  if (paths.length === 0) throw new Error('no footage given — pass at least one .cast or .tape file');

  const items: FootageItem[] = [];
  const seen = new Map<string, string>();
  for (const path of paths) {
    const kind = footageKindFromPath(path);
    if (kind === undefined) {
      throw new Error(`unsupported footage "${path}": expected a .cast or .tape file`);
    }
    const id = footageIdFromPath(path);
    const previous = seen.get(id);
    if (previous !== undefined) {
      throw new Error(`two footage files share the id "${id}": ${previous} and ${path}. Rename one of them.`);
    }
    seen.set(id, path);

    const content = readFileSync(path, 'utf8');
    items.push({ id, path, kind, recording: kind === 'cast' ? parseCast(content) : parseTape(content) });
  }
  return items;
}

export function footageDurations(items: FootageItem[]): Map<string, number> {
  return new Map(items.map((item) => [item.id, item.recording.durationSec]));
}

export function findFootage(items: FootageItem[], id: string): FootageItem | undefined {
  return items.find((item) => item.id === id);
}

/** Resolves the footage a shot reads: its named `source`, or the only item when the set has one. */
export function footageForSource(items: FootageItem[], source: string | undefined): FootageItem {
  if (source === undefined) {
    const sole = items.length === 1 ? items[0] : undefined;
    if (sole === undefined) {
      throw new Error(`a shot has no source but the footage set has ${items.length} items: ${items.map((i) => i.id).join(', ')}`);
    }
    return sole;
  }
  const found = findFootage(items, source);
  if (found === undefined) {
    throw new Error(`unknown footage source "${source}" — known sources: ${items.map((i) => i.id).join(', ')}`);
  }
  return found;
}

/** True when `dir` is the long-form shape: a pitch document next to a directory of footage. */
export function isLongFormProject(dir: string, pitchFile: string, footageDir: string): boolean {
  try {
    return statSync(join(dir, pitchFile)).isFile() && statSync(join(dir, footageDir)).isDirectory();
  } catch {
    return false;
  }
}
