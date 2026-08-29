import { readGmiKey } from './gmi.js';

/**
 * HTTP driver for GMI Cloud's request-queue API (used by TTS, music, and video models alike —
 * not OpenAI-compatible). Kept separate from `gmi.ts`'s chat-completions client because the
 * request/response shape and the submit-then-poll lifecycle are entirely different. Reuses
 * `gmi.ts`'s `readGmiKey()` so the key lookup/never-log behavior stays in one place.
 */

const DEFAULT_BASE_URL = 'https://console.gmicloud.ai/api/v1/ie/requestqueue/apikey/requests';

const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_INITIAL_BACKOFF_MS = 3_000;
const DEFAULT_MAX_BACKOFF_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;
/**
 * A request still queued after the poll window is treated as lost rather than slow: the queue
 * gives no way to distinguish the two, and resubmitting is the only move that can still finish.
 */
const DEFAULT_MAX_RESUBMITS = 2;
const RETRYABLE_STATUSES = new Set([429, 503]);

export type QueueStatus = 'success' | 'failed' | 'queued' | 'processing' | 'cancelled';

export interface QueueResponse {
  request_id: string;
  status: QueueStatus;
  outcome?: unknown;
  error?: string;
}

export interface QueueOutcome {
  requestId: string;
  outcome: unknown;
}

export interface QueueOptions {
  baseUrl?: string;
  maxRetries?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** How many times a request that never settles may be submitted again. */
  maxResubmits?: number;
  onRetry?: (attempt: number, waitMs: number, reason: string) => void;
}

/** Submits a queue request, retrying transient 429/503 responses and stalled requests, then polls until it settles. */
export async function submitRequest(
  model: string,
  payload: Record<string, unknown>,
  options: QueueOptions = {},
): Promise<QueueOutcome> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const key = readGmiKey();

  const maxResubmits = options.maxResubmits ?? DEFAULT_MAX_RESUBMITS;

  for (let resubmit = 0; ; resubmit++) {
    const submitted = await postWithRetry(baseUrl, key, { model, payload }, options);
    if (submitted.status === 'success') return { requestId: submitted.request_id, outcome: submitted.outcome };
    if (submitted.status === 'failed') throw new Error(queueErrorMessage(submitted));

    try {
      return await pollUntilSettled(baseUrl, key, submitted.request_id, options);
    } catch (err) {
      if (!(err instanceof QueueStalledError) || resubmit >= maxResubmits) throw err;
      const waitMs = backoffMs(resubmit, options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS, options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS);
      options.onRetry?.(resubmit + 1, waitMs, err.message);
      await sleep(waitMs);
    }
  }
}

/** Thrown when a request never leaves the queue, which `submitRequest` answers by submitting again. */
class QueueStalledError extends Error {}

async function postWithRetry(
  baseUrl: string,
  key: string,
  body: { model: string; payload: Record<string, unknown> },
  options: QueueOptions,
): Promise<QueueResponse> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
  const maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;

  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`GMI queue request failed: ${errMessage(err)}`);
    }

    if (response.ok) return (await response.json()) as QueueResponse;

    if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
      const text = await response.text();
      const waitMs = backoffMs(attempt, initialBackoffMs, maxBackoffMs);
      options.onRetry?.(attempt + 1, waitMs, `HTTP ${response.status} — ${text.slice(0, 200)}`);
      await sleep(waitMs);
      attempt += 1;
      continue;
    }

    const text = await response.text();
    throw new Error(`GMI queue request failed: HTTP ${response.status} ${response.statusText} — ${text.slice(0, 500)}`);
  }
}

async function pollUntilSettled(
  baseUrl: string,
  key: string,
  requestId: string,
  options: QueueOptions,
): Promise<QueueOutcome> {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = options.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const deadline = Date.now() + pollTimeoutMs;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new QueueStalledError(`GMI queue request ${requestId} did not settle within ${pollTimeoutMs}ms`);
    }
    await sleep(pollIntervalMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/${requestId}`, {
        headers: { authorization: `Bearer ${key}` },
      });
    } catch (err) {
      throw new Error(`GMI queue poll failed: ${errMessage(err)}`);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GMI queue poll failed: HTTP ${response.status} ${response.statusText} — ${text.slice(0, 500)}`);
    }

    const polled = (await response.json()) as QueueResponse;
    if (polled.status === 'success') return { requestId, outcome: polled.outcome };
    if (polled.status === 'failed') throw new Error(queueErrorMessage(polled));
    if (polled.status === 'cancelled') throw new Error(`GMI queue request ${requestId} was cancelled`);
  }
}

function queueErrorMessage(response: QueueResponse): string {
  return `GMI queue request ${response.request_id} failed: ${response.error ?? 'no error message returned'}`;
}

function backoffMs(attempt: number, initialMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, initialMs * 2 ** attempt);
  const jitter = exponential * (0.5 + Math.random() * 0.5);
  return Math.round(Math.min(maxMs, jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
