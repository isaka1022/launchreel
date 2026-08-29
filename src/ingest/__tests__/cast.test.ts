import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseCast } from '../cast.js';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

describe('parseCast', () => {
  it('v2は時刻を絶対秒として、v3は前イベントからの相対秒として解釈する', () => {
    const events = ['[1, "o", "$ echo hi\\n"]', '[1, "o", "hi\\n"]', '[1, "o", "$ \\n"]'].join('\n');
    const v2 = parseCast(`{"version":2,"width":80,"height":24}\n${events}\n`);
    const v3 = parseCast(`{"version":3,"term":{"cols":80,"rows":24}}\n${events}\n`);

    expect(v2.durationSec).toBe(1);
    expect(v3.durationSec).toBe(3);
  });

  it('ANSIエスケープを除去し、\\rによる再描画は最後の状態1件に畳み込む', () => {
    const content = [
      '{"version":2,"width":80,"height":24}',
      '[0, "o", "\\u001b[36mBuilding\\u001b[0m\\r"]',
      '[0.1, "o", "\\u001b[36mBuilding.\\u001b[0m\\r"]',
      '[0.2, "o", "\\u001b[32mDone\\u001b[0m\\n"]',
      '',
    ].join('\n');

    const recording = parseCast(content);
    const outputLines = recording.evidence.filter((e) => e.kind === 'output' || e.kind === 'command');

    expect(outputLines).toHaveLength(1);
    expect(outputLines[0]?.text).toBe('Done');
  });

  it('1.5秒以上の無音区間だけpauseとして検出する', () => {
    const content = [
      '{"version":2,"width":80,"height":24}',
      '[0, "o", "a\\n"]',
      '[0.5, "o", "b\\n"]',
      '[2.5, "o", "c\\n"]',
      '',
    ].join('\n');

    const recording = parseCast(content);
    const pauses = recording.evidence.filter((e) => e.kind === 'pause');

    expect(pauses).toHaveLength(1);
    expect(pauses[0]?.durationSec).toBeCloseTo(2, 5);
  });

  it('実物に近いfixtureからヘッダとコマンド行を正しく抽出する', () => {
    const content = readFileSync(join(fixturesDir, 'sample.cast'), 'utf8');
    const recording = parseCast(content);

    expect(recording.source).toBe('cast');
    expect(recording.cols).toBe(80);
    expect(recording.rows).toBe(24);
    expect(recording.title).toBe('launchreel demo');

    const commands = recording.evidence.filter((e) => e.kind === 'command').map((e) => e.text);
    expect(commands).toEqual(['npm install', 'npm run build', 'echo done']);

    const annotations = recording.evidence.filter((e) => e.kind === 'annotation');
    expect(annotations.some((e) => e.text === 'install done')).toBe(true);
  });

  it('durationSecは末尾の出力イベント時刻までとし、終了イベントで延長しない', () => {
    const v2Events = ['[1, "o", "$ echo hi\\n"]', '[2, "o", "hi\\n"]', '[2.3, "x", "0"]'].join('\n');
    const v2 = parseCast(`{"version":2,"width":80,"height":24}\n${v2Events}\n`);
    expect(v2.durationSec).toBe(2);

    const v3Events = ['[1, "o", "$ echo hi\\n"]', '[1, "o", "hi\\n"]', '[0.3, "x", "0"]'].join('\n');
    const v3 = parseCast(`{"version":3,"term":{"cols":80,"rows":24}}\n${v3Events}\n`);
    expect(v3.durationSec).toBe(2);
  });
});
