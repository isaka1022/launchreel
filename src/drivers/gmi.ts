import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * HTTP driver for GMI Cloud's OpenAI-compatible chat completions endpoint. Kept separate from
 * `understand/m3.ts` so the design/repair logic stays a pure function of these request/response
 * shapes and can be tested without a network call.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

export interface ChatResponseChoice {
  finish_reason: string;
  message: {
    role: string;
    content: string | null;
    tool_calls?: ToolCall[];
  };
}

export interface ChatResponse {
  choices: ChatResponseChoice[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens?: number };
}

const KEY_ENV_VAR = 'GMI_API_KEY';
const KEY_FILE_PATH = join(homedir(), '.secrets', 'gmi', '.env');
const DEFAULT_BASE_URL = 'https://api.gmi-serving.com/v1';
const DEFAULT_TIMEOUT_MS = 180_000;

/** Reads the GMI API key from the environment, then `~/.secrets/gmi/.env`. Never logs the value. */
export function readGmiKey(): string {
  const fromEnv = process.env[KEY_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;

  const fromFile = readKeyFromEnvFile(KEY_FILE_PATH, KEY_ENV_VAR);
  if (fromFile !== undefined) return fromFile;

  throw new Error(
    `${KEY_ENV_VAR} not set. Export it, or add a line "${KEY_ENV_VAR}=..." to ${KEY_FILE_PATH}.`,
  );
}

function readKeyFromEnvFile(path: string, name: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  const prefix = `${name}=`;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) continue;
    const value = trimmed.slice(prefix.length).trim();
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

export interface ChatCompletionOptions {
  timeoutMs?: number;
  baseUrl?: string;
}

/** POSTs a chat completion request. `body` is caller-shaped (model, messages, tools, ...). */
export async function chatCompletion(body: unknown, options: ChatCompletionOptions = {}): Promise<ChatResponse> {
  const baseUrl = options.baseUrl ?? process.env.GMI_BASE_URL ?? DEFAULT_BASE_URL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = readGmiKey();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${key}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`GMI chat completion timed out after ${timeoutMs}ms`);
    }
    throw new Error(`GMI chat completion request failed: ${errMessage(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GMI chat completion failed: HTTP ${response.status} ${response.statusText} — ${text.slice(0, 500)}`);
  }

  return (await response.json()) as ChatResponse;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
