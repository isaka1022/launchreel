import { describe, expect, it } from 'vitest';
import { activeSec, activeSpans, pauseSpans } from '../activity.js';
import type { Recording } from '../types.js';

function recordingOf(durationSec: number, pauses: [number, number][]): Recording {
  return {
    source: 'cast',
    durationSec,
    evidence: [
      { t: 0, kind: 'command', text: 'npm run build' },
      ...pauses.map(([t, span]) => ({ t, kind: 'pause' as const, text: 'pause', durationSec: span })),
    ],
  };
}

describe('pauseSpans', () => {
  it('durationSecを持つpauseだけを区間に変換し、録画の終端で切る', () => {
    expect(pauseSpans(recordingOf(10, [[2, 3]]))).toEqual([{ startSec: 2, endSec: 5 }]);
    expect(pauseSpans(recordingOf(10, [[8, 5]]))).toEqual([{ startSec: 8, endSec: 10 }]);
  });

  it('重なった区間をまとめ、時刻順に返す', () => {
    expect(
      pauseSpans(
        recordingOf(20, [
          [10, 3],
          [2, 3],
          [4, 4],
        ]),
      ),
    ).toEqual([
      { startSec: 2, endSec: 8 },
      { startSec: 10, endSec: 13 },
    ]);
  });
});

describe('activeSpans', () => {
  it('無音区間の補集合を返す', () => {
    expect(
      activeSpans(
        recordingOf(20, [
          [2, 3],
          [10, 3],
        ]),
      ),
    ).toEqual([
      { startSec: 0, endSec: 2 },
      { startSec: 5, endSec: 10 },
      { startSec: 13, endSec: 20 },
    ]);
  });

  it('最小長に満たない隙間は落とす', () => {
    // 動いているのは 0-0.1s と 3.1-3.2s だけで、どちらも 0.3s 未満
    expect(
      activeSpans(
        recordingOf(10, [
          [0.1, 3],
          [3.2, 6.8],
        ]),
      ),
    ).toEqual([]);
  });

  it('全編が無音なら区間なし、無音がなければ全編', () => {
    expect(activeSpans(recordingOf(10, [[0, 10]]))).toEqual([]);
    expect(activeSpans(recordingOf(10, []))).toEqual([{ startSec: 0, endSec: 10 }]);
  });
});

describe('activeSec', () => {
  it('画面が動いている秒数だけを合計する', () => {
    expect(
      activeSec(
        recordingOf(20, [
          [2, 3],
          [10, 3],
        ]),
      ),
    ).toBeCloseTo(2 + 5 + 7, 6);
  });
});
