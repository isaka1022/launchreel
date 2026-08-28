import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatResponse } from '../../drivers/gmi.js';
import type { Reel } from '../../timeline/schema.js';

vi.mock('../../drivers/gmi.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../drivers/gmi.js')>();
  return { ...actual, chatCompletion: vi.fn() };
});

const { chatCompletion } = await import('../../drivers/gmi.js');
const { rewriteLines } = await import('../rewrite.js');

const mockedChatCompletion = vi.mocked(chatCompletion);

const reel: Reel = {
  version: 'launchreel/1',
  title: 'Demo',
  fps: 30,
  shots: [{ id: 's1', kind: 'card', durationSec: 20, label: 'Install', card: { title: 'Install' } }],
  narration: [{ id: 'n1', shotId: 's1', text: 'a very long sentence that does not fit its budget at all' }],
  hitPoints: [],
};

function toolResponse(lines: { id: string; text: string }[]): ChatResponse {
  return {
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shorten_lines', arguments: JSON.stringify({ lines }) } }],
        },
      },
    ],
    usage: { prompt_tokens: 40, completion_tokens: 20 },
  };
}

beforeEach(() => {
  mockedChatCompletion.mockReset();
});

describe('rewriteLines', () => {
  it('リクエストが空なら呼び出さずに空配列を返す', async () => {
    const result = await rewriteLines(reel, []);

    expect(mockedChatCompletion).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it('妥当なtool callが返れば1回の往復で短縮結果を返す', async () => {
    mockedChatCompletion.mockResolvedValueOnce(toolResponse([{ id: 'n1', text: 'a short sentence' }]));

    const result = await rewriteLines(reel, [{ id: 'n1', text: reel.narration[0]!.text, rewriteBudgetChars: 20 }]);

    expect(mockedChatCompletion).toHaveBeenCalledTimes(1);
    expect(result).toEqual([{ id: 'n1', text: 'a short sentence' }]);
  });

  it('tool callが無ければ、リトライせずエラーを投げる', async () => {
    mockedChatCompletion.mockResolvedValueOnce({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'no tool call' } }],
    });

    await expect(rewriteLines(reel, [{ id: 'n1', text: 'x', rewriteBudgetChars: 20 }])).rejects.toThrow(/did not call/);
    expect(mockedChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('スキーマに合わない応答は、リトライせずエラーを投げる', async () => {
    mockedChatCompletion.mockResolvedValueOnce(toolResponse([{ id: 'n1', text: '' }]));

    await expect(rewriteLines(reel, [{ id: 'n1', text: 'x', rewriteBudgetChars: 20 }])).rejects.toThrow(/invalid rewrite response/);
    expect(mockedChatCompletion).toHaveBeenCalledTimes(1);
  });
});
