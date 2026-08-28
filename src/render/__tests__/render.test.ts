import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderCard } from '../card.js';
import { renderShots } from '../index.js';
import { renderTerminalShot } from '../terminal.js';
import type { Reel, Shot } from '../../timeline/schema.js';

/**
 * Exercises the real `agg`/`ffmpeg`/`rsvg-convert` binaries — mocking them would defeat the
 * point of this layer, which is entirely about getting external processes to agree on a duration.
 * Kept fast with a low font size and small frame for the terminal shot.
 */

const TEST_TIMEOUT_MS = 30_000;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const demoCastPath = join(repoRoot, 'examples', 'self', 'demo.cast');

let outDir: string;

beforeEach(() => {
  outDir = mkdtempSync(join(tmpdir(), 'launchreel-render-test-'));
});

afterEach(() => {
  rmSync(outDir, { recursive: true, force: true });
});

describe('renderTerminalShot', () => {
  it(
    '3秒ぶんの区間を切り出すと、実尺が目標尺に0.1秒以内で一致する',
    async () => {
      const shot: Shot = {
        id: 'terminal-3s',
        kind: 'terminal',
        durationSec: 3,
        label: 'terminal smoke shot',
        evidenceRange: [3.0, 6.0],
      };

      const result = await renderTerminalShot(shot, { castPath: demoCastPath, outDir, fontSize: 12 });

      expect(existsSync(result.path)).toBe(true);
      expect(Math.abs(result.durationSec - 3)).toBeLessThanOrEqual(0.1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '目標尺が素材より長いとき、最終フレームを保持して尺を伸ばす（tpad）',
    async () => {
      const shot: Shot = {
        id: 'terminal-extend',
        kind: 'terminal',
        durationSec: 6,
        label: 'shorter footage held to a longer target',
        evidenceRange: [0, 2],
      };

      const result = await renderTerminalShot(shot, { castPath: demoCastPath, outDir, fontSize: 12 });

      expect(Math.abs(result.durationSec - 6)).toBeLessThanOrEqual(0.1);
    },
    TEST_TIMEOUT_MS,
  );

  it('evidenceRangeが無いshotを渡すと読めるエラーになる', async () => {
    const shot: Shot = { id: 'no-range', kind: 'terminal', durationSec: 3, label: 'missing evidenceRange' };
    await expect(renderTerminalShot(shot, { castPath: demoCastPath, outDir })).rejects.toThrow(/evidenceRange/);
  });
});

describe('renderCard', () => {
  it(
    '英語カードをレンダリングすると尺が一致する',
    async () => {
      const shot: Shot = {
        id: 'card-en',
        kind: 'card',
        durationSec: 2,
        label: 'english card',
        card: { title: 'LaunchReel', subtitle: 'From a terminal recording to an editable timeline', command: 'npx launchreel build demo.cast' },
      };

      const result = await renderCard(shot, { outDir, width: 640, height: 360 });

      expect(existsSync(result.path)).toBe(true);
      expect(Math.abs(result.durationSec - 2)).toBeLessThanOrEqual(0.1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    '日本語を含むカードもレンダリングに成功する',
    async () => {
      const shot: Shot = {
        id: 'card-ja',
        kind: 'card',
        durationSec: 2,
        label: 'japanese card',
        card: { title: 'ローンチリール', subtitle: '端末の録画を、編集可能なタイムラインへ変換します', command: 'npx launchreel build demo.cast' },
      };

      const result = await renderCard(shot, { outDir, width: 640, height: 360 });

      expect(existsSync(result.path)).toBe(true);
      expect(Math.abs(result.durationSec - 2)).toBeLessThanOrEqual(0.1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('renderShots', () => {
  it('generated kindは未対応として読めるエラーになる', async () => {
    const reel: Reel = {
      version: 'launchreel/1',
      title: 'unsupported kind',
      fps: 30,
      shots: [{ id: 'gen1', kind: 'generated', durationSec: 3, label: 'needs a paid model', prompt: 'a robot waves hello' }],
      narration: [],
      hitPoints: [],
    };

    await expect(renderShots(reel, { outDir })).rejects.toThrow(/generated/);
  });
});
