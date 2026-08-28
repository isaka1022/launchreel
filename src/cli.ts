#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseCast } from './ingest/cast.js';
import { parseTape } from './ingest/tape.js';
import type { Evidence, EvidenceKind, Recording } from './ingest/types.js';
import { reelSchema, totalDurationSec, validateReel, type Reel } from './timeline/schema.js';
import { compressToFit, DEFAULT_MAX_ATEMPO, fitReel, type FitReport, type FitTier, type LineFit } from './timeline/fit.js';
import { buildOtio, otioToJson } from './emit/otio.js';
import { assembleReel } from './emit/assemble.js';
import { formatZodIssues } from './report.js';
import { designReel, type DesignResult } from './understand/m3.js';
import { rewriteLines } from './understand/rewrite.js';
import { synthesizeLines, type SpeechProvider, type SynthesizedLine } from './order/speech.js';
import { generateTracks, type GeneratedTrack } from './order/music.js';
import { CACHE_DIR_NAME } from './order/media.js';
import { analyzeTrack } from './order/analysis.js';
import { chooseBestTrack, scoreTrack, snapReel, type TrackAnalysis, type TrackScore } from './timeline/snap.js';
import { renderShots } from './render/index.js';

/**
 * CLI entry point. Each subcommand's logic lives in a pure `run*` function (argv in,
 * stdout/stderr/exitCode out) so tests can exercise them without spawning a process.
 */

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const USAGE = `launchreel — turn a terminal recording into an editable video timeline

Usage:
  launchreel ingest <file> [-o <out.json>]
  launchreel plan <recording.json|.cast|.tape> [-o <out.json>] [--duration <sec>] [--lang en|ja] [--allow-generated]
  launchreel fit <reel.json> [-o <out.json>] [--report <report.json>] [--compress]
  launchreel narrate <reel.json> [-o <out.json>] [--provider minimax|system] [--lang en|ja] [--out-dir <dir>]
  launchreel score <reel.json> [-o <out.json>] [--candidates <n>] [--out-dir <dir>] [--offline]
  launchreel emit <reel.json> [--otio <out.otio>] [--fps <n>]
  launchreel build <recording.cast|.tape|dir> [-o <out-dir>] [--duration <sec>] [--lang en|ja] [--provider minimax|system] [--offline] [--skip-music]
  launchreel --help
`;

const USAGE_INGEST = 'usage: launchreel ingest <file> [-o <out.json>]';
const USAGE_PLAN =
  'usage: launchreel plan <recording.json|.cast|.tape> [-o <out.json>] [--duration <sec>] [--lang en|ja] [--allow-generated]';
const USAGE_FIT = 'usage: launchreel fit <reel.json> [-o <out.json>] [--report <report.json>] [--compress]';
const USAGE_NARRATE =
  'usage: launchreel narrate <reel.json> [-o <out.json>] [--provider minimax|system] [--lang en|ja] [--out-dir <dir>]';
const USAGE_SCORE = 'usage: launchreel score <reel.json> [-o <out.json>] [--candidates <n>] [--out-dir <dir>] [--offline]';
const USAGE_EMIT = 'usage: launchreel emit <reel.json> [--otio <out.otio>] [--fps <n>]';
const USAGE_BUILD =
  'usage: launchreel build <recording.cast|.tape|dir> [-o <out-dir>] [--duration <sec>] [--lang en|ja] [--provider minimax|system] [--offline] [--skip-music]';
const DEFAULT_NARRATE_OUT_DIR = '.launchreel/vo';
const DEFAULT_MUSIC_OUT_DIR = '.launchreel/music';
const DEFAULT_BUILD_OUT_DIR = '.launchreel/build';
const DEFAULT_MUSIC_CANDIDATES = 3;

const EVIDENCE_KIND_ORDER: EvidenceKind[] = ['command', 'output', 'pause', 'annotation'];

