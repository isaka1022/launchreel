import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assembleReel,
  clampXfade,
  duckAndMix,
  expectedAssembledDurationSec,
  musicFilterChain,
  narrationFilterChain,
  parseLoudnormStats,
  shotStartOffsets,
  videoFilterChain,
} from '../assemble.js';
import { renderCard } from '../../render/card.js';
import { synthesizeLines } from '../../order/speech.js';
import type { Reel } from '../../timeline/schema.js';

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 30_000;

describe('shotStartOffsets', () => {
  it('最初のショットは0から始まり、以降は前のクロスフェード分だけ早まる', () => {
    expect(shotStartOffsets([3, 4, 5], 0.25)).toEqual([0, 2.75, 6.5]);
  });

  it('xfade=0なら単純な累積和になる', () => {
    expect(shotStartOffsets([3, 4, 5], 0)).toEqual([0, 3, 7]);
  });
});

describe('expectedAssembledDurationSec', () => {
  it('ショットが1つならクロスフェードの影響を受けない', () => {
    expect(expectedAssembledDurationSec([5], 0.25)).toBe(5);
  });

  it('境界の数だけクロスフェード秒を差し引く', () => {
    expect(expectedAssembledDurationSec([3, 4, 5], 0.25)).toBeCloseTo(11.5, 6);
  });
});

describe('clampXfade', () => {
  it('隣接ショットの半分を超えるクロスフェードは切り詰める', () => {
    expect(clampXfade(0.25, [0.3, 4])).toBeCloseTo(0.15, 6);
  });

  it('ショットが1つならクロスフェードは常に0', () => {
    expect(clampXfade(0.25, [5])).toBe(0);
  });
});

describe('videoFilterChain', () => {
  it('ショット1つはxfadeを挟まずv0をそのまま出力ラベルにする', () => {
    const chain = videoFilterChain(1, [5], { width: 640, height: 360, fps: 30, background: '#111318', xfadeSec: 0 });
    expect(chain.label).toBe('v0');
    expect(chain.filter).not.toContain('xfade');
  });

  it('xfadeがMIN未満ならconcatにフォールバックする', () => {
    const chain = videoFilterChain(3, [3, 4, 5], { width: 640, height: 360, fps: 30, background: '#111318', xfadeSec: 0 });
    expect(chain.filter).toContain('concat=n=3:v=1:a=0[vout]');
    expect(chain.label).toBe('vout');
  });

  it('複数ショットはxfadeを連鎖させ、オフセットがshotStartOffsetsと一致する', () => {
    const chain = videoFilterChain(3, [3, 4, 5], { width: 640, height: 360, fps: 30, background: '#111318', xfadeSec: 0.25 });
    expect(chain.filter).toContain('offset=2.750');
    expect(chain.filter).toContain('offset=6.500');
    expect(chain.label).toBe('vx2');
  });
});

describe('narrationFilterChain', () => {
  it('ナレーションが無ければ空のfilterを返す', () => {
    expect(narrationFilterChain([])).toEqual({ filter: '' });
  });

  it('1本なら合成せずそのままラベルを返す', () => {
    const chain = narrationFilterChain([{ inputIndex: 2, delayMs: 1500 }]);
    expect(chain.label).toBe('narr0');
    expect(chain.filter).toContain('adelay=delays=1500|1500');
    expect(chain.filter).not.toContain('amix');
  });

  it('複数本はamixで1本にまとめる', () => {
    const chain = narrationFilterChain([
      { inputIndex: 2, delayMs: 0 },
      { inputIndex: 3, delayMs: 3000 },
    ]);
    expect(chain.label).toBe('narrmix');
    expect(chain.filter).toContain('amix=inputs=2:duration=longest:normalize=0[narrmix]');
  });
});

describe('musicFilterChain', () => {
  it('総尺にトリム/パッドし、頭と尻をフェードする', () => {
    const chain = musicFilterChain(5, 30, 1.5);
    expect(chain.filter).toContain('apad=whole_dur=30.000s');
    expect(chain.filter).toContain('atrim=0:30.000');
    expect(chain.filter).toContain('afade=t=in:st=0:d=1.500');
    expect(chain.filter).toContain('afade=t=out:st=28.500:d=1.500');
  });

  it('曲より総尺が短い場合はフェード長を総尺の半分に切り詰める', () => {
    const chain = musicFilterChain(5, 2, 1.5);
    expect(chain.filter).toContain('d=1.000');
  });
});

