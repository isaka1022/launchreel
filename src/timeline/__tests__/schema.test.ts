import { describe, expect, it } from 'vitest';
import {
  footageSecByShot,
  holdWarnings,
  sourceCoverage,
  MIN_SHOT_SPEED,
  reelUsage,
  validateAgainstFootage,
  validateReel,
  type Reel,
  type Shot,
} from '../schema.js';

function reelOf(shots: Shot[]): Reel {
  return { version: 'launchreel/1', title: 'Fixture', fps: 30, shots, narration: [], hitPoints: [] };
}

describe('footageSecByShot', () => {
  it('speedで利用可能な尺が変わる（0.5で倍、2.0で半分、未指定は等倍）', () => {
    const available = footageSecByShot(
      reelOf([
        { id: 'plain', kind: 'terminal', durationSec: 4, label: 'plain', evidenceRange: [0, 4] },
        { id: 'slow', kind: 'terminal', durationSec: 8, label: 'slow', evidenceRange: [0, 4], speed: 0.5 },
        { id: 'fast', kind: 'terminal', durationSec: 2, label: 'fast', evidenceRange: [0, 4], speed: 2 },
        { id: 'card', kind: 'card', durationSec: 2, label: 'card', card: { title: 'C' } },
      ]),
    );

    expect(available.get('plain')).toBe(4);
    expect(available.get('slow')).toBe(8);
    expect(available.get('fast')).toBe(2);
    expect(available.has('card')).toBe(false);
  });

  it('holdWarningsもspeedを反映し、引き伸ばせば静止フレーム警告が消える', () => {
    const shot: Shot = { id: 's', kind: 'terminal', durationSec: 8, label: 's', evidenceRange: [0, 3] };
    expect(holdWarnings(reelOf([shot]))).toHaveLength(1);
    expect(holdWarnings(reelOf([{ ...shot, speed: MIN_SHOT_SPEED }]))).toHaveLength(0);
  });
});

describe('validateReel', () => {
  it('カードに再生用フィールドを付けると、再生されないと1件でまとめて指摘する', () => {
    const problems = validateReel(
      reelOf([
        {
          id: 'c',
          kind: 'card',
          durationSec: 2,
          label: 'c',
          card: { title: 'C' },
          source: 'build',
          evidenceRange: [0, 1],
          speed: 0.8,
        },
      ]),
    );
    expect(problems).toEqual(['shot "c" is kind "card" but sets evidenceRange, source, speed — none of it is ever played']);
  });

  it('映像ショットがevidenceRangeなしでsource/speedを持つと構造エラーになる', () => {
    const problems = validateReel(
      reelOf([{ id: 't', kind: 'terminal', durationSec: 2, label: 't', source: 'build', speed: 0.8 }]),
    );

    expect(problems).toHaveLength(3);
    expect(problems.join('\n')).toContain('has no evidenceRange');
    expect(problems.join('\n')).toContain('names a source');
    expect(problems.join('\n')).toContain('sets a speed');
  });
});

describe('validateAgainstFootage', () => {
  const shot = (id: string, source: string | undefined, range: [number, number]): Shot => ({
    id,
    kind: 'terminal',
    durationSec: 2,
    label: id,
    ...(source !== undefined ? { source } : {}),
    evidenceRange: range,
  });

  it('未知のsourceと素材尺の超過を報告する', () => {
    const problems = validateAgainstFootage(
      reelOf([shot('a', 'build', [0, 5]), shot('b', 'nope', [0, 1]), shot('c', 'setup', [0, 99])]),
      new Map([
        ['build', 20],
        ['setup', 10],
      ]),
    );

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('unknown source "nope"');
    expect(problems[1]).toContain('only 10.00s long');
  });

  it('素材が1本ならsource省略を許す（後方互換）が、複数あるなら必須になる', () => {
    const reel = reelOf([shot('a', undefined, [0, 5])]);

    expect(validateAgainstFootage(reel, new Map([['demo', 20]]))).toEqual([]);
    expect(
      validateAgainstFootage(
        reel,
        new Map([
          ['demo', 20],
          ['other', 20],
        ]),
      )[0],
    ).toContain('has no source');
  });
});

describe('reelUsage', () => {
  it('素材ごとの画面尺・消費尺とカード尺を集計する', () => {
    const usage = reelUsage(
      reelOf([
        { id: 's1', kind: 'terminal', durationSec: 8, label: 's1', source: 'build', evidenceRange: [0, 4], speed: 0.5 },
        { id: 's2', kind: 'terminal', durationSec: 3, label: 's2', source: 'build', evidenceRange: [4, 7] },
        { id: 's3', kind: 'card', durationSec: 5, label: 's3', card: { title: 'C' } },
      ]),
    );

    expect(usage.bySource).toEqual([{ source: 'build', shots: 2, screenSec: 11, footageSec: 7 }]);
    expect(usage.cardSec).toBe(5);
    expect(usage.totalSec).toBe(16);
  });
});

describe('sourceCoverage', () => {
  it('同じ場面を使い回しても素材の消費は二重に数えず、重なった範囲は結合する', () => {
    const coverage = sourceCoverage(
      reelOf([
        { id: 'a', kind: 'terminal', durationSec: 2, label: 'a', source: 'build', evidenceRange: [0, 4] },
        { id: 'b', kind: 'terminal', durationSec: 2, label: 'b', source: 'build', evidenceRange: [0, 4] },
        { id: 'c', kind: 'terminal', durationSec: 2, label: 'c', source: 'build', evidenceRange: [3, 6] },
        { id: 'd', kind: 'terminal', durationSec: 2, label: 'd', source: 'setup', evidenceRange: [1, 2] },
      ]),
      new Map([
        ['build', 16],
        ['setup', 20],
      ]),
    );

    expect(coverage).toEqual([
      { source: 'build', usedSec: 6, availableSec: 16 },
      { source: 'setup', usedSec: 1, availableSec: 20 },
    ]);
  });
});