export async function main(argv: string[]): Promise<CommandResult> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return { stdout: '', stderr: USAGE, exitCode: 1 };
  if (cmd === '-h' || cmd === '--help') return { stdout: USAGE, stderr: '', exitCode: 0 };
  if (cmd === 'ingest') return runIngest(rest);
  if (cmd === 'plan') return runPlan(rest);
  if (cmd === 'fit') return runFit(rest);
  if (cmd === 'narrate') return runNarrate(rest);
  if (cmd === 'score') return runScore(rest);
  if (cmd === 'emit') return runEmit(rest);
  if (cmd === 'build') return runBuild(rest);
  return { stdout: '', stderr: `unknown command "${cmd}"\n\n${USAGE}`, exitCode: 1 };
}

export function runIngest(argv: string[]): CommandResult {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: { o: { type: 'string', short: 'o' } },
      allowPositionals: true,
    });

    const file = positionals[0];
    if (file === undefined) return errorResult(USAGE_INGEST);

    const content = readFileSync(file, 'utf8');
    const ext = extname(file).toLowerCase();
    if (ext !== '.cast' && ext !== '.tape') {
      return errorResult(`unsupported file extension "${ext}": expected .cast or .tape`);
    }

    const recording = ext === '.cast' ? parseCast(content) : parseTape(content);
    const castVersion = ext === '.cast' ? detectCastVersion(content) : undefined;
    const json = `${JSON.stringify(recording, null, 2)}\n`;
    const stderr = ingestSummary(file, recording, castVersion);

    if (values.o !== undefined) {
      writeFileSync(values.o, json);
      return { stdout: '', stderr, exitCode: 0 };
    }
    return { stdout: json, stderr, exitCode: 0 };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

export async function runPlan(argv: string[]): Promise<CommandResult> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        o: { type: 'string', short: 'o' },
        duration: { type: 'string' },
        lang: { type: 'string' },
        'allow-generated': { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });

    const file = positionals[0];
    if (file === undefined) return errorResult(USAGE_PLAN);

    const lang = values.lang ?? 'en';
    if (lang !== 'en' && lang !== 'ja') return errorResult(`invalid --lang value "${lang}": expected "en" or "ja"`);

    let targetDurationSec: number | undefined;
    if (values.duration !== undefined) {
      const parsed = Number(values.duration);
      if (!Number.isFinite(parsed) || parsed <= 0) return errorResult(`invalid --duration value "${values.duration}"`);
      targetDurationSec = parsed;
    }

    const recording = readRecording(file);
    const result = await designReel(recording, {
      targetDurationSec,
      language: lang,
      allowGenerated: values['allow-generated'] === true,
    });

    const json = `${JSON.stringify(result.reel, null, 2)}\n`;
    const stderr = planSummary(result);

    if (values.o !== undefined) {
      writeFileSync(values.o, json);
      return { stdout: '', stderr, exitCode: 0 };
    }
    return { stdout: json, stderr, exitCode: 0 };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

/**
 * Seconds of real footage behind each shot, so the fitter knows how much of a stretched shot
 * has to be filled with a held frame. Shots with no recording behind them (cards, stills) are
 * absent from the map and are free to take any length.
 */
function footageByShot(reel: Reel): Map<string, number> {
  const available = new Map<string, number>();
  for (const shot of reel.shots) {
    if (shot.evidenceRange) available.set(shot.id, shot.evidenceRange[1] - shot.evidenceRange[0]);
  }
  return available;
}

export function runFit(argv: string[]): CommandResult {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        o: { type: 'string', short: 'o' },
        report: { type: 'string' },
        compress: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });

    const file = positionals[0];
    if (file === undefined) return errorResult(USAGE_FIT);

    const reel = readReel(file);
    const originalTotal = totalDurationSec(reel);
    const fit = fitReel(reel, { availableSec: footageByShot(reel) });
    const report = values.compress === true ? compressToFit(fit.report) : fit.report;
    const outJson = `${JSON.stringify(fit.reel, null, 2)}\n`;

    if (values.o !== undefined) writeFileSync(values.o, outJson);
    if (values.report !== undefined) writeFileSync(values.report, `${JSON.stringify(report, null, 2)}\n`);

    return { stdout: values.o !== undefined ? '' : outJson, stderr: fitSummary(report, originalTotal), exitCode: 0 };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

