import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fitTitleFontSize, renderCard, wrapBalanced } from '../card.js';
import { renderShots } from '../index.js';
import { lastDetectedRect, padAndClampCrop, renderTerminalShot, selectRangeForSpeed } from '../terminal.js';
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

describe('lastDetectedRect', () => {
  it('reset=0のcropdetectログから最後のcrop=行を読む', () => {
    const stderr = [
      '[Parsed_cropdetect_0] crop=986:700:0:0',
      '[Parsed_cropdetect_0] crop=596:246:12:20',
      '[Parsed_cropdetect_0] crop=596:246:12:20',
    ].join('\n');
    expect(lastDetectedRect(stderr)).toEqual({ w: 596, h: 246, x: 12, y: 20 });
  });

  it('crop=行が無ければundefinedを返す', () => {
    expect(lastDetectedRect('no cropdetect output here')).toBeUndefined();
  });
});

describe('padAndClampCrop', () => {
  const source = { width: 986, height: 700 };

  it('検出領域にパディングを足し、フレーム外に出ないようクランプして偶数に丸める', () => {
    const rect = padAndClampCrop({ w: 596, h: 246, x: 12, y: 20 }, source, 40);
    // x0 = max(0, 12-40) = 0 (already even); x1 = min(986, 12+596+40) = 648 -> w = 648
    // y0 = max(0, 20-40) = 0; y1 = min(700, 20+246+40) = 306 -> h = 306
    expect(rect).toEqual({ x: 0, y: 0, w: 648, h: 306 });
  });

  it('検出領域が画面の20%未満ならundefinedを返す（誤検出扱い）', () => {
    const rect = padAndClampCrop({ w: 50, h: 50, x: 0, y: 0 }, source, 40);
    expect(rect).toBeUndefined();
  });

  it('検出領域がフレーム全体でもクランプ後は元のサイズに収まる（no-opとして安全）', () => {
    const rect = padAndClampCrop({ w: 986, h: 700, x: 0, y: 0 }, source, 40);
    expect(rect).toEqual({ x: 0, y: 0, w: 986, h: 700 });
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

describe('selectRangeForSpeed', () => {
  it('aggの--selectは再生速度後のタイムライン基準なので、素材秒をspeedで割る（実測: --speed 2 で総尺は半分になる）', () => {
    expect(selectRangeForSpeed([8, 16], 1)).toEqual([8, 16]);
    expect(selectRangeForSpeed([8, 16], 0.5)).toEqual([16, 32]);
    expect(selectRangeForSpeed([8, 16], 2)).toEqual([4, 8]);
  });
});

describe('wrapBalanced', () => {
  it('最後の行に1語だけ残る折り返しを避ける', () => {
    const text = "music that won't hit your marks — and narration you can't predict";
    expect(wrapBalanced(text, 63)).toEqual(["music that won't hit your marks —", "and narration you can't predict"]);
  });

  it('1行に収まるテキストは分割しない', () => {
    expect(wrapBalanced('LaunchReel', 40)).toEqual(['LaunchReel']);
  });
});

describe('fitTitleFontSize', () => {
  it('短いタイトルは上限まで大きくして余白を埋める', () => {
    expect(fitTitleFontSize('LaunchReel', 1080, 1612)).toBe(Math.round(1080 * 0.155));
  });

  it('長いタイトルは小さく組むが、下限より小さくはしない', () => {
    const long = 'A title long enough that no sensible size fits it on a single line at all';
    const size = fitTitleFontSize(long, 1080, 1612);
    expect(size).toBeGreaterThanOrEqual(Math.round(1080 * 0.075));
    expect(size).toBeLessThan(fitTitleFontSize('LaunchReel', 1080, 1612));
  });
});
