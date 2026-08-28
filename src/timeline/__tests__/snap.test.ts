import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { chooseBestTrack, scoreTrack, snapReel, type TrackAnalysis } from '../snap.js';
import type { Reel } from '../schema.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bgm-analysis.json');
const bgmAnalysis: TrackAnalysis = JSON.parse(readFileSync(fixturePath, 'utf8'));

function buildReel(hitPoints: number[]): Reel {
  return {
    version: 'launchreel/1',
    title: 'Fixture',
    fps: 30,
    shots: [
      { id: 's1', kind: 'card', durationSec: 3, label: 'S1', card: { title: 'S1' } },
      { id: 's2', kind: 'card', durationSec: 4, label: 'S2', card: { title: 'S2' } },
      { id: 's3', kind: 'card', durationSec: 5, label: 'S3', card: { title: 'S3' } },
    ],
    narration: [],
    hitPoints,
  };
}

describe('scoreTrack', () => {
  it('冒頭11秒に置かれたhit pointは拍が無いので外れる（実測: 最初の拍は11.0643秒）', () => {
    const score = scoreTrack([3, 5, 8], bgmAnalysis);
    expect(score.hits).toBe(0);
    expect(score.alignments.every((a) => a.beat === undefined)).toBe(true);
  });

  it('拍の直上に置いたhit pointはshift 0でhitsに数えられる', () => {
    const onBeat = bgmAnalysis.beats[1]!; // 11.7145
    const score = scoreTrack([3, onBeat], bgmAnalysis);
    expect(score.hits).toBe(1);
    expect(score.total).toBe(2);
    const alignment = score.alignments.find((a) => a.hitPoint === onBeat);
    expect(alignment?.beat).toBe(onBeat);
    expect(alignment?.shiftSec).toBe(0);
  });
});

describe('chooseBestTrack', () => {
  it('hit数が多い候補を選ぶ', () => {
    const hitPoints = [10, 20, 30];
    const strong: TrackAnalysis = { durationSec: 40, tempo: 120, beats: [10.05, 20.05, 30.05], segments: [], onsets: [] };
    const weak: TrackAnalysis = { durationSec: 40, tempo: 120, beats: [10.05], segments: [], onsets: [] };
    const result = chooseBestTrack(
      [
        { id: 'weak', analysis: weak },
        { id: 'strong', analysis: strong },
      ],
      hitPoints,
    );
    expect(result?.track.id).toBe('strong');
  });

  it('hit数が同数ならtotalShiftSecの小さい方を選ぶ', () => {
    const hitPoints = [10, 20];
    const tight: TrackAnalysis = { durationSec: 30, tempo: 120, beats: [10.02, 20.03], segments: [], onsets: [] };
    const loose: TrackAnalysis = { durationSec: 30, tempo: 120, beats: [10.4, 20.4], segments: [], onsets: [] };
    const result = chooseBestTrack(
      [
        { id: 'loose', analysis: loose },
        { id: 'tight', analysis: tight },
      ],
      hitPoints,
    );
    expect(result?.score.hits).toBe(2);
    expect(result?.track.id).toBe('tight');
  });
});

describe('snapReel', () => {
  const analysis: TrackAnalysis = { durationSec: 12, tempo: 100, beats: [3.2], segments: [], onsets: [] };

  it('ショット境界を動かしても総尺が保たれる', () => {
    const reel = buildReel([2.9]); // nearest boundary is s1/s2 at t=3, nearest beat is 3.2
    const { reel: snapped } = snapReel(reel, analysis);
    const total = snapped.shots.reduce((sum, s) => sum + s.durationSec, 0);
    expect(total).toBeCloseTo(12, 6);
    expect(snapped.shots[0]!.durationSec).toBeCloseTo(3.3, 6);
    expect(snapped.shots[1]!.durationSec).toBeCloseTo(3.7, 6);
    expect(snapped.hitPoints[0]).toBeCloseTo(3.2, 6);
  });

  it('入力のReelを変更しない', () => {
    const reel = buildReel([2.9]);
    const before = JSON.parse(JSON.stringify(reel));
    snapReel(reel, analysis);
    expect(reel).toEqual(before);
  });

  it('maxShiftSecを超える距離のhit pointは動かさない', () => {
    const reel = buildReel([2.0]); // 1.2s from the only beat (3.2), default maxShiftSec is 0.6
    const { reel: snapped, score } = snapReel(reel, analysis);
    expect(score.alignments[0]?.beat).toBeUndefined();
    expect(snapped.hitPoints[0]).toBe(2.0);
    expect(snapped.shots[0]!.durationSec).toBe(3);
    expect(snapped.shots[1]!.durationSec).toBe(4);
  });
});