export async function runNarrate(argv: string[]): Promise<CommandResult> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        o: { type: 'string', short: 'o' },
        provider: { type: 'string' },
        lang: { type: 'string' },
        'out-dir': { type: 'string' },
      },
      allowPositionals: true,
    });

    const file = positionals[0];
    if (file === undefined) return errorResult(USAGE_NARRATE);

    const provider = values.provider ?? 'minimax';
    if (provider !== 'minimax' && provider !== 'system') {
      return errorResult(`invalid --provider value "${provider}": expected "minimax" or "system"`);
    }

    const lang = values.lang ?? 'en';
    if (lang !== 'en' && lang !== 'ja') return errorResult(`invalid --lang value "${lang}": expected "en" or "ja"`);

    const outDir = values['out-dir'] ?? DEFAULT_NARRATE_OUT_DIR;

    const reel = readReel(file);
    const synthesized = await synthesizeLines(reel.narration, { provider, language: lang, outDir });
    const measured = new Map(synthesized.map((s) => [s.lineId, s.durationSec]));
    const { reel: fittedReel, report } = fitReel(reel, { availableSec: footageByShot(reel), measured });

    const outJson = `${JSON.stringify(fittedReel, null, 2)}\n`;
    if (values.o !== undefined) writeFileSync(values.o, outJson);

    return {
      stdout: values.o !== undefined ? '' : outJson,
      stderr: narrateSummary(synthesized, report),
      exitCode: 0,
    };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

export async function runScore(argv: string[]): Promise<CommandResult> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        o: { type: 'string', short: 'o' },
        candidates: { type: 'string' },
        'out-dir': { type: 'string' },
        offline: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });

    const file = positionals[0];
    if (file === undefined) return errorResult(USAGE_SCORE);

    const count = values.candidates !== undefined ? Number(values.candidates) : DEFAULT_MUSIC_CANDIDATES;
    if (!Number.isFinite(count) || count <= 0) return errorResult(`invalid --candidates value "${values.candidates}"`);

    const reel = readReel(file);
    const result = await scoreReel(reel, {
      outDir: values['out-dir'] ?? DEFAULT_MUSIC_OUT_DIR,
      count,
      offline: values.offline === true,
    });

    const outJson = `${JSON.stringify(result.reel, null, 2)}\n`;
    if (values.o !== undefined) {
      writeFileSync(values.o, outJson);
      writeFileSync(`${values.o}.music.json`, `${JSON.stringify(musicSidecar(result), null, 2)}\n`);
    }

    return {
      stdout: values.o !== undefined ? '' : outJson,
      stderr: scoreSummary(result),
      exitCode: 0,
    };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

interface ScoredCandidate {
  index: number;
  track: GeneratedTrack;
  analysis: TrackAnalysis;
  score: TrackScore;
}

interface ScoreOptions {
  outDir: string;
  count: number;
  offline: boolean;
}

interface ScoreResult {
  reel: Reel;
  candidates: ScoredCandidate[];
  selected: ScoredCandidate;
  /** The selected track's score after snapping, so alignments carry whether the cut moved. */
  snapped: TrackScore;
}

/** Shared by `score` and `build`: generate candidates, measure each, pick the best, snap cuts to it. */
async function scoreReel(reel: Reel, options: ScoreOptions): Promise<ScoreResult> {
  if (!reel.music) throw new Error('reel has no "music" spec — nothing to score');

  const tracks = await generateTracks(reel.music, {
    outDir: options.outDir,
    count: options.count,
    format: 'mp3',
    offline: options.offline,
  });
  const candidates: ScoredCandidate[] = [];
  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i]!;
    const analysis = await analyzeTrack(track.path, options.offline ?? false);
    candidates.push({ index: i + 1, track, analysis, score: scoreTrack(reel.hitPoints, analysis) });
  }

  const chosen = chooseBestTrack(candidates, reel.hitPoints);
  if (!chosen) throw new Error('score: no music candidates to choose from');

  const { reel: snappedReel, score: snapped } = snapReel(reel, chosen.track.analysis);
  return { reel: snappedReel, candidates, selected: chosen.track, snapped };
}

