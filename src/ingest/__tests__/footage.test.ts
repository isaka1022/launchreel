import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { footageForSource, footageIdFromPath, loadFootage } from '../footage.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const castFixture = join(fixturesDir, 'sample.cast');
const tapeFixture = join(fixturesDir, 'sample.tape');

/** Ids come from the filename, so a set needs distinctly named copies. */
function namedCopies(names: [string, string]): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'launchreel-footage-'));
  const paths = [join(dir, names[0]), join(dir, names[1])];
  copyFileSync(castFixture, paths[0]!);
  copyFileSync(tapeFixture, paths[1]!);
  return paths;
}

describe('footageIdFromPath', () => {
  it('拡張子を落としたファイル名がidになる', () => {
    expect(footageIdFromPath('/x/y/build.cast')).toBe('build');
    expect(footageIdFromPath('setup.tape')).toBe('setup');
  });
});

describe('loadFootage', () => {
  it('.castと.tapeを混在して読み込み、それぞれのRecordingを持つ', () => {
    const items = loadFootage(namedCopies(['build.cast', 'setup.tape']));

    expect(items.map((i) => i.id)).toEqual(['build', 'setup']);
    expect(items.map((i) => i.kind)).toEqual(['cast', 'tape']);
    expect(items.every((i) => i.recording.evidence.length > 0)).toBe(true);
  });

  it('id（拡張子なしファイル名）が衝突したら読めるエラーで落ちる', () => {
    expect(() => loadFootage([castFixture, tapeFixture])).toThrow(/share the id "sample"/);
  });

  it('対応していない拡張子は読めるエラーになる', () => {
    expect(() => loadFootage(['/x/y/clip.mp4'])).toThrow(/expected a \.cast or \.tape/);
  });
});

describe('footageForSource', () => {
  it('素材が1本ならsource省略で解決し、複数あるなら省略はエラーになる', () => {
    const one = loadFootage([castFixture]);
    const two = loadFootage(namedCopies(['build.cast', 'setup.tape']));

    expect(footageForSource(one, undefined).id).toBe('sample');
    expect(() => footageForSource(two, undefined)).toThrow(/has no source/);
    expect(() => footageForSource(one, 'nope')).toThrow(/unknown footage source "nope"/);
  });
});
