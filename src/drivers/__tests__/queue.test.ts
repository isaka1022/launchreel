import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { submitRequest } from '../queue.js';

function fakeResponse(init: { ok: boolean; status: number; statusText?: string; body?: unknown; text?: string }): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.statusText ?? '',
    json: async () => init.body,
    text: async () => init.text ?? '',
  } as unknown as Response;
}

describe('submitRequest', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.GMI_API_KEY = 'test-key-not-real';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.GMI_API_KEY;
  });

  it('503が2回続いた後200が返るとリトライして成功する', async () => {
    let call = 0;
    const onRetry = vi.fn();
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call <= 2) return fakeResponse({ ok: false, status: 503, text: 'Upstream capacity temporarily exhausted' });
      return fakeResponse({ ok: true, status: 200, body: { request_id: 'r1', status: 'success', outcome: { audio_url: 'https://example.com/a.mp3' } } });
    }) as unknown as typeof fetch;

    const result = await submitRequest('model-x', { text: 'hi' }, { initialBackoffMs: 1, maxBackoffMs: 2, onRetry });

    expect(call).toBe(3);
    expect(result).toEqual({ requestId: 'r1', outcome: { audio_url: 'https://example.com/a.mp3' } });
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('リトライ上限を超えたら投げる', async () => {
    globalThis.fetch = vi.fn(async () =>
      fakeResponse({ ok: false, status: 503, statusText: 'Service Unavailable', text: 'Upstream capacity temporarily exhausted' }),
    ) as unknown as typeof fetch;

    await expect(
      submitRequest('model-x', { text: 'hi' }, { maxRetries: 1, initialBackoffMs: 1, maxBackoffMs: 2 }),
    ).rejects.toThrow(/HTTP 503/);
  });
});