function musicSidecar(result: ScoreResult): { path: string; durationSec: number; prompt?: string } {
  return { path: result.selected.track.path, durationSec: result.selected.track.durationSec, prompt: result.selected.track.prompt };
}

function scoreSummary(result: ScoreResult): string {
  const lines: string[] = [`score: ${plural(result.candidates.length, 'candidate')}`];
  for (const candidate of result.candidates) {
    const selectedMark = candidate.index === result.selected.index ? '   <- selected' : '';
    lines.push(
      `  track ${candidate.index}   ${candidate.score.hits}/${candidate.score.total} hits   ` +
        `shift ${formatSec(candidate.score.totalShiftSec)}s   ${candidate.analysis.tempo.toFixed(1)} BPM${selectedMark}`,
    );
  }
  lines.push(`  snapped hit points: [${result.reel.hitPoints.map((h) => formatSec(h)).join(', ')}]`);
  return `${lines.join('\n')}\n`;
}

export function runEmit(argv: string[]): CommandResult {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        otio: { type: 'string' },
        fps: { type: 'string' },
      },
      allowPositionals: true,
    });

    const file = positionals[0];
    if (file === undefined) return errorResult(USAGE_EMIT);

    let reel = readReel(file);
    if (values.fps !== undefined) {
      const fps = Number(values.fps);
      if (!Number.isFinite(fps) || fps <= 0) return errorResult(`invalid --fps value "${values.fps}"`);
      reel = { ...reel, fps };
    }

    const outPath = values.otio ?? `${basename(file).replace(/\.json$/, '')}.otio`;
    const doc = buildOtio(reel);
    writeFileSync(outPath, otioToJson(doc));

    return { stdout: '', stderr: emitSummary(outPath, doc), exitCode: 0 };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

