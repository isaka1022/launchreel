#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { activeSpans, readableSpans } from './ingest/activity.js';
import { parseCast } from './ingest/cast.js';
import { footageDurations, isLongFormProject, listFootageFiles, loadFootage, type FootageItem } from './ingest/footage.js';
import { parseTape } from './ingest/tape.js';
import type { TimeSpan } from './ingest/activity.js';
import type { Evidence, EvidenceKind, Recording } from './ingest/types.js';
import {
  footageSecByShot,
  holdWarnings,
  reelSchema,
  reelUsage,
  shotSpans,
  sourceCoverage,
  totalDurationSec,
  validateReel,
  type Reel,
  type ReelUsage,
} from './timeline/schema.js';
import {
  compressToFit,
  DEFAULT_MAX_ATEMPO,
  fitReel,
  motionBreakdown,
  onsetAlignments,
  ONSET_TOLERANCE_SEC,
  extendRangeToShot,
  snapRangeToOnset,
  stretchFootageToShots,
  type MotionBreakdown,
  type SourceTiming,
  type FitReport,
  type FitTier,
  type LineFit,
} from './timeline/fit.js';
import { buildOtio, otioToJson, type MusicSegmentMedia } from './emit/otio.js';
import { assembleReel, type MusicPlacement } from './emit/assemble.js';
import { formatZodIssues } from './report.js';
import { designLongFormReel, designReel, type DesignResult } from './understand/m3.js';
import { rewriteLines } from './understand/rewrite.js';
import { synthesizeLines, type SpeechProvider, type SynthesizedLine } from './order/speech.js';
import { generateTracks, type GeneratedTrack } from './order/music.js';
import { CACHE_DIR_NAME } from './order/media.js';
import { analyzeTrack } from './order/analysis.js';
import { chooseBestTrack, scoreTrack, snapReel, type TrackAnalysis, type TrackScore } from './timeline/snap.js';
import {
  applySegmentReel,
  musicSpecForSegment,
  musicSwitchPoints,
  nextSegmentBoundary,
  segment as buildSegment,
  segmentSubReel,
  tracksCovering,
  type MusicSegment,
} from './timeline/soundtrack.js';
import { renderShots, type SourceMap } from './render/index.js';

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
  launchreel build <dir with pitch.md + footage/> [...]            long-form: a 2-3 minute product video
  launchreel build --pitch <file> --footage <file> [--footage ...] [...]
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
  'usage: launchreel build <recording.cast|.tape|dir> [-o <out-dir>] [--duration <sec>] [--lang en|ja] [--provider minimax|system] [--offline] [--skip-music]\n' +
  '       launchreel build --pitch <pitch.md> --footage <a.cast> [--footage <b.cast> ...] [...]';
const DEFAULT_NARRATE_OUT_DIR = '.launchreel/vo';
const DEFAULT_MUSIC_OUT_DIR = '.launchreel/music';
const DEFAULT_BUILD_OUT_DIR = '.launchreel/build';
const DEFAULT_MUSIC_CANDIDATES = 3;

/** A directory holding these two is a long-form project: the argument, and the footage that backs it. */
const PITCH_FILE_NAME = 'pitch.md';
const FOOTAGE_DIR_NAME = 'footage';
/**
 * Sized to what a handful of terminal recordings can actually carry. Only about a fifth of a
 * terminal session is the screen changing, so asking for longer buys held frames, not content.
 */
const LONG_FORM_DEFAULT_DURATION_SEC = 90;
/** A long reel is only split when no single render reaches its end; a leftover piece shorter than this is not worth its own track. */
const MUSIC_MIN_SEGMENT_SEC = 25;

const EVIDENCE_KIND_ORDER: EvidenceKind[] = ['command', 'output', 'pause', 'annotation'];

/** Long-running commands stream their progress through this instead of returning it at the end. */
export interface RunOptions {
  log?: (line: string) => void;
}

export async function main(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined) return { stdout: '', stderr: USAGE, exitCode: 1 };
  if (cmd === '-h' || cmd === '--help') return { stdout: USAGE, stderr: '', exitCode: 0 };
  if (cmd === 'ingest') return runIngest(rest);
  if (cmd === 'plan') return runPlan(rest);
  if (cmd === 'fit') return runFit(rest);
  if (cmd === 'narrate') return runNarrate(rest);
  if (cmd === 'score') return runScore(rest);
  if (cmd === 'emit') return runEmit(rest);
  if (cmd === 'build') return runBuild(rest, options);
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
    const fit = fitReel(reel, { availableSec: footageSecByShot(reel) });
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
    const { reel: fittedReel, report } = fitReel(reel, { availableSec: footageSecByShot(reel), measured });

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
  /** When true, the reel is covered by several tracks handing over at chapter cards. */
  segmented?: boolean;
}

