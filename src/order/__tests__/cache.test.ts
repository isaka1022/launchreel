import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectCacheDependencies, pruneCacheDir } from '../cache.js';

describe('collectCacheDependencies', () => {
  it('候補トラックには解析サイドカーを対にし、選ばれなかった候補も残す', () => {
    const files = collectCacheDependencies({
      planPath: 'cache/plan-abc.json',
      narrationPaths: ['cache/vo/n1-aaa.mp3', 'cache/vo/n1-aaa.mp3'],
      musicPaths: ['cache/music/track-0-x.mp3', 'cache/music/track-1-y.mp3'],
    });

    expect(files).toEqual(
      [
        resolve('cache/plan-abc.json'),
        resolve('cache/vo/n1-aaa.mp3'),
        resolve('cache/music/track-0-x.mp3'),
        resolve('cache/music/track-0-x.mp3.analysis.json'),
        resolve('cache/music/track-1-y.mp3'),
        resolve('cache/music/track-1-y.mp3.analysis.json'),
      ].sort(),
    );
  });
});

describe('pruneCacheDir', () => {
  it('残すべきファイルだけを残し、--dry-runでは何も消さない', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchreel-prune-test-'));
    mkdirSync(join(dir, 'vo'));
    writeFileSync(join(dir, 'vo', 'keep.mp3'), 'aa');
    writeFileSync(join(dir, 'vo', 'orphan.mp3'), 'bbbb');
    const keep = [join(dir, 'vo', 'keep.mp3')];

    const dry = pruneCacheDir(dir, keep, { dryRun: true });
    expect(dry.removed).toEqual([join(dir, 'vo', 'orphan.mp3')]);
    expect(dry.removedBytes).toBe(4);
    expect(dry.keptBytes).toBe(2);
    expect(readdirSync(join(dir, 'vo')).sort()).toEqual(['keep.mp3', 'orphan.mp3']);

    const real = pruneCacheDir(dir, keep, {});
    expect(real.removed).toEqual([join(dir, 'vo', 'orphan.mp3')]);
    expect(readdirSync(join(dir, 'vo'))).toEqual(['keep.mp3']);
  });
});