export async function runBuild(argv: string[]): Promise<CommandResult> {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        o: { type: 'string', short: 'o' },
        duration: { type: 'string' },
        lang: { type: 'string' },
        provider: { type: 'string' },
        offline: { type: 'boolean', default: false },
        'skip-music': { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });

    const input = positionals[0];
    if (input === undefined) return errorResult(USAGE_BUILD);

    const lang = values.lang ?? 'en';
    if (lang !== 'en' && lang !== 'ja') return errorResult(`invalid --lang value "${lang}": expected "en" or "ja"`);

    const provider = values.provider ?? 'system';
    if (provider !== 'minimax' && provider !== 'system') {
      return errorResult(`invalid --provider value "${provider}": expected "minimax" or "system"`);
    }

    let targetDurationSec: number | undefined;
    if (values.duration !== undefined) {
      const parsed = Number(values.duration);
      if (!Number.isFinite(parsed) || parsed <= 0) return errorResult(`invalid --duration value "${values.duration}"`);
      targetDurationSec = parsed;
    }

    const offline = values.offline === true;
    const recordingFile = resolveRecordingFile(input);
    // Keyed to the recording's own directory (not -o) so --offline replays the same cache
    // regardless of where a given invocation writes its output.
    const cacheDir = join(dirname(recordingFile), CACHE_DIR_NAME);
    const outDir = values.o ?? DEFAULT_BUILD_OUT_DIR;
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const stages: string[] = [];
    const recording = readRecording(recordingFile);

    const design = await designReel(recording, { targetDurationSec, language: lang, cacheDir, offline });
    const designedReel = design.reel;
    let reel = designedReel;
    const attemptWord = design.attempts.length === 1 ? 'attempt' : 'attempts';
    stages.push(`plan: ${plural(reel.shots.length, 'shot')} designed in ${design.attempts.length} ${attemptWord}`);

    let synthesized = await synthesizeLines(reel.narration, {
      provider,
      language: lang,
      outDir: join(cacheDir, 'vo'),
      offline,
    });
    let fit = fitReel(reel, { availableSec: footageByShot(reel), measured: measuredFrom(synthesized) });
    reel = fit.reel;
    stages.push(`narrate: ${plural(synthesized.length, 'line')} synthesized (${provider}), total ${formatSec(fit.report.totalDurationSec)}s`);

    const rewrites: RewriteRecord[] = [];
    if (fit.report.needsRewrite) {
      if (offline) {
        stages.push(`rewrite: skipped (offline), ${plural(countTier(fit.report, 'needs-rewrite'), 'line')} still over budget`);
      } else {
        try {
          const requests = fit.report.lines
            .filter((l) => l.tier === 'needs-rewrite')
            .map((l) => rewriteRequestFor(designedReel, l));

          const rewritten = await rewriteLines(designedReel, requests, { language: lang });
          const rewrittenById = new Map(rewritten.map((r) => [r.id, r.text]));

          const newNarration = designedReel.narration.map((line) => {
            const after = rewrittenById.get(line.id);
            if (after === undefined) return line;
            rewrites.push({ id: line.id, before: line.text, after });
            return { ...line, text: after };
          });
          const rewrittenReel: Reel = { ...designedReel, narration: newNarration };

          const reSynthesized = await synthesizeLines(newNarration.filter((l) => rewrittenById.has(l.id)), {
            provider,
            language: lang,
            outDir: join(cacheDir, 'vo'),
            offline,
          });
          synthesized = mergeSynthesized(synthesized, reSynthesized);

          fit = fitReel(rewrittenReel, { availableSec: footageByShot(rewrittenReel), measured: measuredFrom(synthesized) });
          reel = fit.reel;
          stages.push(`rewrite: ${plural(rewrites.length, 'line')} shortened via M3, total ${formatSec(fit.report.totalDurationSec)}s`);
        } catch (err) {
          stages.push(`rewrite: skipped (${errMessage(err)})`);
        }
      }
    }

    if (fit.report.needsRewrite) {
      fit = { reel: fit.reel, report: compressToFit(fit.report, DEFAULT_MAX_ATEMPO) };
      stages.push(`compress: atempo applied (max ${DEFAULT_MAX_ATEMPO}x), ${plural(countTier(fit.report, 'compressed'), 'line')} compressed`);
    }

    let musicPath: string | undefined;
    let scoreResult: ScoreResult | undefined;
    if (values['skip-music'] !== true && reel.music) {
      scoreResult = await scoreReel(reel, { outDir: join(cacheDir, 'music'), count: DEFAULT_MUSIC_CANDIDATES, offline });
      reel = scoreResult.reel;
      musicPath = scoreResult.selected.track.path;
      stages.push(
        `score: ${plural(scoreResult.candidates.length, 'candidate')}, selected track ${scoreResult.selected.index} ` +
          `(${scoreResult.selected.score.hits}/${scoreResult.selected.score.total} hits)`,
      );
    } else {
      stages.push('score: skipped');
    }

    const rendered = await renderShots(reel, { castPath: recordingFile, outDir: join(outDir, 'shots'), fps: reel.fps });
    stages.push(`render: ${plural(reel.shots.length, 'shot')} rendered`);

    const narrationAt = new Map(fit.report.lines.map((l) => [l.lineId, l.atSec]));
    const atempoByLine = atempoByLineId(fit.report.lines);
    const mp4Path = join(outDir, 'reel.mp4');
    const assembled = await assembleReel(reel, {
      shots: rendered,
      narration: synthesized,
      narrationAt,
      atempoByLine,
      musicPath,
      outPath: mp4Path,
      fps: reel.fps,
    });
    stages.push(`assemble: ${formatSec(assembled.durationSec)}s -> ${basename(mp4Path)}`);

    const shotMedia = new Map(reel.shots.map((s) => [s.id, requireRendered(rendered, s.id).path]));
    const narrationMedia = new Map(synthesized.map((s) => [s.lineId, s.path]));
    const narrationDuration = new Map(synthesized.map((s) => [s.lineId, s.durationSec]));
    const otioPath = join(outDir, 'reel.otio');
    const doc = buildOtio(reel, { media: { shotMedia, narrationMedia, musicMedia: musicPath }, narrationAt, narrationDuration });
    writeFileSync(otioPath, otioToJson(doc));
    stages.push(`emit: ${basename(otioPath)}`);

    const reelPath = join(outDir, 'reel.json');
    writeFileSync(reelPath, `${JSON.stringify(reel, null, 2)}\n`);

    const report = buildReport(reel, design, fit.report, rewrites, scoreResult, assembled, mp4Path, otioPath, reelPath, provider);
    writeFileSync(join(outDir, 'reel.report.json'), `${JSON.stringify(report, null, 2)}\n`);

    return { stdout: '', stderr: buildSummary(outDir, stages), exitCode: 0 };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

