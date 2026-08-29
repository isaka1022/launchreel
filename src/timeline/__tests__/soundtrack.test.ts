import { describe, expect, it } from 'vitest';
import { totalDurationSec, type Reel } from '../schema.js';
import { snapReel, type TrackAnalysis } from '../snap.js';
import {
  applySegmentReel,
  musicSpecForSegment,
  musicSwitchPoints,
  nextSegmentBoundary,
  segment,
  segmentSubReel,
  tracksCovering,
} from '../soundtrack.js';

/** 4 shots of 20s: [0,20) terminal, [20,40) card, [40,60) terminal, [60,80) card. */
function buildReel(hitPoints: number[] = []): Reel {
  return {
    version: 'launchreel/1',
    title: 'Fixture',
    fps: 30,
    shots: [
      { id: 's1', kind: 'terminal', durationSec: 20, label: 'S1', evidenceRange: [0, 20] },
      { id: 's2', kind: 'card', durationSec: 20, label: 'S2', card: { title: 'Two' } },
      { id: 's3', kind: 'terminal', durationSec: 20, label: 'S3', evidenceRange: [0, 20] },
      { id: 's4', kind: 'card', durationSec: 20, label: 'S4', card: { title: 'Four' } },
    ],
    narration: [{ id: 'n1', shotId: 's1', text: 'Hello.' }],
    hitPoints,
  };
}

describe('musicSwitchPoints', () => {
  it('先頭を除く全カットを返し、カードの切れ目にisChapterを立てる', () => {
    expect(musicSwitchPoints(buildReel())).toEqual([
      { shotIndex: 1, atSec: 20, isChapter: true },
      { shotIndex: 2, atSec: 40, isChapter: false },
      { shotIndex: 3, atSec: 60, isChapter: true },
    ]);
  });
});

describe('nextSegmentBoundary', () => {
  const points = musicSwitchPoints(buildReel());

  it('曲が届く範囲で最後のカード（章の切れ目）を選ぶ', () => {
    const boundary = nextSegmentBoundary(points, { startSec: 0, trackDurationSec: 50, totalSec: 80, minSegmentSec: 10 });
    expect(boundary?.atSec).toBe(20); // 40s のカットは非カード、60s は曲が届かない
  });

  it('曲がリールの残り全部を覆うなら切り替えない（1曲で足りる実測ケース）', () => {
    expect(nextSegmentBoundary(points, { startSec: 0, trackDurationSec: 90, totalSec: 80, minSegmentSec: 10 })).toBeUndefined();
  });

  it('残りがminSegmentSecを下回る位置では切らない', () => {
    const boundary = nextSegmentBoundary(points, { startSec: 0, trackDurationSec: 70, totalSec: 80, minSegmentSec: 25 });
    expect(boundary?.atSec).toBe(20); // 60s で切ると残り20秒しかない
  });
});

describe('segmentSubReel / applySegmentReel', () => {
  it('snapReelを区間に適用しても区間長と全体尺が保たれ、hit pointは元の位置に戻る', () => {
    const reel = buildReel([10, 59.7, 70]);
    const seg = segment(reel, 1, 2, 4); // [40, 80)
    const sub = segmentSubReel(reel, seg);

    expect(sub.shots.map((s) => s.id)).toEqual(['s3', 's4']);
    expect(sub.hitPoints[0]).toBeCloseTo(19.7, 6); // 区間先頭からの相対秒
    expect(sub.hitPoints[1]).toBe(30);

    // s3/s4 の境界(相対20s)の近くに拍を置くと、境界だけが動いて区間長は変わらない
    const analysis: TrackAnalysis = { durationSec: 40, tempo: 120, beats: [20.1], segments: [], onsets: [] };
    const { reel: snappedSub } = snapReel(sub, analysis);
    const merged = applySegmentReel(reel, seg, snappedSub);

    expect(totalDurationSec(merged)).toBeCloseTo(80, 6);
    expect(merged.shots.map((s) => s.durationSec)[2]).toBeCloseTo(20.4, 6); // 境界がshift(0.4s)分だけ動く
    expect(merged.shots.map((s) => s.durationSec)[3]).toBeCloseTo(19.6, 6);
    expect(merged.narration).toEqual(reel.narration);
    expect(merged.hitPoints[0]).toBe(10); // 区間外は不動
    expect(merged.hitPoints[1]).toBeCloseTo(60.1, 6); // 拍に乗せた分だけ動く
    expect(merged.hitPoints[2]).toBe(70); // 近い拍が無いので不動
  });
});

describe('tracksCovering', () => {
  const tracks = [{ id: 'short', sec: 81.9 }, { id: 'mid', sec: 132.6 }, { id: 'long', sec: 172.9 }];
  const secOf = (t: { sec: number }): number => t.sec;

  it('区間を最後まで鳴らせる曲だけを残す', () => {
    expect(tracksCovering(tracks, 123.4, secOf).map((t) => t.id)).toEqual(['mid', 'long']);
  });

  it('どれも届かないなら全候補を返す（無音で埋めるより一番合う曲を選ばせる）', () => {
    expect(tracksCovering(tracks, 200, secOf).map((t) => t.id)).toEqual(['short', 'mid', 'long']);
  });
});

describe('musicSpecForSegment', () => {
  it('最初の区間は元のcaptionのまま、以降は区間ごとに違うcaptionになる', () => {
    const spec = { caption: 'Ambient pulse', structureTags: ['[Intro]'], targetDurationSec: 150 };

    expect(musicSpecForSegment(spec, 0, 80)).toEqual({ ...spec, targetDurationSec: 80 });
    expect(musicSpecForSegment(spec, 1, 70).caption).not.toBe(musicSpecForSegment(spec, 2, 70).caption);
  });
});
