import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseTape } from '../tape.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('parseTape', () => {
  it('TypingSpeedに応じてType+Enterの所要時間を積算し、Enterが続かないTypeはcommandにしない', () => {
    const withEnter = parseTape(['Set TypingSpeed 100ms', 'Type "hi"', 'Enter'].join('\n'));
    const commands = withEnter.evidence.filter((e) => e.kind === 'command');
    expect(commands).toHaveLength(1);
    expect(commands[0]?.text).toBe('hi');
    expect(commands[0]?.t).toBe(0);
    // "hi" = 2 chars * 100ms + Enter 1 stroke * 100ms = 0.3s
    expect(withEnter.durationSec).toBeCloseTo(0.3, 5);

    const withoutEnter = parseTape(['Set TypingSpeed 100ms', 'Type "no enter follows"'].join('\n'));
    expect(withoutEnter.evidence.some((e) => e.kind === 'command')).toBe(false);
  });

  it('Sleepが1.5秒以上ならpause、未満なら検出しない', () => {
    const content = ['Sleep 2s', 'Sleep 500ms'].join('\n');
    const recording = parseTape(content);

    const pauses = recording.evidence.filter((e) => e.kind === 'pause');
    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.durationSec).toBeCloseTo(2, 5);
  });

  it('Hide〜Showの区間は1件のannotationにまとめ、隠れている間のcommandは記録しない', () => {
    const content = ['# setup comment', 'Hide', 'Type "secret"', 'Enter', 'Show'].join('\n');
    const recording = parseTape(content);

    const annotations = recording.evidence.filter((e) => e.kind === 'annotation');
    expect(annotations).toHaveLength(2);
    expect(annotations.map((a) => a.text)).toEqual(['setup comment', 'hidden setup']);

    expect(recording.evidence.some((e) => e.kind === 'command')).toBe(false);
  });

  it('実物に近いfixtureからコマンド行とpauseを正しく抽出する', () => {
    const content = readFileSync(join(fixturesDir, 'sample.tape'), 'utf8');
    const recording = parseTape(content);

    expect(recording.source).toBe('tape');
    const commands = recording.evidence.filter((e) => e.kind === 'command').map((e) => e.text);
    expect(commands).toEqual(['npm install', 'npm run build', 'echo done']);
    expect(recording.evidence.some((e) => e.kind === 'pause')).toBe(true);
    expect(recording.evidence.some((e) => e.kind === 'annotation' && e.text === 'hidden setup')).toBe(true);
  });
});