interface ScoredSegment extends MusicSegment {
  candidates: ScoredCandidate[];
  selected: ScoredCandidate;
  /** The selected track's score after snapping, so alignments carry whether the cut moved. */
  snapped: TrackScore;
}

interface ScoreResult {
  reel: Reel;
  segments: ScoredSegment[];
}

/**
 * Shared by `score` and `build`: generate candidates, measure each, pick the best, snap cuts to it.
 * Music 3.0 cannot be told how long to play, so how much of the reel one track covers is decided by
 * measuring, not by assuming: a second track is only ordered once the longest candidate in hand has
 * been shown not to reach the end. Each track is then scored and snapped against only the cuts it
 * will be playing under. `snapReel` moves boundaries *inside* the slice it is given, so a segment's
 * own length, and every later segment's start, survives the snap untouched.
 */
async function scoreReel(reel: Reel, options: ScoreOptions): Promise<ScoreResult> {
  if (!reel.music) throw new Error('reel has no "music" spec — nothing to score');
  const music = reel.music;

  let current = reel;
  const segments: ScoredSegment[] = [];
  let fromShot = 0;

  while (fromShot < current.shots.length) {
    const totalSec = totalDurationSec(current);
    const startSec = shotSpans(current)[fromShot]?.start ?? 0;
    const index = segments.length;
    const spec = options.segmented === true ? musicSpecForSegment(music, index, totalSec - startSec) : music;

    const tracks = await generateTracks(spec, {
      outDir: options.outDir,
      count: options.count,
      format: 'mp3',
      offline: options.offline,
    });
    const analyses: TrackAnalysis[] = [];
    for (const track of tracks) analyses.push(await analyzeTrack(track.path, options.offline));

    // Reach is the longest candidate's: it decides how far this track can run before a handover.
    const reachSec = Math.max(...analyses.map((a) => a.durationSec));
    const boundary =
      options.segmented === true
        ? nextSegmentBoundary(musicSwitchPoints(current), {
            startSec,
            trackDurationSec: reachSec,
            totalSec,
            minSegmentSec: MUSIC_MIN_SEGMENT_SEC,
          })
        : undefined;

    const segment = buildSegment(current, index + 1, fromShot, boundary?.shotIndex ?? current.shots.length);
    const sub = segmentSubReel(current, segment);

    const candidates = tracks.map((track, i) => {
      const analysis = analyses[i]!;
      return { index: i + 1, track, analysis, score: scoreTrack(sub.hitPoints, analysis) };
    });
    // Only a track that plays the whole segment may win it — the best-fitting cuts are no use
    // from a track that runs out halfway.
    const eligible = tracksCovering(candidates, segment.endSec - segment.startSec, (c) => c.analysis.durationSec);
    const chosen = chooseBestTrack(eligible, sub.hitPoints);
    if (!chosen) throw new Error('score: no music candidates to choose from');

    const { reel: snappedSub, score: snapped } = snapReel(sub, chosen.track.analysis);
    current = applySegmentReel(current, segment, snappedSub);
    segments.push({ ...segment, candidates, selected: chosen.track, snapped });
    fromShot = segment.toShot;
  }

  return { reel: current, segments };
}

function musicPlacements(result: ScoreResult): MusicPlacement[] {
  return result.segments.map((segment) => ({ path: segment.selected.track.path, startSec: segment.startSec }));
}

function musicSegmentMedia(result: ScoreResult): MusicSegmentMedia[] {
  return result.segments.map((segment) => ({
    path: segment.selected.track.path,
    startSec: segment.startSec,
    durationSec: segment.endSec - segment.startSec,
  }));
}

function musicSidecar(result: ScoreResult): { path: string; durationSec: number; prompt?: string }[] {
  return result.segments.map((segment) => ({
    path: segment.selected.track.path,
    durationSec: segment.selected.track.durationSec,
    prompt: segment.selected.track.prompt,
  }));
}

