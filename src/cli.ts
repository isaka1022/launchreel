#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseCast } from './ingest/cast.js';
import { parseTape } from './ingest/tape.js';
import type { Evidence, EvidenceKind, Recording } from './ingest/types.js';
import { reelSchema, totalDurationSec, validateReel, type Reel } from './timeline/schema.js';
import { compressToFit, fitReel, type FitReport, type FitTier } from './timeline/fit.js';
import { buildOtio, otioToJson } from './emit/otio.js';
import { formatZodIssues } from './report.js';
import { designReel, type DesignResult } from './understand/m3.js';
import { synthesizeLines, type SpeechProvider, type SynthesizedLine } from './order/speech.js';

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
  launchreel emit <reel.json> [--otio <out.otio>] [--fps <n>]
  launchreel --help
`;

const USAGE_INGEST = 'usage: launchreel ingest <file> [-o <out.json>]';
const USAGE_PLAN =
  'usage: launchreel plan <recording.json|.cast|.tape> [-o <out.json>] [--duration <sec>] [--lang en|ja] [--allow-generated]';
const USAGE_FIT = 'usage: launchreel fit <reel.json> [-o <out.json>] [--report <report.json>] [--compress]';
const USAGE_NARRATE =
  'usage: launchreel narrate <reel.json> [-o <out.json>] [--provider minimax|system] [--lang en|ja] [--out-dir <dir>]';
const USAGE_EMIT = 'usage: launchreel emit <reel.json> [--otio <out.otio>] [--fps <n>]';
const DEFAULT_NARRATE_OUT_DIR = '.launchreel/vo';

const EVIDENCE_KIND_ORDER: EvidenceKind[] = ['command', 'output', 'pause', 'annotation'];

export async function main(argv: string[]): Promise<CommandResult> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return { stdout: '', stderr: USAGE, exitCode: 1 };
  if (cmd === '-h' || cmd === '--help') return { stdout: USAGE, stderr: '', exitCode: 0 };
  if (cmd === 'ingest') return runIngest(rest);
  if (cmd === 'plan') return runPlan(rest);
  if (cmd === 'fit') return runFit(rest);
  if (cmd === 'narrate') return runNarrate(rest);
  if (cmd === 'emit') return runEmit(rest);
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
