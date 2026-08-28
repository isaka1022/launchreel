import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('buildToolSchema', () => {
  interface ShotToolSchema {
    properties: { shots: { items: { properties: { kind: { enum: string[] } } } } };
  }

  it('allowGenerated:falseのときkindのenumにgeneratedを含まない', () => {
    const schema = buildToolSchema({ allowGenerated: false }) as ShotToolSchema;
    expect(schema.properties.shots.items.properties.kind.enum).not.toContain('generated');
  });

  it('allowGenerated:trueのときkindのenumにgeneratedを含む', () => {
    const schema = buildToolSchema({ allowGenerated: true }) as ShotToolSchema;
    expect(schema.properties.shots.items.properties.kind.enum).toContain('generated');
  });
});
