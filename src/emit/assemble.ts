import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFfmpegFilters, peakLumaInBand, runFfmpeg, runFfmpegCapture } from '../drivers/ffmpeg.js';
import { toSrt, type SubtitleCue } from './subtitles.js';
import { probeDurationSec, probeStreamDurationSec } from '../drivers/probe.js';
import { captionBand, renderCaption, type CaptionPosition } from '../render/caption.js';
import { DEFAULT_BACKGROUND } from '../render/card.js';
import { shotSpans, type Reel, type ShotSpan } from '../timeline/schema.js';
import type { SynthesizedLine } from '../order/speech.js';

/**
 * Builds the final mp4 from rendered shots, narration, and music. The filter-graph string
 * construction is kept in pure functions (no fs/process access) so the tricky parts — xfade
 * offset math, narration delay, loudnorm two-pass — are unit-testable without spawning ffmpeg.
 * `assembleReel` is the only impure entry point: it resolves inputs, spawns ffmpeg, and probes
 * the result.
 */

const DEFAULT_FPS = 30;
const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const DEFAULT_XFADE_SEC = 0.25;
const DEFAULT_MUSIC_FADE_SEC = 1.5;
/** Overlap where one track hands over to the next. Long enough to read as a change, short enough to stay on the cut. */
const DEFAULT_MUSIC_CROSSFADE_SEC = 1.5;
const MIN_XFADE_SEC = 0.02;
const LOUDNESS_TARGET_LUFS = -16;
/** Peak luma above which the band under a caption is taken to hold text the caption would hide. */
const OCCUPIED_LUMA = 120;
/**
 * Where the music bed sits before ducking. Music 3.0 masters its tracks about as loud as the
 * synthesized narration, so mixing the two as they arrive buries the voice — and the ducking
 * compressor cannot rescue it, because a bed that loud never leaves the voice room even at full
 * gain reduction. Levelling the bed here is what makes ducking meaningful: it lands the music
 * around the compressor's threshold, loud enough to carry the passages with no narration over
 * them, quiet enough that a line of speech pushes it down and out of the way.
 */
const MUSIC_BED_LUFS = -20;
const LOUDNESS_TARGET_TP = -1.5;
const LOUDNESS_TARGET_LRA = 11;

/**
 * `loudnorm` resamples to 192 kHz internally, and the AAC encoder then clamps that to its own
 * 96 kHz ceiling. Every stage that touches audio is pinned here so the output lands at a rate
 * players actually expect.
 */
const AUDIO_SAMPLE_RATE = 48000;

/** How far the assembled mp4's probed duration may drift from the crossfade-adjusted expectation. */
export const DURATION_TOLERANCE_SEC = 0.2;

export interface MusicPlacement {
  path: string;
  startSec: number;
}

export interface AssembleOptions {
  shots: Map<string, { path: string; durationSec: number }>;
  narration?: SynthesizedLine[];
  narrationAt?: Map<string, number>;
  /** Narration text by line id. Given both, subtitles are written and burned in. */
  narrationText?: Map<string, string>;
  /** Where to write the SRT. The same cues are burned into the picture. */
  subtitlePath?: string;
  /** Per-line atempo (>1 speeds up); comes from fit's 'compressed' tier. Applied before adelay. */
  atempoByLine?: Map<string, number>;
  /** Tracks laid end to end, in order. `startSec` is on the reel's nominal (pre-crossfade) timeline. */
  music?: MusicPlacement[];
  outPath: string;
  fps?: number;
  width?: number;
  height?: number;
  xfadeDurationSec?: number;
  onProgress?: (stage: string) => void;
}

/**
 * Actual on-timeline start of each shot once neighboring crossfades have eaten into it.
 * `starts[0] = 0`; each later shot starts `xfadeSec` before the previous one would otherwise end.
 */
export function shotStartOffsets(durations: number[], xfadeSec: number): number[] {
  const starts: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < durations.length; i++) {
    if (i === 0) {
      starts.push(0);
      cumulative = durations[0]!;
      continue;
    }
    starts.push(cumulative - xfadeSec);
    cumulative = cumulative + durations[i]! - xfadeSec;
  }
  return starts;
}

