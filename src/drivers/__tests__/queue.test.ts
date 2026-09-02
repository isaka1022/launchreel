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

  it('submit時の一過性fetch失敗はリトライする', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new TypeError('fetch failed');
      return fakeResponse({ ok: true, status: 200, body: { request_id: 'r1', status: 'success', outcome: { ok: true } } });
    }) as unknown as typeof fetch;

    const result = await submitRequest('model-x', { text: 'hi' }, { initialBackoffMs: 1, maxBackoffMs: 2 });

    expect(call).toBe(2);
    expect(result.requestId).toBe('r1');
  });

  it('ポーリング中の一過性失敗で処理中のリクエストを捨てない', async () => {
    let polls = 0;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return fakeResponse({ ok: true, status: 200, body: { request_id: 'r1', status: 'queued' } });
      polls += 1;
      if (polls === 1) throw new TypeError('fetch failed');
      return fakeResponse({ ok: true, status: 200, body: { request_id: 'r1', status: 'success', outcome: { ok: true } } });
    }) as unknown as typeof fetch;

    const result = await submitRequest('model-x', { text: 'hi' }, { pollIntervalMs: 1, pollTimeoutMs: 5_000 });

    expect(polls).toBe(2);
    expect(result.requestId).toBe('r1');
  });

  it('キューに残り続けたリクエストは投げ直して成功する', async () => {
    const seen: string[] = [];
    const onRetry = vi.fn();
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        seen.push('post');
        return fakeResponse({ ok: true, status: 200, body: { request_id: `r${seen.length}`, status: 'queued' } });
      }
      const stalls = seen.filter((s) => s === 'post').length === 1;
      return fakeResponse({
        ok: true,
        status: 200,
        body: stalls ? { request_id: 'r1', status: 'queued' } : { request_id: 'r2', status: 'success', outcome: { audio_url: 'https://example.com/a.mp3' } },
      });
    }) as unknown as typeof fetch;

    const result = await submitRequest(
      'model-x',
      { text: 'hi' },
      { pollIntervalMs: 1, pollTimeoutMs: 5, initialBackoffMs: 1, maxBackoffMs: 2, onRetry },
    );

    expect(result.requestId).toBe('r2');
    expect(onRetry).toHaveBeenCalledTimes(1);
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

describe('progress reporting', () => {
  it('reports a wait through a caller-supplied onRetry rather than stderr', async () => {
    const seen: string[] = [];
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let polls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input).endsWith('/requests')) return fakeResponse({ ok: true, status: 200, body: { request_id: 'r1', status: 'queued' } });
      polls += 1;
      return polls < 3
        ? fakeResponse({ ok: true, status: 200, body: { request_id: 'r1', status: 'queued' } })
        : fakeResponse({ ok: true, status: 200, body: { request_id: 'r1', status: 'success', outcome: { ok: true } } });
    });

    const outcome = await submitRequest('m', {}, {
      pollIntervalMs: 1,
      pollTimeoutMs: 5_000,
      onRetry: (_a, _w, reason) => seen.push(reason),
    });

    expect(outcome.outcome).toEqual({ ok: true });
    expect(seen).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });
});
