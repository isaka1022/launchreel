import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { MusicSpec } from '../timeline/schema.js';
import { submitRequest } from '../drivers/queue.js';
import { probeDurationSec } from '../drivers/probe.js';
import { appendSpend } from './ledger.js';
import { cacheKey, downloadToFile } from './media.js';

/**
 * Orders instrumental candidate tracks from MiniMax Music 3.0. `snap.ts` (not built here)
 * scores the candidates against `Reel.hitPoints`, so this asks for several at once.
 */

const MUSIC_MODEL = 'minimax-music-3.0';
const MAX_LYRICS_CHARS = 3500;

export interface MusicOptions {
  outDir: string;
  /** Candidates to score against hit points. Default 3. */
  count?: number;
  format?: 'wav' | 'mp3';
  sampleRate?: number;
  /** When true, a cache miss (no file at the deterministic outDir path) is a readable error instead of generating. */
  offline?: boolean;
  onProgress?: (index: number, total: number) => void;
}

export interface GeneratedTrack {
  path: string;
  durationSec: number;
  lyrics: string;
  prompt?: string;
}

/**
 * Music 3.0 has no seed parameter, so identical requests give us nothing to choose between.
 * Each candidate varies the one dimension that actually moves the beat grid: when the pulse
 * arrives and how dense it is. A track whose intro is eleven seconds of pads cannot serve an
 * early hit point, and only generating an alternative gives the measurement a real choice.
 */
const CANDIDATE_DIRECTIONS = [
  '',
  ' Percussion enters within the first bar, no ambient intro.',
  ' Faster, denser pulse with a steady driving beat throughout.',
];

export async function generateTracks(spec: MusicSpec, options: MusicOptions): Promise<GeneratedTrack[]> {
  const count = options.count ?? 3;
  const format = options.format ?? 'wav';
  const sampleRate = options.sampleRate ?? 44100;
  if (!existsSync(options.outDir)) mkdirSync(options.outDir, { recursive: true });

  const tracks: GeneratedTrack[] = [];
  for (let i = 0; i < count; i++) {
    const variant = candidateSpec(spec, i);
    const lyrics = buildInstrumentalLyrics(variant);
    tracks.push(await generateOneTrack(variant, lyrics, format, sampleRate, i, options.outDir, options.offline ?? false));
    options.onProgress?.(i + 1, count);
  }
  return tracks;
}

function candidateSpec(spec: MusicSpec, index: number): MusicSpec {
  const direction = CANDIDATE_DIRECTIONS[index % CANDIDATE_DIRECTIONS.length] ?? '';
  return direction === '' ? spec : { ...spec, caption: `${spec.caption}${direction}` };
}

/**
 * Structure tags carrying only a parenthetical performance direction (no sung words) keep
 * Music 3.0 instrumental — verified against the live API, see spec note on `[Inst]`/`[Intro]`.
 */
function buildInstrumentalLyrics(spec: MusicSpec): string {
  const lyrics = spec.structureTags.map((tag) => `${tag} (instrumental — ${spec.caption})`).join('\n');
  return lyrics.length > MAX_LYRICS_CHARS ? lyrics.slice(0, MAX_LYRICS_CHARS) : lyrics;
}

interface MinimaxMusicOutcome {
  audio_url?: string;
  duration_ms?: number;
  media_urls?: { url: string }[];
}

async function generateOneTrack(
  spec: MusicSpec,
  lyrics: string,
  format: 'wav' | 'mp3',
  sampleRate: number,
  index: number,
  outDir: string,
  offline: boolean,
): Promise<GeneratedTrack> {
  const path = join(outDir, `track-${index}-${cacheKey([lyrics, spec.caption, format, sampleRate, index])}.${format}`);
  if (existsSync(path)) {
    return { path, durationSec: await probeDurationSec(path), lyrics, prompt: spec.caption };
  }
  if (offline) {
    throw new Error(`--offline: no cached music candidate at ${path}. Run once without --offline to populate the cache.`);
  }

  const payload: Record<string, unknown> = { lyrics, prompt: spec.caption, format, sample_rate: sampleRate };
  const { outcome } = await submitRequest(MUSIC_MODEL, payload);
  const parsed = outcome as MinimaxMusicOutcome;
  const url = parsed.audio_url ?? parsed.media_urls?.[0]?.url;
  if (url === undefined) throw new Error(`MiniMax Music response for candidate ${index} had no audio_url or media_urls[0].url`);
  await downloadToFile(url, path);
  appendSpend({ model: MUSIC_MODEL, kind: 'music', usd: 0, at: new Date().toISOString(), note: `candidate ${index}` });

  const durationSec = parsed.duration_ms !== undefined ? parsed.duration_ms / 1000 : await probeDurationSec(path);
  return { path, durationSec, lyrics, prompt: spec.caption };
}
