import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '../../drivers/gmi.js';
import type { Recording } from '../../ingest/types.js';
import type { Reel } from '../../timeline/schema.js';

vi.mock('../../drivers/gmi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../drivers/gmi.js')>();
  return { ...actual, chatCompletion: vi.fn() };
});

const { chatCompletion } = await import('../../drivers/gmi.js');
const { designReel } = await import('../m3.js');
const { buildToolSchema } = await import('../prompt.js');

const mockedChatCompletion = vi.mocked(chatCompletion);

function findCachedPlan(dir: string): string {
  const [name] = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (name === undefined) throw new Error(`no cached plan written to ${dir}`);
  return join(dir, name);
}

const recording: Recording = {
  source: 'cast',
  durationSec: 3.65,
  cols: 80,
  rows: 24,
  evidence: [
    { t: 0, kind: 'command', text: 'npm install launchreel' },
    { t: 0.4, kind: 'output', text: 'added 12 packages in 0.9s' },
  ],
};

function validReel(): Reel {
  return {
    version: 'launchreel/1',
    title: 'Demo',
    fps: 30,
    shots: [{ id: 's1', kind: 'terminal', durationSec: 3, label: 'Install', evidenceRange: [0, 3] }],
    narration: [],
    hitPoints: [],
  };
}

/** A shot whose evidenceRange reaches past the (3.65s) recording — the real M3 failure mode. */
function overrunReel(): unknown {
  return {
    ...validReel(),
    shots: [{ id: 's1', kind: 'terminal', durationSec: 12, label: 'Install', evidenceRange: [0, 12] }],
  };
}

function toolResponse(reel: unknown): ChatResponse {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'emit_reel', arguments: JSON.stringify(reel) } }],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  };
}

beforeEach(() => {
  mockedChatCompletion.mockReset();
});

describe('designReel', () => {
  it('1回目で妥当なIRが返ればループしない', async () => {
    mockedChatCompletion.mockResolvedValueOnce(toolResponse(validReel()));

    const result = await designReel(recording);

    expect(mockedChatCompletion).toHaveBeenCalledTimes(1);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]?.problems).toEqual([]);
    expect(result.reel.shots[0]?.id).toBe('s1');
  });

  it('1回目に素材不足のIR、2回目に妥当なIRが返ると1回修復して成功する', async () => {
    mockedChatCompletion.mockResolvedValueOnce(toolResponse(overrunReel())).mockResolvedValueOnce(toolResponse(validReel()));

    const result = await designReel(recording);

    expect(mockedChatCompletion).toHaveBeenCalledTimes(2);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]?.problems.length).toBeGreaterThan(0);
    expect(result.attempts[0]?.problems.join(' ')).toContain('3.65');
    expect(result.attempts[1]?.problems).toEqual([]);
    expect(result.reel).toEqual(validReel());
  });

  it('maxRepairsを使い切ると問題リストを含むエラーで落ちる', async () => {
    mockedChatCompletion.mockResolvedValue(toolResponse(overrunReel()));

    await expect(designReel(recording, { maxRepairs: 1 })).rejects.toThrow(/3\.65/);
    expect(mockedChatCompletion).toHaveBeenCalledTimes(2); // 1 initial + 1 repair
  });
});

describe('プランキャッシュとプロンプトの対応', () => {
  let cacheDir: string;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'launchreel-plan-cache-'));
  });

  afterEach(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('プロンプトが変わっていればオンラインでは作り直す', async () => {
    mockedChatCompletion.mockResolvedValueOnce(toolResponse(validReel()));
    const notices: string[] = [];
    await designReel(recording, { cacheDir, onNotice: (m) => notices.push(m) });

    const cachePath = findCachedPlan(cacheDir);
    const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    expect(cached['promptHash']).toBeTypeOf('string');

    writeFileSync(cachePath, JSON.stringify({ ...cached, promptHash: 'stale' }));
    mockedChatCompletion.mockResolvedValueOnce(toolResponse(validReel()));
    await designReel(recording, { cacheDir, onNotice: (m) => notices.push(m) });

    expect(mockedChatCompletion).toHaveBeenCalledTimes(2);
    expect(notices.join('\n')).toContain('designing a new one');
  });

  it('--offline ではプロンプトが変わっていてもキャッシュを再生し、変わった旨だけ伝える', async () => {
    mockedChatCompletion.mockResolvedValueOnce(toolResponse(validReel()));
    await designReel(recording, { cacheDir });
    const cachePath = findCachedPlan(cacheDir);
    writeFileSync(cachePath, JSON.stringify({ ...JSON.parse(readFileSync(cachePath, 'utf8')), promptHash: 'stale' }));

    const notices: string[] = [];
    const result = await designReel(recording, { cacheDir, offline: true, onNotice: (m) => notices.push(m) });

    expect(mockedChatCompletion).toHaveBeenCalledTimes(1); // 追加の呼び出しなし
    expect(result.reel.shots).toHaveLength(1);
    expect(notices.join('\n')).toContain('replays it unchanged');
  });

  it('promptHashを持たない旧キャッシュは黙って使う', async () => {
    mockedChatCompletion.mockResolvedValueOnce(toolResponse(validReel()));
    await designReel(recording, { cacheDir });
    const cachePath = findCachedPlan(cacheDir);
    const { promptHash: _dropped, ...legacy } = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
    writeFileSync(cachePath, JSON.stringify(legacy));

    const notices: string[] = [];
    await designReel(recording, { cacheDir, onNotice: (m) => notices.push(m) });

    expect(mockedChatCompletion).toHaveBeenCalledTimes(1);
    expect(notices).toEqual([]);
  });
});

describe('buildToolSchema', () => {
  interface ShotToolSchema {
    properties: { shots: { items: { properties: Record<string, { enum?: string[] }> } } };
  }

  const shotProps = (options: { allowGenerated?: boolean; multiSource?: boolean } = {}) =>
    (buildToolSchema({ allowGenerated: false, multiSource: false, ...options }) as ShotToolSchema).properties.shots.items
      .properties;

  it('allowGenerated:falseのときkindのenumにgeneratedを含まない', () => {
    expect(shotProps().kind?.enum).not.toContain('generated');
  });

  it('allowGenerated:trueのときkindのenumにgeneratedを含む', () => {
    expect(shotProps({ allowGenerated: true }).kind?.enum).toContain('generated');
  });

  it('単一録画のときsourceを提示しない', () => {
    expect(shotProps()).not.toHaveProperty('source');
  });

  it('複数素材のときだけsourceを提示する', () => {
    expect(shotProps({ multiSource: true })).toHaveProperty('source');
  });

  it('speedはコードが決めるのでどちらのモードでも提示しない', () => {
    expect(shotProps()).not.toHaveProperty('speed');
    expect(shotProps({ multiSource: true })).not.toHaveProperty('speed');
  });
});