/** Total assembled length: the naive sum, minus one crossfade's worth of overlap per shot boundary. */
export function expectedAssembledDurationSec(durations: number[], xfadeSec: number): number {
  if (durations.length === 0) return 0;
  const total = durations.reduce((sum, d) => sum + d, 0);
  return durations.length === 1 ? total : total - (durations.length - 1) * xfadeSec;
}

/** Shrinks the crossfade so it never eats more than half of either neighboring shot. */
export function clampXfade(xfadeSec: number, durations: number[]): number {
  if (durations.length <= 1 || xfadeSec <= 0) return 0;
  let maxAllowed = Infinity;
  for (let i = 1; i < durations.length; i++) {
    maxAllowed = Math.min(maxAllowed, durations[i - 1]! / 2, durations[i]! / 2);
  }
  return Math.max(0, Math.min(xfadeSec, maxAllowed));
}

interface FilterChain {
  filter: string;
  label?: string;
}

/**
 * Per-input `scale+pad+fps` normalization followed by a chained crossfade (or a hard-cut
 * `concat` when the crossfade has been clamped to ~0). `xfadeSec` below {@link MIN_XFADE_SEC}
 * falls back to `concat` because `xfade` with a ~0 duration is a needless extra filter node.
 */
export function videoFilterChain(
  shotCount: number,
  durations: number[],
  opts: {
    width: number;
    height: number;
    fps: number;
    background: string;
    xfadeSec: number;
    /** Per shot, pixels along the bottom the picture must stay out of. Zero (or absent) fills the frame. */
    reserveBottom?: number[];
  },
): FilterChain {
  const { width, height, fps, background, xfadeSec } = opts;
  const parts: string[] = [];
  for (let i = 0; i < shotCount; i++) {
    const reserve = opts.reserveBottom?.[i] ?? 0;
    const fitHeight = height - reserve;
    parts.push(
      `[${i}:v]scale=${width}:${fitHeight}:force_original_aspect_ratio=decrease,` +
        `pad=${width}:${height}:(ow-iw)/2:(${fitHeight}-ih)/2:color=${background},setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
  }
  if (shotCount === 1) return { filter: parts.join(';'), label: 'v0' };

  if (xfadeSec < MIN_XFADE_SEC) {
    const labels = Array.from({ length: shotCount }, (_, i) => `[v${i}]`).join('');
    parts.push(`${labels}concat=n=${shotCount}:v=1:a=0[vout]`);
    return { filter: parts.join(';'), label: 'vout' };
  }

  const starts = shotStartOffsets(durations, xfadeSec);
  let cur = 'v0';
  for (let i = 1; i < shotCount; i++) {
    const next = `vx${i}`;
    parts.push(`[${cur}][v${i}]xfade=transition=fade:duration=${xfadeSec.toFixed(3)}:offset=${starts[i]!.toFixed(3)}[${next}]`);
    cur = next;
  }
  return { filter: parts.join(';'), label: cur };
}

export interface CaptionOverlay {
  /** Full-frame transparent PNG holding one line of text, already positioned. */
  inputIndex: number;
  startSec: number;
  endSec: number;
}

/**
 * Composites caption images over the cut video, each visible only while its line is being spoken.
 * A still image input keeps yielding its last frame, so one PNG per line covers any span.
 */
export function captionOverlayChain(baseLabel: string | undefined, overlays: CaptionOverlay[]): FilterChain {
  if (baseLabel === undefined || overlays.length === 0) return { filter: '', label: baseLabel };

  const stages: string[] = [];
  let previous = baseLabel;
  overlays.forEach((overlay, i) => {
    const label = `videosub${i}`;
    stages.push(
      `[${previous}][${overlay.inputIndex}:v]overlay=0:0:enable='between(t,${overlay.startSec.toFixed(3)},${overlay.endSec.toFixed(3)})'[${label}]`,
    );
    previous = label;
  });
  return { filter: stages.join(';'), label: previous };
}

export interface NarrationInput {
  inputIndex: number;
  delayMs: number;
  /** Speed-up factor (>1) to apply before the delay, so the sped-up clip still lands on time. */
  atempo?: number;
}

/** Delays each narration clip to its resolved start time, then sums them into one bus. */
export function narrationFilterChain(inputs: NarrationInput[]): FilterChain {
  if (inputs.length === 0) return { filter: '' };
  const parts: string[] = [];
  const labels: string[] = [];
  inputs.forEach((input, i) => {
    const label = `narr${i}`;
    const atempoFilter = input.atempo !== undefined ? `atempo=${input.atempo.toFixed(3)},` : '';
    parts.push(
      `[${input.inputIndex}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,` +
        `${atempoFilter}adelay=delays=${input.delayMs}|${input.delayMs}[${label}]`,
    );
    labels.push(`[${label}]`);
  });
  if (labels.length === 1) return { filter: parts.join(';'), label: 'narr0' };
  parts.push(`${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0[narrmix]`);
  return { filter: parts.join(';'), label: 'narrmix' };
}

/** Trims/pads music to the reel's assembled length and fades its head and tail. */
export function musicFilterChain(
  inputIndex: number,
  targetDurationSec: number,
  fadeSec: number,
  bedGain?: string,
): FilterChain {
  const fade = Math.max(0, Math.min(fadeSec, targetDurationSec / 2));
  const level = bedGain === undefined ? '' : `${bedGain},`;
  const filter =
    `[${inputIndex}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,${level}` +
    `apad=whole_dur=${targetDurationSec.toFixed(3)}s,atrim=0:${targetDurationSec.toFixed(3)},` +
    `afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${(targetDurationSec - fade).toFixed(3)}:d=${fade.toFixed(3)}[musicraw]`;
  return { filter, label: 'musicraw' };
}

export interface MusicInput {
  inputIndex: number;
  /** On-timeline seconds this track is responsible for, before any crossfade overlap. */
  durationSec: number;
}

/**
 * Lays several tracks end to end with a crossfade at each handover. Every track but the last is
 * padded to its own span *plus* one crossfade, because `acrossfade` consumes that overlap from the
 * outgoing track — so the fade begins exactly on the cut the handover was planned for, and the
 * chain still totals `targetDurationSec`.
 */
export function crossfadedMusicFilterChain(
  inputs: MusicInput[],
  targetDurationSec: number,
  fadeSec: number,
  crossfadeSec: number,
  bedGains: string[] = [],
): FilterChain {
  const crossfade = Math.max(0, Math.min(crossfadeSec, ...inputs.map((i) => i.durationSec / 2)));
  const parts: string[] = [];

  inputs.forEach((input, i) => {
    const span = i === inputs.length - 1 ? input.durationSec : input.durationSec + crossfade;
    const level = bedGains[i] === undefined ? '' : `${bedGains[i]},`;
    parts.push(
      `[${input.inputIndex}:a]aformat=sample_rates=${AUDIO_SAMPLE_RATE}:channel_layouts=stereo,${level}` +
        `apad=whole_dur=${span.toFixed(3)}s,atrim=0:${span.toFixed(3)}[mus${i}]`,
    );
  });

  let cur = 'mus0';
  for (let i = 1; i < inputs.length; i++) {
    const next = `musx${i}`;
    parts.push(`[${cur}][mus${i}]acrossfade=d=${crossfade.toFixed(3)}:c1=tri:c2=tri[${next}]`);
    cur = next;
  }

  const fade = Math.max(0, Math.min(fadeSec, targetDurationSec / 2));
  parts.push(
    `[${cur}]apad=whole_dur=${targetDurationSec.toFixed(3)}s,atrim=0:${targetDurationSec.toFixed(3)},` +
      `afade=t=in:st=0:d=${fade.toFixed(3)},afade=t=out:st=${(targetDurationSec - fade).toFixed(3)}:d=${fade.toFixed(3)}[musicraw]`,
  );
  return { filter: parts.join(';'), label: 'musicraw' };
}

/** On-timeline span each track covers: up to the next track's start, or the end of the reel. */
export function musicSpans(startSecs: number[], totalDurationSec: number): number[] {
  return startSecs.map((startSec, i) => (startSecs[i + 1] ?? totalDurationSec) - startSec);
}

/** Index of the shot playing at `atSec`, so a nominal time can be shifted by the crossfades before it. */
export function shotIndexAtSec(spans: ShotSpan[], atSec: number): number {
  const index = spans.findIndex((span) => atSec >= span.start && atSec < span.end);
  return index === -1 ? Math.max(0, spans.length - 1) : index;
}

export interface NarrationInterval {
  start: number;
  end: number;
}

/**
 * Ducks music under narration, then mixes the two buses. Prefers `sidechaincompress` (a real
 * compressor keyed off narration level); falls back to a `volume` envelope gated on the known
 * narration intervals when this ffmpeg build lacks it. Either music or narration may be absent.
 */
export function duckAndMix(
  musicLabel: string | undefined,
  narrLabel: string | undefined,
  hasSidechain: boolean,
  narrationIntervals: NarrationInterval[],
  totalDurationSec: number,
): FilterChain {
  if (musicLabel === undefined && narrLabel === undefined) return { filter: '' };

  const parts: string[] = [];
  const busLabel = mixedBusLabel(musicLabel, narrLabel, hasSidechain, narrationIntervals, totalDurationSec, parts);
  // A reel that ends on a card outlasts its last spoken line, so the bus is padded to the full
  // length: an audio stream that stops short leaves the closing shot in silence.
  parts.push(`[${busLabel}]apad=whole_dur=${totalDurationSec.toFixed(3)}s[audiobus]`);
  return { filter: parts.join(';'), label: 'audiobus' };
}

/** Appends the ducking and mixing stages to `parts` and names the pad the audio ends up on. */
function mixedBusLabel(
  musicLabel: string | undefined,
  narrLabel: string | undefined,
  hasSidechain: boolean,
  narrationIntervals: NarrationInterval[],
  totalDurationSec: number,
  parts: string[],
): string {
  if (musicLabel === undefined) return narrLabel!;
  if (narrLabel === undefined) return musicLabel;

  let duckedLabel = musicLabel;
  // A filtergraph pad can only be consumed once, and sidechaincompress needs the narration bus
  // both as its keying input and again in the final mix — split it into two copies for that path.
  let mixNarrLabel = narrLabel;
  if (hasSidechain) {
    duckedLabel = 'musicducked';
    parts.push(`[${narrLabel}]asplit=2[narrkeyraw][narrmixin]`);
    // sidechaincompress stops when either of its inputs does, so an unpadded key ends the music
    // with the last spoken line and leaves the closing shot in silence.
    parts.push(`[narrkeyraw]apad=whole_dur=${totalDurationSec.toFixed(3)}s[narrkey]`);
    parts.push(`[${musicLabel}][narrkey]sidechaincompress=threshold=0.06:ratio=8:attack=5:release=400:makeup=1[${duckedLabel}]`);
    mixNarrLabel = 'narrmixin';
  } else if (narrationIntervals.length > 0) {
    duckedLabel = 'musicducked';
    const expr = narrationIntervals.map((iv) => `between(t,${iv.start.toFixed(3)},${iv.end.toFixed(3)})`).join('+');
    parts.push(`[${musicLabel}]volume=volume=0.35:enable='${expr}'[${duckedLabel}]`);
  }
  parts.push(`[${duckedLabel}][${mixNarrLabel}]amix=inputs=2:duration=longest:normalize=0[mixedaudio]`);
  return 'mixedaudio';
}

export interface LoudnormStats {
  input_i: string;
  input_tp: string;
  input_lra: string;
  input_thresh: string;
  target_offset: string;
}

function isLoudnormStats(value: unknown): value is LoudnormStats {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.input_i === 'string' &&
    typeof v.input_tp === 'string' &&
    typeof v.input_lra === 'string' &&
    typeof v.input_thresh === 'string' &&
    typeof v.target_offset === 'string'
  );
}

/** Pulls the `loudnorm` analysis-pass JSON block out of ffmpeg's stderr. */
export function parseLoudnormStats(stderr: string): LoudnormStats {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('loudnorm analysis pass produced no readable stats — see ffmpeg stderr above');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stderr.slice(start, end + 1));
  } catch (err) {
    throw new Error(`loudnorm analysis pass produced unparseable JSON: ${errMessage(err)}`);
  }
  if (!isLoudnormStats(parsed)) throw new Error('loudnorm analysis pass produced an unexpected shape');
  return parsed;
}

function loudnormAnalyzeFilter(): string {
  return `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}:print_format=json`;
}

function loudnormApplyFilter(stats: LoudnormStats): string {
  return (
    `loudnorm=I=${LOUDNESS_TARGET_LUFS}:TP=${LOUDNESS_TARGET_TP}:LRA=${LOUDNESS_TARGET_LRA}:` +
    `measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:` +
    `measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true:print_format=summary,` +
    `aresample=${AUDIO_SAMPLE_RATE}`
  );
}

/** A single track has no handover to make, so it takes the simpler chain. */
function buildMusicChain(
  inputBase: number,
  startSecs: number[],
  totalSec: number,
  bedGains: string[],
): FilterChain | undefined {
  if (startSecs.length === 0) return undefined;
  if (startSecs.length === 1) return musicFilterChain(inputBase, totalSec, DEFAULT_MUSIC_FADE_SEC, bedGains[0]);
  const inputs = musicSpans(startSecs, totalSec).map((durationSec, i) => ({ inputIndex: inputBase + i, durationSec }));
  return crossfadedMusicFilterChain(inputs, totalSec, DEFAULT_MUSIC_FADE_SEC, DEFAULT_MUSIC_CROSSFADE_SEC, bedGains);
}

/**
 * Static gain per track that brings a measured loudness to the bed target. Static rather than a
 * `loudnorm` on the bus because a bed that keeps re-normalizing itself breathes against the
 * narration ducking it.
 */
export function musicBedGainFilter(measuredLufs: number, targetLufs = MUSIC_BED_LUFS): string {
  return `volume=${(targetLufs - measuredLufs).toFixed(2)}dB`;
}

async function measureIntegratedLufs(path: string): Promise<number> {
  const { stderr } = await runFfmpegCapture(['-nostdin', '-i', path, '-af', loudnormAnalyzeFilter(), '-f', 'null', '-']);
  return Number(parseLoudnormStats(stderr).input_i);
}

export async function assembleReel(reel: Reel, options: AssembleOptions): Promise<{ path: string; durationSec: number }> {
  if (reel.shots.length === 0) throw new Error('assembleReel: reel has no shots');

  const fps = options.fps ?? DEFAULT_FPS;
  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;

  const shotInputs = reel.shots.map((shot) => {
    const rendered = options.shots.get(shot.id);
    if (!rendered) throw new Error(`assembleReel: no rendered media for shot "${shot.id}" — render it first`);
    return { id: shot.id, path: rendered.path, durationSec: rendered.durationSec };
  });
  const durations = shotInputs.map((s) => s.durationSec);
  const xfadeSec = clampXfade(options.xfadeDurationSec ?? DEFAULT_XFADE_SEC, durations);
  const totalSec = expectedAssembledDurationSec(durations, xfadeSec);

  const inputArgs: string[] = [];
  for (const s of shotInputs) inputArgs.push('-i', s.path);

  options.onProgress?.('video');
  // Footage that fills the frame has nowhere to put a caption — a terminal printing the numbers the
  // narration is reading out is exactly what a caption over it would hide — so with captions on,
  // footage shots keep clear of the caption band and cards, which already do, are left alone.
  const captionsOn = options.subtitlePath !== undefined && options.narrationText !== undefined;
  const bandHeight = height - captionBand({ width, height, position: 'bottom' }).y;
  const reserveBottom = reel.shots.map((shot) => (captionsOn && shot.kind !== 'card' ? bandHeight : 0));
  const videoChain = videoFilterChain(shotInputs.length, durations, {
    width,
    height,
    fps,
    background: DEFAULT_BACKGROUND,
    xfadeSec,
    reserveBottom,
  });

  const shotIndexById = new Map(reel.shots.map((s, i) => [s.id, i]));
  const nominalSpans = shotSpans(reel);
  const narrationLines = options.narration ?? [];

  // `atSec` (from fit.ts) places lines using their pre-compression measured length — compressToFit
  // shrinks a line's *playback* duration but never moves its start. Applying atempo here is safe
  // without touching atSec: the sped-up clip only ends sooner, leaving slack before whatever comes
  // next (itself still placed at its own pre-compression atSec) rather than overlapping it.
  const narrationResolved = narrationLines.map((line) => {
    const meta = reel.narration.find((l) => l.id === line.lineId);
    if (!meta) throw new Error(`assembleReel: narration "${line.lineId}" has no matching line in reel.narration`);
    const shotIndex = shotIndexById.get(meta.shotId);
    if (shotIndex === undefined) throw new Error(`assembleReel: narration "${line.lineId}" references unknown shot "${meta.shotId}"`);
    const nominalAtSec = options.narrationAt?.get(line.lineId) ?? meta.atSec ?? nominalSpans[shotIndex]!.start;
    const actualAtSec = Math.max(0, nominalAtSec - shotIndex * xfadeSec);
    const atempo = options.atempoByLine?.get(line.lineId);
    const durationSec = atempo !== undefined ? line.durationSec / atempo : line.durationSec;
    return { lineId: line.lineId, path: line.path, durationSec, atSec: actualAtSec, atempo };
  });

  const narrationInputBase = shotInputs.length;
  for (const n of narrationResolved) inputArgs.push('-i', n.path);

  const musicInputBase = shotInputs.length + narrationResolved.length;
  const musicPlacements = options.music ?? [];
  const musicStarts = musicPlacements.map((placement) =>
    Math.max(0, placement.startSec - shotIndexAtSec(nominalSpans, placement.startSec) * xfadeSec),
  );
  for (const placement of musicPlacements) inputArgs.push('-i', placement.path);

  const filters = await listFfmpegFilters();
  const hasSidechain = filters.has('sidechaincompress');

  const subtitlePath = options.subtitlePath;
  const cues: SubtitleCue[] =
    subtitlePath !== undefined && options.narrationText !== undefined
      ? narrationResolved
          .map((n) => ({ startSec: n.atSec, endSec: n.atSec + n.durationSec, text: options.narrationText?.get(n.lineId) ?? '' }))
          .filter((cue) => cue.text.length > 0)
          .sort((a, b) => a.startSec - b.startSec)
      : [];
  if (subtitlePath !== undefined) writeFileSync(subtitlePath, toSrt(cues));

  const captionDir = cues.length > 0 ? mkdtempSync(join(tmpdir(), 'launchreel-captions-')) : undefined;
  const captionInputBase = musicInputBase + musicPlacements.length;
  const captionOverlays: CaptionOverlay[] = [];
  if (captionDir !== undefined) {
    for (const [i, cue] of cues.entries()) {
      const position = await captionPosition(cue, shotInputs, durations, xfadeSec, { width, height });
      const path = await renderCaption(cue.text, { outDir: captionDir, width, height, position });
      inputArgs.push('-i', path);
      captionOverlays.push({ inputIndex: captionInputBase + i, startSec: cue.startSec, endSec: cue.endSec });
    }
  }
  const captionChain = captionOverlayChain(videoChain.label, captionOverlays);
  const videoLabel = captionChain.label;

  const narrChain = narrationFilterChain(
    narrationResolved.map((n, i) => ({ inputIndex: narrationInputBase + i, delayMs: Math.round(n.atSec * 1000), atempo: n.atempo })),
  );
  const bedGains = await Promise.all(musicPlacements.map(async (p) => musicBedGainFilter(await measureIntegratedLufs(p.path))));
  const musicChain = buildMusicChain(musicInputBase, musicStarts, totalSec, bedGains);
  const narrationIntervals = narrationResolved.map((n) => ({ start: n.atSec, end: n.atSec + n.durationSec }));
  const mix = duckAndMix(musicChain?.label, narrChain.label, hasSidechain, narrationIntervals, totalSec);

  const audioFilterComplex = [narrChain.filter, musicChain?.filter ?? '', mix.filter].filter((part) => part.length > 0).join(';');
  const filterComplex = [videoChain.filter, captionChain.filter, audioFilterComplex].filter((part) => part.length > 0).join(';');

  try {
    if (mix.label === undefined) {
      options.onProgress?.('render');
      await runFfmpeg([
        '-y',
        ...inputArgs,
        '-filter_complex',
        filterComplex,
        '-map',
        `[${videoLabel}]`,
        '-r',
        String(fps),
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-movflags',
        '+faststart',
        options.outPath,
      ]);
    } else {
      options.onProgress?.('loudnorm-analyze');
      const { stderr } = await runFfmpegCapture([
        ...inputArgs,
        '-filter_complex',
        `${audioFilterComplex};[${mix.label}]${loudnormAnalyzeFilter()}[loudnormanalysis]`,
        '-map',
        '[loudnormanalysis]',
        '-f',
        'null',
        '-',
      ]);
      const stats = parseLoudnormStats(stderr);

      options.onProgress?.('render');
      await runFfmpeg([
        '-y',
        ...inputArgs,
        '-filter_complex',
        `${filterComplex};[${mix.label}]${loudnormApplyFilter(stats)}[aout]`,
        '-map',
        `[${videoLabel}]`,
        '-map',
        '[aout]',
        '-r',
        String(fps),
        '-pix_fmt',
        'yuv420p',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        '-movflags',
        '+faststart',
        options.outPath,
      ]);
    }

    const durationSec = await probeDurationSec(options.outPath);
    // The container reports its longest stream, so an audio bus that ends early hides behind a
    // correct-looking total — which is exactly how the reel once ended in six silent seconds.
    if (mix.label !== undefined) {
      const audioSec = await probeStreamDurationSec(options.outPath, 'a:0');
      if (durationSec - audioSec > DURATION_TOLERANCE_SEC) {
        throw new Error(
          `assembled audio runs ${audioSec.toFixed(2)}s against ${durationSec.toFixed(2)}s of picture — ` +
            'something in the audio graph is ending early',
        );
      }
    }
    if (Math.abs(durationSec - totalSec) > DURATION_TOLERANCE_SEC) {
      throw new Error(
        `assembled reel duration ${durationSec.toFixed(2)}s does not match the expected ${totalSec.toFixed(2)}s ` +
          `(>${DURATION_TOLERANCE_SEC}s off) — check the xfade offset math`,
      );
    }
    return { path: options.outPath, durationSec };
  } finally {
    if (captionDir !== undefined) rmSync(captionDir, { recursive: true, force: true });
  }
}

/**
 * A caption sits at the bottom unless the picture has text there while it is up — a terminal
 * printing the very number the narration is describing, say — in which case it moves to the top.
 * Decided by looking at the frame, not by shot kind: cards have text near the bottom too.
 */
async function captionPosition(
  cue: SubtitleCue,
  shots: { path: string; durationSec: number }[],
  durations: number[],
  xfadeSec: number,
  frame: { width: number; height: number },
): Promise<CaptionPosition> {
  const midSec = (cue.startSec + cue.endSec) / 2;
  const starts = shotStartOffsets(durations, xfadeSec);
  let index = starts.findIndex((start, i) => midSec < start + durations[i]!);
  if (index < 0) index = shots.length - 1;
  const shot = shots[index]!;
  const localSec = Math.min(shot.durationSec - 0.05, Math.max(0, midSec - starts[index]!));
  const norm = { ...frame, background: DEFAULT_BACKGROUND };

  const bottom = await peakLumaInBand(shot.path, localSec, norm, captionBand({ ...frame, position: 'bottom' }));
  if (bottom < OCCUPIED_LUMA) return 'bottom';
  const top = await peakLumaInBand(shot.path, localSec, norm, captionBand({ ...frame, position: 'top' }));
  return top < OCCUPIED_LUMA ? 'top' : 'bottom';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
