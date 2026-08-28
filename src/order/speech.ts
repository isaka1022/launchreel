import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { NarrationLine } from '../timeline/schema.js';
import { submitRequest } from '../drivers/queue.js';
import { probeDurationSec } from '../drivers/probe.js';
import { appendSpend } from './ledger.js';
import { cacheKey, downloadToFile } from './media.js';

/**
 * Synthesizes narration lines to audio and measures their real duration. Two providers share
 * one interface so a reel can be narrated offline (macOS `say`) while MiniMax TTS capacity is
 * exhausted, then re-synthesized with `minimax` later without touching the caller.
 */

const execFileAsync = promisify(execFile);

const TTS_MODEL = 'minimax-tts-speech-2.8-hd';

/** macOS `say`'s roughly-default words-per-minute, used as the base for a `speed` multiplier. */
const SYSTEM_BASE_RATE_WPM = 175;

export type SpeechProvider = 'minimax' | 'system';

const MINIMAX_VOICE_BY_LANGUAGE: Record<'en' | 'ja', string> = {
  en: 'English_expressive_narrator',
  ja: 'Japanese_IntellectualSenior',
};

const SYSTEM_VOICE_BY_LANGUAGE: Record<'en' | 'ja', string> = {
  en: 'Samantha',
  ja: 'Kyoko',
};

export interface SpeechOptions {
  provider?: SpeechProvider;
  language?: 'en' | 'ja';
  voiceId?: string;
  outDir: string;
  /** Per-line speed, keyed by line id. Comes from fit's `compressed` tier. */
  speedByLine?: Map<string, number>;
  /** When true, a cache miss (no file at the deterministic outDir path) is a readable error instead of synthesizing. */
  offline?: boolean;
  onProgress?: (lineId: string, index: number, total: number) => void;
}

export interface SynthesizedLine {
  lineId: string;
  path: string;
  durationSec: number;
  provider: SpeechProvider;
  voiceId?: string;
  speed?: number;
}

export async function synthesizeLines(lines: NarrationLine[], options: SpeechOptions): Promise<SynthesizedLine[]> {
  const provider = options.provider ?? 'minimax';
  const language = options.language ?? 'en';
  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });

  const results: SynthesizedLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const speed = options.speedByLine?.get(line.id);
    const voiceId =
      options.voiceId ?? (provider === 'minimax' ? MINIMAX_VOICE_BY_LANGUAGE[language] : SYSTEM_VOICE_BY_LANGUAGE[language]);

    const result =
      provider === 'minimax'
        ? await synthesizeMinimax(line, voiceId, speed, options.outDir, options.offline ?? false)
        : await synthesizeSystem(line, voiceId, speed, options.outDir, options.offline ?? false);

    results.push(result);
    options.onProgress?.(line.id, i + 1, lines.length);
  }
  return results;
}

interface MinimaxTtsOutcome {
  media_urls?: { url: string }[];
}

async function synthesizeMinimax(
  line: NarrationLine,
  voiceId: string,
  speed: number | undefined,
  outDir: string,
  offline: boolean,
): Promise<SynthesizedLine> {
  const path = join(outDir, `${line.id}-${cacheKey([line.text, voiceId, speed])}.mp3`);
  if (existsSync(path)) {
    return { lineId: line.id, path, durationSec: await probeDurationSec(path), provider: 'minimax', voiceId, speed };
  }
  if (offline) {
    throw new Error(`--offline: no cached narration at ${path}. Run once without --offline to populate the cache.`);
  }

  const payload: Record<string, unknown> = { text: line.text, voice_id: voiceId, format: 'mp3' };
  if (speed !== undefined) payload.speed = speed.toFixed(1);

  const { outcome } = await submitRequest(TTS_MODEL, payload);
  const mediaUrl = (outcome as MinimaxTtsOutcome).media_urls?.[0]?.url;
  if (mediaUrl === undefined) throw new Error(`MiniMax TTS response for line "${line.id}" had no media_urls[0].url`);
  await downloadToFile(mediaUrl, path);
  appendSpend({ model: TTS_MODEL, kind: 'tts', usd: 0, at: new Date().toISOString(), note: line.id });

  return { lineId: line.id, path, durationSec: await probeDurationSec(path), provider: 'minimax', voiceId, speed };
}

async function synthesizeSystem(
  line: NarrationLine,
  voiceId: string,
  speed: number | undefined,
  outDir: string,
  offline: boolean,
): Promise<SynthesizedLine> {
  const path = join(outDir, `${line.id}-${cacheKey([line.text, voiceId, speed])}.aiff`);
  if (existsSync(path)) {
    return { lineId: line.id, path, durationSec: await probeDurationSec(path), provider: 'system', voiceId, speed };
  }
  if (offline) {
    throw new Error(`--offline: no cached narration at ${path}. Run once without --offline to populate the cache.`);
  }
  if (process.platform !== 'darwin') {
    throw new Error('speech provider "system" requires macOS `say` and is not available on this platform');
  }

  const args = ['-v', voiceId, '-o', path];
  if (speed !== undefined) args.push('-r', String(Math.round(SYSTEM_BASE_RATE_WPM * speed)));
  args.push(line.text);

  try {
    await execFileAsync('say', args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('ENOENT')) throw new Error('`say` not found on PATH — provider "system" requires macOS.');
    throw new Error(`say failed for line "${line.id}": ${message}`);
  }

  return { lineId: line.id, path, durationSec: await probeDurationSec(path), provider: 'system', voiceId, speed };
}