/** `build` accepts a raw recording, or a directory containing one (`demo.cast` preferred, else the first .cast/.tape found). */
function resolveRecordingFile(input: string): string {
  const stat = statSync(input);
  if (!stat.isDirectory()) return input;

  const entries = readdirSync(input);
  if (entries.includes('demo.cast')) return join(input, 'demo.cast');

  const found = entries.find((e) => e.endsWith('.cast') || e.endsWith('.tape'));
  if (found === undefined) throw new Error(`no .cast or .tape file found in directory "${input}"`);
  return join(input, found);
}

function requireRendered(rendered: Map<string, { path: string; durationSec: number }>, shotId: string): { path: string; durationSec: number } {
  const r = rendered.get(shotId);
  if (!r) throw new Error(`build: shot "${shotId}" was not rendered`);
  return r;
}

interface RewriteRecord {
  id: string;
  before: string;
  after: string;
}

/** `synthesizeLines` output keyed by line id, for feeding back into `fitReel`'s `measured` map. */
function measuredFrom(lines: SynthesizedLine[]): Map<string, number> {
  return new Map(lines.map((s) => [s.lineId, s.durationSec]));
}

/** Replaces re-synthesized entries by line id; lines untouched by a rewrite keep their original audio. */
function mergeSynthesized(original: SynthesizedLine[], updates: SynthesizedLine[]): SynthesizedLine[] {
  const byId = new Map(updates.map((u) => [u.lineId, u]));
  return original.map((line) => byId.get(line.lineId) ?? line);
}

function countTier(report: FitReport, tier: FitTier): number {
  return report.lines.filter((l) => l.tier === tier).length;
}

function atempoByLineId(lines: LineFit[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const line of lines) {
    if (line.tier === 'compressed' && line.atempo !== undefined) map.set(line.lineId, line.atempo);
  }
  return map;
}

function rewriteRequestFor(reel: Reel, line: LineFit): { id: string; text: string; rewriteBudgetChars: number } {
  const narrationLine = reel.narration.find((n) => n.id === line.lineId);
  if (!narrationLine) throw new Error(`rewrite: narration line "${line.lineId}" missing from reel`);
  return { id: line.lineId, text: narrationLine.text, rewriteBudgetChars: line.rewriteBudgetChars ?? 0 };
}

