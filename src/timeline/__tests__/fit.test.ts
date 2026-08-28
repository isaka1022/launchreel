import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compressToFit, fitReel, type FitReport } from '../fit.js';
import { reelSchema, totalDurationSec, type Reel } from '../schema.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'examples', 'vhs-demo');

function buildReel(): Reel {
  return {
    version: 'launchreel/1',
    title: 'Fixture',
    fps: 30,
    shots: [
      { id: 's1', kind: 'card', durationSec: 3, label: 'S1', card: { title: 'S1' } },
      { id: 's2', kind: 'card', durationSec: 2, label: 'S2', card: { title: 'S2' } },
      { id: 's3', kind: 'card', durationSec: 2, label: 'S3', card: { title: 'S3' } },
      { id: 's4', kind: 'card', durationSec: 4, label: 'S4', card: { title: 'S4' } },
    ],
    narration: [
      { id: 'l1', shotId: 's1', text: 'short line' },
      { id: 'l2', shotId: 's2', text: 'longer line needing extension' },
      { id: 'l3', shotId: 's3', text: 'line requiring a full rewrite' },
    ],
    hitPoints: [5, 9],
  };
}

const fitOptions = {
  measured: new Map([
    ['l1', 1.0],
    ['l2', 3.0],
    ['l3', 50],
  ]),
  maxShotSec: 10,
};

describe('fitReel', () => {
  it('ショットごとにfits/extended/needs-rewriteが正しく発火する', () => {
    const { report } = fitReel(buildReel(), fitOptions);
    const byShotId = new Map(report.shots.map((s) => [s.shotId, s]));

    expect(byShotId.get('s1')?.durationSec).toBe(3); // fits: 収まるので据え置き
    expect(byShotId.get('s2')?.durationSec).toBeCloseTo(3.6, 5); // extended: neededまで伸びる
    expect(byShotId.get('s3')?.durationSec).toBe(10); // needs-rewrite: maxShotSecで頭打ち
    expect(byShotId.get('s4')?.durationSec).toBe(4); // ナレーション無しは無変更

    const l1 = report.lines.find((l) => l.lineId === 'l1');
    const l2 = report.lines.find((l) => l.lineId === 'l2');
    const l3 = report.lines.find((l) => l.lineId === 'l3');
    expect(l1?.tier).toBe('fits');
    expect(l2?.tier).toBe('extended');
    expect(l3?.tier).toBe('needs-rewrite');
    expect(l3?.rewriteBudgetChars).toBe(131); // (10 - 0.3*2) * 14 chars/sec を切り捨て
    expect(report.needsRewrite).toBe(true);
  });

  it('hitPointsがショット尺の変更に追随する', () => {
    const { reel } = fitReel(buildReel(), fitOptions);

    // hit=5は元タイムラインでs3の開始位置 → 新しいs3の開始位置(6.6)にスナップする
    expect(reel.hitPoints[0]).toBeCloseTo(6.6, 5);
    // hit=9は元タイムラインでs4の50%地点 → 新しいs4区間([16.6, 20.6])の50%地点(18.6)に追随する
    expect(reel.hitPoints[1]).toBeCloseTo(18.6, 5);
  });

  it('入力のReelを変更しない', () => {
    const reel = buildReel();
    const before = JSON.stringify(reel);

    const { reel: fitted } = fitReel(reel, fitOptions);

    expect(JSON.stringify(reel)).toBe(before);
    expect(fitted).not.toBe(reel);
    expect(fitted.shots).not.toBe(reel.shots);
  });

  it('実際のexamples/vhs-demo/reel.jsonでナレーションの超過が解消される', () => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, 'reel.json'), 'utf8'));
    const reel = reelSchema.parse(raw);
    const originalTotal = totalDurationSec(reel);

    const { report } = fitReel(reel);

    expect(report.needsRewrite).toBe(false);
    expect(report.lines.every((l) => l.tier !== 'needs-rewrite')).toBe(true);
    // 元は33秒だったショット尺が、超過していたナレーションを収めるために伸びている
    expect(report.totalDurationSec).toBeGreaterThan(originalTotal);

    const closingShot = report.shots.find((s) => s.shotId === 's05_close');
    expect(closingShot?.durationSec).toBeGreaterThan(closingShot?.originalDurationSec ?? 0);
  });
});

describe('compressToFit', () => {
  function buildNeedsRewriteReport(): FitReport {
    return {
      shots: [
        { shotId: 'x', originalDurationSec: 6, durationSec: 10, holdSec: 0 },
        { shotId: 'y', originalDurationSec: 6, durationSec: 10, holdSec: 0 },
      ],
      lines: [
        { lineId: 'x1', shotId: 'x', speechSec: 9.4, atSec: 0.5, tier: 'needs-rewrite', rewriteBudgetChars: 100 },
        { lineId: 'y1', shotId: 'y', speechSec: 11, atSec: 10.5, tier: 'needs-rewrite', rewriteBudgetChars: 50 },
      ],
      totalDurationSec: 20,
      needsRewrite: true,
    };
  }

  it('maxAtempo以内ならcompressedに書き換え、超えるならneeds-rewriteのまま残す', () => {
    const result = compressToFit(buildNeedsRewriteReport(), 1.06);

    const x1 = result.lines.find((l) => l.lineId === 'x1');
    const y1 = result.lines.find((l) => l.lineId === 'y1');

    expect(x1?.tier).toBe('compressed'); // atempo ≈ 1.044 <= 1.06
    expect(x1?.atempo).toBeCloseTo(9.4 / 9.0, 3);
    expect(x1?.rewriteBudgetChars).toBeUndefined();

    expect(y1?.tier).toBe('needs-rewrite'); // atempo ≈ 1.222 > 1.06
    expect(y1?.atempo).toBeUndefined();

    expect(result.needsRewrite).toBe(true); // yがまだneeds-rewriteのため
  });
});