function scoreSummary(result: ScoreResult): string {
  const lines: string[] = [];
  for (const segment of result.segments) {
    const header =
      result.segments.length === 1
        ? `score: ${plural(segment.candidates.length, 'candidate')}`
        : `score: segment ${segment.index} (${formatSec(segment.startSec)}s-${formatSec(segment.endSec)}s), ` +
          `${plural(segment.candidates.length, 'candidate')}`;
    lines.push(header);
    for (const candidate of segment.candidates) {
      const selectedMark = candidate.index === segment.selected.index ? '   <- selected' : '';
      lines.push(
        `  track ${candidate.index}   ${candidate.score.hits}/${candidate.score.total} hits   ` +
          `shift ${formatSec(candidate.score.totalShiftSec)}s   ${candidate.analysis.tempo.toFixed(1)} BPM${selectedMark}`,
      );
    }
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

export async function runBuild(argv: string[], options: RunOptions = {}): Promise<CommandResult> {
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
        pitch: { type: 'string' },
        footage: { type: 'string', multiple: true },
      },
      allowPositionals: true,
    });

    const input = positionals[0];
    const explicitLongForm = values.pitch !== undefined || (values.footage ?? []).length > 0;
    if (input === undefined && !explicitLongForm) return errorResult(USAGE_BUILD);

    const lang = values.lang ?? 'en';
    if (lang !== 'en' && lang !== 'ja') return errorResult(`invalid --lang value "${lang}": expected "en" or "ja"`);

    const provider = values.provider ?? 'minimax';
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
    const project = resolveProject(input, values.pitch, values.footage ?? [], explicitLongForm);
    const outDir = values.o ?? DEFAULT_BUILD_OUT_DIR;
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const stages: string[] = [];
    const stage = (line: string): void => {
      stages.push(line);
      options.log?.(`  ${line}`);
    };
    options.log?.(`build: ${outDir}`);

    const cacheDir = project.cacheDir;
    const design = await designProject(project, {
      targetDurationSec,
      language: lang,
      cacheDir,
      offline,
      onNotice: (message) => stage(`plan: ${message}`),
    });
    const designedReel = snapToOnsets(design.reel, project.footage);
    let reel = designedReel;
    const attemptWord = design.attempts.length === 1 ? 'attempt' : 'attempts';
    stage(`plan: ${plural(reel.shots.length, 'shot')} designed in ${design.attempts.length} ${attemptWord}`);

    const movedShots = countMoved(design.reel, designedReel);
    if (movedShots > 0) {
      stage(`snap: ${plural(movedShots, 'shot')} moved to open on the screen starting to draw`);
    }

    let synthesized = await synthesizeLines(reel.narration, {
      provider,
      language: lang,
      outDir: join(cacheDir, 'vo'),
      offline,
    });
    let fit = fitReel(reel, { availableSec: footageSecByShot(reel), measured: measuredFrom(synthesized) });
    reel = fit.reel;
    stage(`narrate: ${plural(synthesized.length, 'line')} synthesized (${provider}), total ${formatSec(fit.report.totalDurationSec)}s`);

    const rewrites: RewriteRecord[] = [];
    if (fit.report.needsRewrite) {
      if (offline) {
        stage(`rewrite: skipped (offline), ${plural(countTier(fit.report, 'needs-rewrite'), 'line')} still over budget`);
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

          fit = fitReel(rewrittenReel, { availableSec: footageSecByShot(rewrittenReel), measured: measuredFrom(synthesized) });
          reel = fit.reel;
          stage(`rewrite: ${plural(rewrites.length, 'line')} shortened via M3, total ${formatSec(fit.report.totalDurationSec)}s`);
        } catch (err) {
          stage(`rewrite: skipped (${errMessage(err)})`);
        }
      }
    }

    if (fit.report.needsRewrite) {
      fit = { reel: fit.reel, report: compressToFit(fit.report, DEFAULT_MAX_ATEMPO) };
      stage(`compress: atempo applied (max ${DEFAULT_MAX_ATEMPO}x), ${plural(countTier(fit.report, 'compressed'), 'line')} compressed`);
    }

    if (project.mode === 'longform' && project.footage !== undefined) {
      const durations = footageDurations(project.footage);
      const extended = extendRangeToShot(reel, durations);
      const grown = extended.shots.filter((shot, i) => shot.evidenceRange?.[1] !== reel.shots[i]?.evidenceRange?.[1]).length;
      reel = extended;
      stage(`extend: ${plural(grown, 'shot')} play their footage on past the moment it starts drawing`);
    }

    if (project.mode === 'longform') {
      const stretched = stretchFootageToShots(reel);
      const slowed = stretched.shots.filter((shot, i) => shot.speed !== reel.shots[i]?.speed).length;
      reel = stretched;
      const held = holdWarnings(reel).length;
      stage(
        `stretch: ${plural(slowed, 'shot')} slowed so their footage covers the time narration asked for` +
          (held > 0 ? `, ${plural(held, 'shot')} still mostly a held frame` : ''),
      );
    }

    let scoreResult: ScoreResult | undefined;
    if (values['skip-music'] !== true && reel.music) {
      scoreResult = await scoreReel(reel, {
        outDir: join(cacheDir, 'music'),
        count: DEFAULT_MUSIC_CANDIDATES,
        offline,
        segmented: project.mode === 'longform',
      });
      reel = scoreResult.reel;
      for (const segment of scoreResult.segments) {
        const measured =
          scoreResult.segments.length === 1
            ? ''
            : ` for ${formatSec(segment.startSec)}s-${formatSec(segment.endSec)}s ` +
              `(measured ${segment.candidates.map((c) => `${formatSec(c.analysis.durationSec)}s`).join('/')})`;
        stage(
          `score: ${plural(segment.candidates.length, 'candidate')}${measured}, selected track ${segment.selected.index} ` +
            `(${segment.selected.score.hits}/${segment.selected.score.total} hits)`,
        );
      }
    } else {
      stage('score: skipped');
    }

    const rendered = await renderShots(reel, {
      castPath: project.recordingFile,
      sources: project.sources,
      outDir: join(outDir, 'shots'),
      fps: reel.fps,
    });
    const usage = reelUsage(reel);
    stage(`render: ${plural(reel.shots.length, 'shot')} rendered, ${usageSummaryLine(usage)}`);

    if (project.footage !== undefined) {
      stage(`onset: ${onsetSummaryLine(reel, project.footage)}`);
      stage(`sources: ${coverageSummaryLine(reel, project.footage)}`);
    }
    const motion = motionBreakdown(reel, activeSpansBySource(project.footage));
    stage(`motion: ${motionSummaryLine(motion)}`);
    for (const advisory of design.advisories) stage(`  coverage: ${advisory}`);

    const narrationAt = new Map(fit.report.lines.map((l) => [l.lineId, l.atSec]));
    const atempoByLine = atempoByLineId(fit.report.lines);
    const mp4Path = join(outDir, 'reel.mp4');
    const assembled = await assembleReel(reel, {
      shots: rendered,
      narration: synthesized,
      narrationAt,
      atempoByLine,
      music: scoreResult ? musicPlacements(scoreResult) : undefined,
      outPath: mp4Path,
      fps: reel.fps,
    });
    stage(`assemble: ${formatSec(assembled.durationSec)}s -> ${basename(mp4Path)}`);

    const shotMedia = new Map(reel.shots.map((s) => [s.id, requireRendered(rendered, s.id).path]));
    const narrationMedia = new Map(synthesized.map((s) => [s.lineId, s.path]));
    const narrationDuration = new Map(synthesized.map((s) => [s.lineId, s.durationSec]));
    const otioPath = join(outDir, 'reel.otio');
    const musicSegments = scoreResult ? musicSegmentMedia(scoreResult) : undefined;
    const doc = buildOtio(reel, {
      media: { shotMedia, narrationMedia, musicMedia: musicSegments?.[0]?.path, musicSegments },
      narrationAt,
      narrationDuration,
    });
    writeFileSync(otioPath, otioToJson(doc));
    stage(`emit: ${basename(otioPath)}`);

    const reelPath = join(outDir, 'reel.json');
    writeFileSync(reelPath, `${JSON.stringify(reel, null, 2)}\n`);

    const report = buildReport({
      reel,
      usage,
      motion,
      design,
      fitReport: fit.report,
      rewrites,
      scoreResult,
      assembled,
      mp4Path,
      otioPath,
      reelPath,
      provider,
    });
    writeFileSync(join(outDir, 'reel.report.json'), `${JSON.stringify(report, null, 2)}\n`);

    return { stdout: '', stderr: options.log ? '' : buildSummary(outDir, stages), exitCode: 0 };
  } catch (err) {
    return errorResult(errMessage(err));
  }
}

