import { describe, expect, it } from 'vitest';
import { srtTime, toSrt, wrap } from '../subtitles.js';

describe('srtTime', () => {
  it('SRTの時刻形式にし、負の値は0に丸める', () => {
    expect(srtTime(0)).toBe('00:00:00,000');
    expect(srtTime(3661.5)).toBe('01:01:01,500');
    expect(srtTime(-2)).toBe('00:00:00,000');
  });
});

describe('wrap', () => {
  it('長い行を2行へ均等に割り、短い行はそのまま返す', () => {
    expect(wrap('short line')).toBe('short line');
    expect(wrap('It reads the session and works out what got demonstrated.')).toBe(
      'It reads the session and works\nout what got demonstrated.',
    );
  });
});

describe('toSrt', () => {
  it('1始まりの連番と時刻範囲を出す', () => {
    const srt = toSrt([
      { startSec: 1, endSec: 2.5, text: 'one' },
      { startSec: 3, endSec: 4, text: 'two' },
    ]);
    expect(srt).toBe('1\n00:00:01,000 --> 00:00:02,500\none\n\n2\n00:00:03,000 --> 00:00:04,000\ntwo\n');
  });
});

describe('どの分割も測度に収まらない行', () => {
  it('1行のまま返さず、最もバランスの取れた2行に割る', () => {
    const long = 'It opens in a real editor. Every clip its own. Narration and music on separate tracks.';

    const [head, tail, ...rest] = wrap(long).split('\n');

    expect(rest).toEqual([]);
    expect(`${head} ${tail}`).toBe(long);
    expect(Math.abs(head!.length - tail!.length)).toBeLessThan(8);
  });
});