function buildReport(
  reel: Reel,
  design: DesignResult,
  fitReport: FitReport,
  rewrites: RewriteRecord[],
  scoreResult: ScoreResult | undefined,
  assembled: { path: string; durationSec: number },
  mp4Path: string,
  otioPath: string,
  reelPath: string,
  provider: SpeechProvider,
): unknown {
  const tiers: Record<string, number> = {};
  for (const line of fitReport.lines) tiers[line.tier] = (tiers[line.tier] ?? 0) + 1;

  return {
    title: reel.title,
    totalDurationSec: totalDurationSec(reel),
    shots: reel.shots.length,
    plan: { attempts: design.attempts.length },
    narrate: {
      provider,
      lines: fitReport.lines.length,
      speechSec: round3(fitReport.lines.reduce((sum, l) => sum + l.speechSec, 0)),
      tiers,
      rewrites: rewrites.length > 0 ? rewrites : undefined,
    },
    music: scoreResult
      ? {
          selectedTrack: scoreResult.selected.index,
          candidates: scoreResult.candidates.map((c) => ({
            track: c.index,
            tempoBpm: round3(c.analysis.tempo),
            durationSec: round3(c.analysis.durationSec),
            beats: c.analysis.beats.length,
            hits: c.score.hits,
            total: c.score.total,
            totalShiftSec: round3(c.score.totalShiftSec),
          })),
          alignments: scoreResult.snapped.alignments.map((a) => ({
            hitPoint: round3(a.hitPoint),
            beat: a.beat === undefined ? undefined : round3(a.beat),
            shiftSec: a.shiftSec === undefined ? undefined : round3(a.shiftSec),
            status: a.beat === undefined ? 'missed' : a.moved === true ? 'moved-to-beat' : 'already-on-beat',
          })),
          snappedHitPoints: reel.hitPoints.map(round3),
        }
      : undefined,
    mp4: { path: mp4Path, durationSec: assembled.durationSec },
    otio: { path: otioPath },
    reel: { path: reelPath },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function buildSummary(outDir: string, stages: string[]): string {
  const lines = [`build: ${outDir}`, ...stages.map((s) => `  ${s}`)];
  return `${lines.join('\n')}\n`;
}

/** Reads and validates a Reel from disk. Throws a single readable message on any failure. */
function readReel(file: string): Reel {
  const raw = readJsonFile(file);
  const parsed = reelSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid reel in ${file}:\n${formatZodIssues(parsed.error)}`);

  const problems = validateReel(parsed.data);
  if (problems.length > 0) {
    throw new Error(`invalid reel in ${file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }
  return parsed.data;
}

/** Reads a Recording from a .cast/.tape (ingesting it first) or an already-ingested .json file. */
function readRecording(file: string): Recording {
  const ext = extname(file).toLowerCase();
  if (ext === '.cast') return parseCast(readFileSync(file, 'utf8'));
  if (ext === '.tape') return parseTape(readFileSync(file, 'utf8'));
  return readJsonFile(file) as Recording;
}

function planSummary(result: DesignResult): string {
  const attemptWord = result.attempts.length === 1 ? 'attempt' : 'attempts';
  const lines: string[] = [`plan: ${result.reel.shots.length} shots designed in ${result.attempts.length} ${attemptWord}`];
  for (const attempt of result.attempts) {
    if (attempt.problems.length === 0) {
      lines.push(`  attempt ${attempt.attempt}: ok`);
      continue;
    }
    lines.push(`  attempt ${attempt.attempt}: ${plural(attempt.problems.length, 'problem')}`);
    for (const problem of attempt.problems) lines.push(`    - ${problem}`);
  }
  return `${lines.join('\n')}\n`;
}

function readJsonFile(file: string): unknown {
  const content = readFileSync(file, 'utf8');
  try {
    return JSON.parse(content);
  } catch (err) {
    throw new Error(`invalid JSON in ${file}: ${errMessage(err)}`);
  }
}

function ingestSummary(file: string, recording: Recording, castVersion: number | undefined): string {
  const kindLabel = recording.source === 'cast' ? `asciinema v${castVersion ?? '?'}` : 'vhs tape';
  const dims = recording.cols !== undefined && recording.rows !== undefined ? `${recording.cols}x${recording.rows} · ` : '';
  const counts = countByKind(recording.evidence);
  const breakdown = EVIDENCE_KIND_ORDER.filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`)
    .join(', ');

  return (
    `ingested ${basename(file)} (${kindLabel})\n` +
    `  ${formatSec(recording.durationSec)}s · ${dims}${recording.evidence.length} evidence  (${breakdown})\n`
  );
}

function countByKind(evidence: Evidence[]): Record<EvidenceKind, number> {
  const counts: Record<EvidenceKind, number> = { command: 0, output: 0, pause: 0, annotation: 0 };
  for (const e of evidence) counts[e.kind] += 1;
  return counts;
}

/** Peeks at the first non-empty line of a .cast file to report its asciicast version. */
function detectCastVersion(content: string): number | undefined {
  const firstLine = content.split('\n').find((l) => l.trim().length > 0);
  if (firstLine === undefined) return undefined;
  try {
    const header: unknown = JSON.parse(firstLine);
    if (typeof header === 'object' && header !== null && 'version' in header) {
      const version = (header as { version: unknown }).version;
      return typeof version === 'number' ? version : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function fitSummary(report: FitReport, originalTotal: number): string {
  const maxIdLen = Math.max(0, ...report.shots.map((s) => s.shotId.length));

  const tierByShot = new Map<string, FitTier>();
  for (const line of report.lines) {
    const current = tierByShot.get(line.shotId);
    if (current === undefined || tierRank(line.tier) > tierRank(current)) tierByShot.set(line.shotId, line.tier);
  }

  const lines: string[] = [`fit: ${report.shots.length} shots, ${report.lines.length} lines`];
  for (const shot of report.shots) {
    const tier = tierByShot.get(shot.shotId) ?? (shot.durationSec > shot.originalDurationSec ? 'extended' : 'fits');
    lines.push(
      `  ${shot.shotId.padEnd(maxIdLen)}  ${formatSec(shot.originalDurationSec)}s → ${formatSec(shot.durationSec)}s   ${tierLabel(tier)}`,
    );
  }
  lines.push(`  total ${formatSec(originalTotal)}s → ${formatSec(report.totalDurationSec)}s`);

  const rewriteShots = [...tierByShot.entries()].filter(([, t]) => t === 'needs-rewrite').map(([id]) => id);
  lines.push(`  needs rewrite: ${rewriteShots.length > 0 ? rewriteShots.join(', ') : 'none'}`);

  return `${lines.join('\n')}\n`;
}

function narrateSummary(lines: SynthesizedLine[], report: FitReport): string {
  const maxIdLen = Math.max(0, ...lines.map((l) => l.lineId.length));
  const tierByLine = new Map(report.lines.map((l) => [l.lineId, l.tier]));

  const out: string[] = [`narrate: ${plural(lines.length, 'line')} synthesized (${lines[0]?.provider ?? 'n/a'})`];
  for (const line of lines) {
    const tier = tierByLine.get(line.lineId) ?? 'fits';
    out.push(`  ${line.lineId.padEnd(maxIdLen)}  ${formatSec(line.durationSec)}s   ${tierLabel(tier)}`);
  }
  out.push(`  total ${formatSec(report.totalDurationSec)}s`);
  return `${out.join('\n')}\n`;
}

const TIER_ORDER: FitTier[] = ['fits', 'extended', 'compressed', 'held', 'needs-rewrite'];
function tierRank(tier: FitTier): number {
  return TIER_ORDER.indexOf(tier);
}
function tierLabel(tier: FitTier): string {
  return tier === 'needs-rewrite' ? 'needs rewrite' : tier;
}

interface OtioChild {
  source_range: { duration: { value: number; rate: number } };
}
interface OtioTrack {
  name: string;
  children: OtioChild[];
  markers: unknown[];
}
interface OtioTimelineDoc {
  tracks: { children: OtioTrack[] };
}

function emitSummary(outPath: string, doc: unknown): string {
  const timeline = doc as OtioTimelineDoc;
  const maxNameLen = Math.max('markers'.length, ...timeline.tracks.children.map((t) => t.name.length));

  const lines: string[] = [`emit: ${basename(outPath)}`];
  let markerCount = 0;
  for (const track of timeline.tracks.children) {
    const unit = track.name === 'A1_VO' ? 'item' : 'clip';
    const durationSec = track.children.reduce(
      (sum, c) => sum + c.source_range.duration.value / c.source_range.duration.rate,
      0,
    );
    lines.push(`  ${track.name.padEnd(maxNameLen)}  ${plural(track.children.length, unit)}   ${formatSec(durationSec)}s`);
    markerCount += track.markers.length;
  }
  lines.push(`  ${'markers'.padEnd(maxNameLen)}  ${markerCount}`);

  return `${lines.join('\n')}\n`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Rounds to 2 decimal places, trimming at most one trailing zero (keeps >=1 decimal digit). */
function formatSec(seconds: number): string {
  const fixed = (Math.round(seconds * 100) / 100).toFixed(2);
  return fixed.endsWith('0') ? fixed.slice(0, -1) : fixed;
}

function errorResult(message: string): CommandResult {
  return { stdout: '', stderr: `${message}\n`, exitCode: 1 };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((result) => {
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });
}