/**
 * What `build` was pointed at. One recording is the original mode and stays untouched; a pitch
 * plus a set of footage is the long-form mode, entered by `--pitch`/`--footage` or by a directory
 * holding `pitch.md` and `footage/`.
 */
interface BuildProject {
  mode: 'recording' | 'longform';
  /** Sits next to the input (not `-o`) so `--offline` replays the same cache wherever the output goes. */
  cacheDir: string;
  targetDurationSec: number | undefined;
  recordingFile?: string;
  pitch?: string;
  footage?: FootageItem[];
  sources?: SourceMap;
}

function resolveProject(
  input: string | undefined,
  pitchPath: string | undefined,
  footagePaths: string[],
  explicitLongForm: boolean,
): BuildProject {
  const projectDir = input !== undefined && statSync(input).isDirectory() ? input : undefined;
  const longForm =
    explicitLongForm || (projectDir !== undefined && isLongFormProject(projectDir, PITCH_FILE_NAME, FOOTAGE_DIR_NAME));

  if (!longForm) {
    if (input === undefined) throw new Error(USAGE_BUILD);
    const recordingFile = resolveRecordingFile(input);
    return { mode: 'recording', cacheDir: join(dirname(recordingFile), CACHE_DIR_NAME), targetDurationSec: undefined, recordingFile };
  }

  const pitchFile = pitchPath ?? (projectDir !== undefined ? join(projectDir, PITCH_FILE_NAME) : undefined);
  if (pitchFile === undefined) throw new Error('long-form build needs a pitch: pass --pitch <file>');
  if (!existsSync(pitchFile)) throw new Error(`pitch file "${pitchFile}" does not exist`);

  const files =
    footagePaths.length > 0
      ? footagePaths
      : projectDir !== undefined
        ? listFootageFiles(join(projectDir, FOOTAGE_DIR_NAME))
        : [];
  if (files.length === 0) throw new Error('long-form build needs footage: pass --footage <file> at least once');

  const footage = loadFootage(files);
  return {
    mode: 'longform',
    cacheDir: join(dirname(pitchFile), CACHE_DIR_NAME),
    targetDurationSec: LONG_FORM_DEFAULT_DURATION_SEC,
    pitch: readFileSync(pitchFile, 'utf8'),
    footage,
    sources: new Map(footage.map((item) => [item.id, { path: item.path, durationSec: item.recording.durationSec }])),
  };
}

