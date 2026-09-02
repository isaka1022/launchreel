import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  cardNarrationAdvisories,
  compressToFit,
  fitReel,
  motionBreakdown,
  narrationBudgetAdvisories,
  cardReadSec,
  onsetAdvisories,
  onsetAlignments,
  repeatedRangeAdvisories,
  snapRangeToOnset,
  stretchFootageToShots,
  type FitReport,
} from '../fit.js';
import { MIN_SHOT_SPEED, reelSchema, shotFootageSec, totalDurationSec, type Reel } from '../schema.js';
import type { TimeSpan } from '../../ingest/activity.js';
import type { SourceTiming } from '../fit.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '__tests__', 'fixtures');

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
    expect(byShotId.get('s4')?.durationSec).toBe(5.5); // 読む時間(1語=3s floor) + 最終カードの余韻2.5s

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
    // hit=9は元タイムラインでs4の50%地点 → 新しいs4区間([16.6, 22.1])の50%地点(19.35)に追随する
    expect(reel.hitPoints[1]).toBeCloseTo(19.35, 5);
  });

  it('入力のReelを変更しない', () => {
    const reel = buildReel();
    const before = JSON.stringify(reel);

    const { reel: fitted } = fitReel(reel, fitOptions);

    expect(JSON.stringify(reel)).toBe(before);
    expect(fitted).not.toBe(reel);
    expect(fitted.shots).not.toBe(reel.shots);
  });

  it('実際のreelでナレーションの超過が解消される', () => {
    const raw = JSON.parse(readFileSync(join(fixturesDir, 'vhs-demo-reel.json'), 'utf8'));
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

describe('stretchFootageToShots', () => {
  const reel = (): Reel => ({
    version: 'launchreel/1',
    title: 'Fixture',
    fps: 30,
    shots: [
      { id: 'short', kind: 'terminal', durationSec: 4, label: 'short', evidenceRange: [0, 3] },
      { id: 'tiny', kind: 'terminal', durationSec: 40, label: 'tiny', evidenceRange: [0, 2] },
      { id: 'covered', kind: 'terminal', durationSec: 4, label: 'covered', evidenceRange: [0, 9] },
      { id: 'card', kind: 'card', durationSec: 3, label: 'card', card: { title: 'C' } },
    ],
    narration: [],
    hitPoints: [],
  });

  it('尺に足りない素材だけ減速し、足りている素材と尺は触らない', () => {
    const stretched = stretchFootageToShots(reel());
    const byId = new Map(stretched.shots.map((s) => [s.id, s]));

    expect(byId.get('short')?.speed).toBe(0.75); // 3s / 4s
    expect(byId.get('tiny')?.speed).toBe(MIN_SHOT_SPEED); // 2s / 40s = 0.05 だが下限で止まる
    expect(byId.get('covered')?.speed).toBeUndefined(); // すでに足りているので等倍のまま
    expect(byId.get('card')?.speed).toBeUndefined();
    expect(stretched.shots.map((s) => s.durationSec)).toEqual([4, 40, 4, 3]);
  });

  it('下限より遅くはせず、埋まらない分はフレーム保持に残す', () => {
    const stretched = stretchFootageToShots(reel());
    const tiny = stretched.shots.find((s) => s.id === 'tiny');

    expect(tiny?.speed).toBe(MIN_SHOT_SPEED);
    expect(shotFootageSec(tiny!)).toBeCloseTo(2 / MIN_SHOT_SPEED, 6); // 3.33s だけ動き、残り36.7sは保持
  });

  it('入力のReelを変更しない', () => {
    const input = reel();
    const before = JSON.stringify(input);
    stretchFootageToShots(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('snapRangeToOnset', () => {
  // build は 2-4s と 9-12s で描画し、その間は止まっている。出力は各区間の末尾に一気に描かれる
  const timing = new Map<string, SourceTiming>([
    [
      'build',
      {
        durationSec: 16,
        spans: [
          { startSec: 2, endSec: 4 },
          { startSec: 9, endSec: 12 },
        ],
      },
    ],
  ]);

  const reelOf = (evidenceRange: [number, number]): Reel => ({
    version: 'launchreel/1',
    title: 'Fixture',
    fps: 30,
    shots: [{ id: 's', kind: 'terminal', durationSec: 6, label: 's', source: 'build', evidenceRange }],
    narration: [],
    hitPoints: [],
  });

  const rangeOf = (reel: Reel): [number, number] | undefined => reel.shots[0]?.evidenceRange;

  it('静止区間で始まる範囲を、次に描画が始まる直前まで送る', () => {
    expect(rangeOf(snapRangeToOnset(reelOf([6, 14]), timing))).toEqual([8.6, 14]);
  });

  it('描画の途中から始まる範囲は、その描画の先頭まで戻す', () => {
    expect(rangeOf(snapRangeToOnset(reelOf([11, 14]), timing))).toEqual([8.6, 14]);
  });

  it('描画が終わる瞬間で切れている範囲は、描かれた画面が映るまで末尾を伸ばす', () => {
    // [1.8, 4] は出力が描かれる 4.00s ちょうどで終わり、コマンド行だけの画面で終わってしまう
    expect(rangeOf(snapRangeToOnset(reelOf([1.8, 4]), timing))).toEqual([1.8, 5]);
  });

  it('末尾を伸ばすときも録画の長さを超えない', () => {
    expect(rangeOf(snapRangeToOnset(reelOf([8.9, 12]), timing))).toEqual([8.9, 13]);
    expect(rangeOf(snapRangeToOnset(reelOf([8.9, 15.5]), new Map([['build', { durationSec: 12.5, spans: timing.get('build')!.spans }]])))).toEqual([8.9, 12.5]);
  });

  it('すでに描画開始の直前にあり末尾も足りている範囲は動かさない', () => {
    expect(rangeOf(snapRangeToOnset(reelOf([1.8, 6]), timing))).toEqual([1.8, 6]);
  });

  it('以後まったく描画がない範囲は動かさず、入力も変更しない', () => {
    const input = reelOf([13, 16]);
    const before = JSON.stringify(input);
    expect(rangeOf(snapRangeToOnset(input, timing))).toEqual([13, 16]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('スナップ後は全ショットが描画開始の許容範囲に収まる', () => {
    const snapped = snapRangeToOnset(reelOf([6, 14]), timing);
    const [alignment] = onsetAlignments(snapped, timing);

    expect(alignment?.offsetSec).toBeCloseTo(-0.4, 6);
    expect(onsetAdvisories(snapped, timing)).toEqual([]);
  });

  it('ずれたままのショットは、どこから始めるべきかを添えて指摘する', () => {
    const advisories = onsetAdvisories(reelOf([6, 8.8]), timing);

    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('opens on 3.00s of a screen that is not moving');
    expect(advisories[0]).toContain('the next thing drawn is at 9.00s');
  });
});

describe('repeatedRangeAdvisories', () => {
  const reelOf = (ranges: [string, string, [number, number]][]): Reel => ({
    version: 'launchreel/1',
    title: 'Fixture',
    fps: 30,
    shots: ranges.map(([id, source, evidenceRange]) => ({
      id,
      kind: 'terminal' as const,
      durationSec: 4,
      label: id,
      source,
      evidenceRange,
    })),
    narration: [],
    hitPoints: [],
  });

  it('同じ素材の同じ場面を二度使ったショットだけを指摘する', () => {
    const advisories = repeatedRangeAdvisories(
      reelOf([
        ['a', 'build', [0, 4]],
        ['b', 'build', [0.2, 4.1]],
        ['c', 'build', [9, 12]],
        ['d', 'setup', [0, 4]],
      ]),
    );

    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('shot "b"');
    expect(advisories[0]).toContain('shot "a" already showed');
  });
});

describe('motionBreakdown', () => {
  // build は 0-2s と 8-10s だけ画面が動き、2-8s は止まっている
  const active = new Map<string, TimeSpan[]>([
    [
      'build',
      [
        { startSec: 0, endSec: 2 },
        { startSec: 8, endSec: 10 },
      ],
    ],
  ]);

  const reelOf = (shots: Reel['shots']): Reel => ({
    version: 'launchreel/1',
    title: 'Fixture',
    fps: 30,
    shots,
    narration: [],
    hitPoints: [],
  });

  it('素材で埋まった秒数と、そのうち実際に画面が動く秒数を分けて数える', () => {
    const motion = motionBreakdown(
      reelOf([
        { id: 's1', kind: 'terminal', durationSec: 10, label: 's1', source: 'build', evidenceRange: [0, 10] },
        { id: 's2', kind: 'card', durationSec: 4, label: 's2', card: { title: 'C' } },
      ]),
      active,
    );

    expect(motion.totalSec).toBe(14);
    expect(motion.footageSec).toBe(10);
    expect(motion.changingSec).toBe(4);
    expect(motion.graphicSec).toBe(4); // カードは止まっていて当然なので保持と混ぜない
    expect(motion.heldSec).toBe(0);
  });

  it('尺より素材が短いぶんは保持として数える', () => {
    const motion = motionBreakdown(
      reelOf([{ id: 's1', kind: 'terminal', durationSec: 10, label: 's1', source: 'build', evidenceRange: [0, 2] }]),
      active,
    );

    expect(motion.footageSec).toBe(2);
    expect(motion.changingSec).toBe(2);
    expect(motion.heldSec).toBe(8);
  });

  it('速度を落とすと同じ範囲が長く画面を占める', () => {
    const motion = motionBreakdown(
      reelOf([{ id: 's1', kind: 'terminal', durationSec: 10, label: 's1', source: 'build', evidenceRange: [0, 2], speed: 0.5 }]),
      active,
    );

    expect(motion.footageSec).toBe(4);
    expect(motion.changingSec).toBe(4);
  });
});

describe('narrationBudgetAdvisories', () => {
  const reelWith = (texts: string[]): Reel => ({
    version: 'launchreel/1',
    title: 't',
    fps: 30,
    shots: [{ id: 's1', kind: 'card', durationSec: 5, label: 'l', card: { title: 'c' } }],
    narration: texts.map((text, i) => ({ id: `n${i}`, shotId: 's1', text })),
    hitPoints: [],
  });

  it('予算内なら何も言わない', () => {
    expect(narrationBudgetAdvisories(reelWith(['12345', '12345']), 10)).toEqual([]);
  });

  it('超過分を文字数で示す', () => {
    const advisories = narrationBudgetAdvisories(reelWith(['1234567890', '12345']), 10);
    expect(advisories).toHaveLength(1);
    expect(advisories[0]).toContain('15 characters against a budget of 10');
    expect(advisories[0]).toContain('5 over');
  });
});

describe('ナレーション行の重なり', () => {
  it('モデルのatSecは順序のヒントに留め、行は自ショット内で実測尺に従って順に置く', () => {
    const reel: Reel = {
      version: 'launchreel/1',
      title: 't',
      fps: 30,
      shots: [
        { id: 's1', kind: 'terminal', durationSec: 10 },
        { id: 's2', kind: 'terminal', durationSec: 10 },
      ],
      narration: [
        { id: 'n1', shotId: 's1', text: 'one', atSec: 1 },
        // Overlaps n1 within the same shot, and n3 overlaps across the shot boundary.
        { id: 'n2', shotId: 's1', text: 'two', atSec: 2 },
        { id: 'n3', shotId: 's2', text: 'three', atSec: 3 },
      ],
      hitPoints: [],
    } as unknown as Reel;

    const measured = new Map([
      ['n1', 4],
      ['n2', 4],
      ['n3', 4],
    ]);
    const { report } = fitReel(reel, { measured });
    const at = new Map(report.lines.map((l) => [l.lineId, l.atSec]));

    expect(at.get('n1')).toBe(0.3);
    expect(at.get('n2')).toBe(4.8);
    // s1 was extended to hold both lines (0.3 + 4 + 0.5 + 4 + 0.3 = 9.1 < 10 so it stays 10); n3 starts in s2.
    expect(at.get('n3')).toBe(10.3);
    for (const line of report.lines) {
      const others = report.lines.filter((o) => o.lineId !== line.lineId && o.atSec > line.atSec);
      for (const later of others) expect(later.atSec).toBeGreaterThanOrEqual(line.atSec + line.speechSec);
    }
  });
});

describe('cardReadSec', () => {
  it('語数で読む時間を出し、記号だけのトークンは数えない', () => {
    expect(cardReadSec({ title: 'S1' })).toBe(3);
    expect(cardReadSec({ title: 'Two artifacts, not one', subtitle: 'reel.mp4 + reel.otio' })).toBeCloseTo(1.5 + 6 * 0.3, 5);
  });
});

describe('cardNarrationAdvisories', () => {
  const reel = (): Reel => ({
    version: 'launchreel/1',
    title: 'demo',
    fps: 30,
    shots: [
      { id: 's1', kind: 'card', label: 'chapter', durationSec: 4, card: { title: 'Chapter' } },
      { id: 's2', kind: 'terminal', label: 'run', durationSec: 6, evidenceRange: [0, 6] },
    ],
    narration: [],
    hitPoints: [],
  });

  it('says nothing about a card holding a single line', () => {
    const r = reel();
    r.narration = [{ id: 'n1', shotId: 's1', text: 'one' }];
    expect(cardNarrationAdvisories(r)).toEqual([]);
  });

  it('names the card, the count and the lines when a card carries the argument', () => {
    const r = reel();
    r.narration = [
      { id: 'n1', shotId: 's1', text: 'one' },
      { id: 'n2', shotId: 's1', text: 'two' },
      { id: 'n3', shotId: 's2', text: 'three' },
    ];
    const [advisory, ...rest] = cardNarrationAdvisories(r);
    expect(rest).toEqual([]);
    expect(advisory).toContain('card "s1" carries 2 narration lines (n1, n2)');
  });
});
