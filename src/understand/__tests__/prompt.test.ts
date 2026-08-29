import { describe, expect, it } from 'vitest';
import type { FootageItem } from '../../ingest/footage.js';
import { buildLongFormMessages, shotCountRange } from '../prompt.js';

const footage: FootageItem[] = [
  {
    id: 'build',
    path: 'footage/build.cast',
    kind: 'cast',
    recording: {
      source: 'cast',
      durationSec: 10,
      evidence: [
        { t: 0, kind: 'command', text: 'npm run build' },
        { t: 1.9, kind: 'output', text: 'compiled 42 modules'.padEnd(200, ' .') },
        { t: 2, kind: 'pause', text: 'pause', durationSec: 6 },
        { t: 8, kind: 'output', text: 'done in 1.2s'.padEnd(200, ' .') },
      ],
    },
  },
];

function userPrompt(): string {
  const messages = buildLongFormMessages('# Pitch\n\nIt ships.', footage, {
    targetDurationSec: 150,
    language: 'en',
    toolName: 'emit_reel',
  });
  const user = messages[1];
  return user !== undefined && 'content' in user ? (user.content ?? '') : '';
}

describe('shotCountRange', () => {
  it('目標尺を1ショット4.5〜6秒で割ったショット数を返す', () => {
    expect(shotCountRange(150)).toEqual([25, 33]);
    expect(shotCountRange(30)).toEqual([5, 7]);
  });
});

describe('buildLongFormMessages', () => {
  it('画面が動いている区間を明示し、動いている総秒数を伝える', () => {
    const prompt = userPrompt();
    expect(prompt).toContain('active spans');
    expect(prompt).toContain('0.00-2.00s, 8.00-10.00s');
    expect(prompt).toContain('There are 2 active spans across the 1 recordings');
  });

  it('無音区間をいつまで凍っているかが読める形で渡す', () => {
    expect(userPrompt()).toContain('[2.00s] pause: screen frozen until 8.00s');
  });

  it('目標尺とショット数を同じ行で示す', () => {
    expect(userPrompt()).toContain('about 150s, reached with 25–33 shots');
  });

  it('描画開始に合わせて範囲を始めるよう、システム側で数字つきに指示する', () => {
    const system = buildLongFormMessages('# Pitch', footage, { targetDurationSec: 150, language: 'en', toolName: 'emit_reel' })[0];
    const content = system !== undefined && 'content' in system ? (system.content ?? '') : '';

    expect(content).toContain('Start every range AT a span start, or up to 0.4s before one');
    expect(content).toContain('No two shots may show the same stretch of a recording');
  });
});