interface DesignProjectOptions {
  targetDurationSec: number | undefined;
  language: 'en' | 'ja';
  cacheDir: string;
  offline: boolean;
  onNotice: (message: string) => void;
}

function designProject(project: BuildProject, options: DesignProjectOptions): Promise<DesignResult> {
  const targetDurationSec = options.targetDurationSec ?? project.targetDurationSec;
  const shared = {
    targetDurationSec,
    language: options.language,
    cacheDir: options.cacheDir,
    offline: options.offline,
    onNotice: options.onNotice,
  };

  if (project.mode === 'longform') {
    if (project.pitch === undefined || project.footage === undefined) throw new Error('long-form build has no pitch or footage');
    return designLongFormReel(project.pitch, project.footage, shared);
  }
  if (project.recordingFile === undefined) throw new Error('build has no recording to design from');
  return designReel(readRecording(project.recordingFile), shared);
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

function activeSpansBySource(footage: FootageItem[] | undefined): Map<string, TimeSpan[]> {
  if (footage === undefined) return new Map();
  return new Map(footage.map((item) => [item.id, activeSpans(item.recording)]));
}

/** What a shot is allowed to open on: a stretch that both moves and leaves a readable screen. */
function readableTimingBySource(footage: FootageItem[]): Map<string, SourceTiming> {
  return new Map(
    footage.map((item) => [item.id, { spans: readableSpans(item.recording), durationSec: item.recording.durationSec }]),
  );
}

function coverageSummaryLine(reel: Reel, footage: FootageItem[]): string {
  return sourceCoverage(reel, footageDurations(footage))
    .map((c) => `${c.source} ${formatSec(c.usedSec)}/${formatSec(c.availableSec)}s`)
    .join(', ');
}

function motionSummaryLine(motion: MotionBreakdown): string {
  const share = (sec: number): string => `${formatSec(sec)}s (${Math.round((sec / motion.totalSec) * 100)}%)`;
  return `${share(motion.changingSec)} of screen actually changes, ${share(motion.footageSec)} plays footage, ${share(motion.heldSec)} is held`;
}

/** No-op for a single-recording build, whose shots are cut against evidence the model saw whole. */
function snapToOnsets(reel: Reel, footage: FootageItem[] | undefined): Reel {
  if (footage === undefined) return reel;
  return snapRangeToOnset(reel, readableTimingBySource(footage));
}

function countMoved(before: Reel, after: Reel): number {
  return after.shots.filter((shot, i) => shot.evidenceRange?.[0] !== before.shots[i]?.evidenceRange?.[0]).length;
}

/** Fraction of footage shots that open within `ONSET_TOLERANCE_SEC` of their screen starting to draw. */
function onsetSummaryLine(reel: Reel, footage: FootageItem[]): string {
  const alignments = onsetAlignments(reel, readableTimingBySource(footage));
  if (alignments.length === 0) return 'no footage shots';
  const onCue = alignments.filter((a) => a.offsetSec !== undefined && Math.abs(a.offsetSec) <= ONSET_TOLERANCE_SEC);
  const worst = alignments.reduce((max, a) => Math.max(max, a.offsetSec === undefined ? Infinity : Math.abs(a.offsetSec)), 0);
  return `${onCue.length}/${alignments.length} shots open on the screen starting to draw (worst off by ${formatSec(worst)}s)`;
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

interface BuildReportInput {
  reel: Reel;
  usage: ReelUsage;
  motion: MotionBreakdown;
  design: DesignResult;
  fitReport: FitReport;
  rewrites: RewriteRecord[];
  scoreResult: ScoreResult | undefined;
  assembled: { path: string; durationSec: number };
  mp4Path: string;
  otioPath: string;
  reelPath: string;
  provider: SpeechProvider;
}

function buildReport(input: BuildReportInput): unknown {
  const { reel, usage, fitReport, scoreResult } = input;
  const tiers: Record<string, number> = {};
  for (const line of fitReport.lines) tiers[line.tier] = (tiers[line.tier] ?? 0) + 1;

  return {
    title: reel.title,
    totalDurationSec: totalDurationSec(reel),
    shots: reel.shots.length,
    plan: {
      attempts: input.design.attempts.length,
      unresolvedCoverage: input.design.advisories.length > 0 ? input.design.advisories : undefined,
    },
    motion: {
      changingSec: round3(input.motion.changingSec),
      footageSec: round3(input.motion.footageSec),
      heldSec: round3(input.motion.heldSec),
      heldRatio: round3(input.motion.heldSec / input.motion.totalSec),
    },
    footage: {
      bySource: usage.bySource.map((source) => ({
        source: source.source,
        shots: source.shots,
        screenSec: round3(source.screenSec),
        footageSec: round3(source.footageSec),
      })),
      cardSec: round3(usage.cardSec),
      stillSec: round3(usage.stillSec),
    },
    narrate: {
      provider: input.provider,
      lines: fitReport.lines.length,
      speechSec: round3(fitReport.lines.reduce((sum, l) => sum + l.speechSec, 0)),
      tiers,
      rewrites: input.rewrites.length > 0 ? input.rewrites : undefined,
    },
    music: scoreResult
      ? {
          segments: scoreResult.segments.map((segment) => ({
            segment: segment.index,
            startSec: round3(segment.startSec),
            endSec: round3(segment.endSec),
            selectedTrack: segment.selected.index,
            trackPath: segment.selected.track.path,
            candidates: segment.candidates.map((c) => ({
              track: c.index,
              tempoBpm: round3(c.analysis.tempo),
              durationSec: round3(c.analysis.durationSec),
              coversSegment: c.analysis.durationSec >= segment.endSec - segment.startSec,
              beats: c.analysis.beats.length,
              hits: c.score.hits,
              total: c.score.total,
              totalShiftSec: round3(c.score.totalShiftSec),
            })),
            alignments: segment.snapped.alignments.map((a) => ({
              hitPoint: round3(a.hitPoint + segment.startSec),
              beat: a.beat === undefined ? undefined : round3(a.beat),
              shiftSec: a.shiftSec === undefined ? undefined : round3(a.shiftSec),
              status: a.beat === undefined ? 'missed' : a.moved === true ? 'moved-to-beat' : 'already-on-beat',
            })),
          })),
          snappedHitPoints: reel.hitPoints.map(round3),
        }
      : undefined,
    mp4: { path: input.mp4Path, durationSec: input.assembled.durationSec },
    otio: { path: input.otioPath },
    reel: { path: input.reelPath },
  };
}

function usageSummaryLine(usage: ReelUsage): string {
  const sources = usage.bySource.map((s) => `${s.source} ${formatSec(s.screenSec)}s`);
  return [...sources, `cards ${formatSec(usage.cardSec)}s`].join(', ');
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

/** argv[1] is a symlink when the CLI is invoked through node_modules/.bin, so compare real paths. */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2), { log: (line) => process.stderr.write(`${line}\n`) }).then((result) => {
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
    process.exit(result.exitCode);
  });
}