describe('duckAndMix', () => {
  const intervals = [{ start: 1, end: 3 }];

  it('音楽もナレーションも無ければ空', () => {
    expect(duckAndMix(undefined, undefined, true, [])).toEqual({ filter: '' });
  });

  it('音楽のみならダッキングせずそのまま返す', () => {
    expect(duckAndMix('musicraw', undefined, true, [])).toEqual({ filter: '', label: 'musicraw' });
  });

  it('ナレーションのみならそのまま返す', () => {
    expect(duckAndMix(undefined, 'narrmix', true, intervals)).toEqual({ filter: '', label: 'narrmix' });
  });

  it('sidechaincompressが使えるときはそれでダッキングする', () => {
    const chain = duckAndMix('musicraw', 'narrmix', true, intervals);
    expect(chain.filter).toContain('sidechaincompress');
    expect(chain.filter).toContain('amix=inputs=2:duration=longest:normalize=0[mixedaudio]');
    expect(chain.label).toBe('mixedaudio');
  });

  it('sidechaincompressが無ければvolumeエンベロープにフォールバックする', () => {
    const chain = duckAndMix('musicraw', 'narrmix', false, intervals);
    expect(chain.filter).not.toContain('sidechaincompress');
    expect(chain.filter).toContain("volume=volume=0.35:enable='between(t,1.000,3.000)'");
  });
});

describe('parseLoudnormStats', () => {
  it('stderr中のJSONブロックを取り出す', () => {
    const stderr = `[Parsed_loudnorm_0 @ 0x1]\n{\n"input_i" : "-23.00",\n"input_tp" : "-5.00",\n"input_lra" : "4.00",\n"input_thresh" : "-33.00",\n"target_offset" : "0.50"\n}\n`;
    const stats = parseLoudnormStats(stderr);
    expect(stats.input_i).toBe('-23.00');
    expect(stats.target_offset).toBe('0.50');
  });

  it('JSONが無ければ読めるエラーを投げる', () => {
    expect(() => parseLoudnormStats('no stats here')).toThrow(/loudnorm/);
  });
});

describe('assembleReel (real ffmpeg)', () => {
  let outDir: string;

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'launchreel-assemble-test-'));
  });

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it(
    '映像のみ（ナレーション・BGM無し）で解像度を統一し、尺がクロスフェード込みの期待値に一致する',
    async () => {
      const reel: Reel = {
        version: 'launchreel/1',
        title: 'assemble smoke test',
        fps: 30,
        shots: [
          { id: 's1', kind: 'card', durationSec: 2, label: 'One', card: { title: 'One' } },
          { id: 's2', kind: 'card', durationSec: 2, label: 'Two', card: { title: 'Two' } },
        ],
        narration: [],
        hitPoints: [],
      };

      const s1 = await renderCard(reel.shots[0]!, { outDir, width: 320, height: 180 });
      const s2 = await renderCard(reel.shots[1]!, { outDir, width: 480, height: 270 });

      const outPath = join(outDir, 'out.mp4');
      const result = await assembleReel(reel, {
        shots: new Map([
          ['s1', s1],
          ['s2', s2],
        ]),
        outPath,
        width: 320,
        height: 180,
        xfadeDurationSec: 0.25,
      });

      expect(existsSync(outPath)).toBe(true);
      expect(Math.abs(result.durationSec - 3.75)).toBeLessThanOrEqual(0.2);

      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        outPath,
      ]);
      expect(stdout.trim()).toBe('320,180');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'ナレーションがあると音声トラック付きで書き出され、loudnormが適用される',
    async () => {
      if (process.platform !== 'darwin') return;

      const reel: Reel = {
        version: 'launchreel/1',
        title: 'assemble audio test',
        fps: 30,
        shots: [{ id: 's1', kind: 'card', durationSec: 3, label: 'One', card: { title: 'One' } }],
        narration: [{ id: 'n1', shotId: 's1', text: 'Testing one two three.', atSec: 0.2 }],
        hitPoints: [],
      };

      const s1 = await renderCard(reel.shots[0]!, { outDir, width: 320, height: 180 });
      const synthesized = await synthesizeLines(reel.narration, { provider: 'system', outDir });

      const outPath = join(outDir, 'out-audio.mp4');
      const result = await assembleReel(reel, {
        shots: new Map([['s1', s1]]),
        narration: synthesized,
        outPath,
        width: 320,
        height: 180,
      });

      expect(existsSync(outPath)).toBe(true);
      expect(Math.abs(result.durationSec - 3)).toBeLessThanOrEqual(0.2);

      const { stdout } = await execFileAsync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'a',
        '-show_entries',
        'stream=codec_type,sample_rate',
        '-of',
        'csv=p=0',
        outPath,
      ]);
      // loudnorm resamples to 192 kHz; without an explicit aresample the encoder emits 96 kHz.
      expect(stdout.trim()).toBe('audio,48000');
    },
    TEST_TIMEOUT_MS,
  );
});
