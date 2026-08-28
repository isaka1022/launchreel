#!/usr/bin/env tsx
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { main as runCli } from '../src/cli.js';
import { runAnalyze } from '../src/drivers/python.js';
import { expectedAssembledDurationSec } from '../src/emit/assemble.js';
import { buildOtio, otioToJson } from '../src/emit/otio.js';
import { parseCast } from '../src/ingest/cast.js';
import { CACHE_DIR_NAME } from '../src/order/media.js';
import { generateTracks } from '../src/order/music.js';
import { reelSchema, type Reel } from '../src/timeline/schema.js';
import { designReel } from '../src/understand/m3.js';

/**
 * Automates the Day 1 gates: G1 (M3 IR validates), G3 (hand-written IR survives OTIO round
 * trip), G4 (music analysis produces beats/segments), and G5 (the full `build` pipeline
 * produces an mp4 whose duration matches the reel). Defaults to --offline so CI never calls a
 * paid model.
 */

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const selfDir = join(repoRoot, 'examples', 'self');
const XFADE_DURATION_SEC = 0.25;
const DURATION_TOLERANCE_SEC = 0.2;

interface GateResult {
  name: string;
  ok: boolean;
  detail: string;
}

async function gate1(offline: boolean): Promise<GateResult> {
  const name = 'G1 plan — M3 emits an IR that validates against the schema';
  try {
    const recording = parseCast(readFileSync(join(selfDir, 'demo.cast'), 'utf8'));
    const result = await designReel(recording, {
      targetDurationSec: 30,
      language: 'en',
      cacheDir: join(selfDir, CACHE_DIR_NAME),
      offline,
    });
    const parsed = reelSchema.safeParse(result.reel);
    if (!parsed.success) return { name, ok: false, detail: 'designed reel failed reelSchema validation' };
    return { name, ok: true, detail: `${result.reel.shots.length} shots, ${result.attempts.length} attempt(s)` };
  } catch (err) {
    return { name, ok: false, detail: errMessage(err) };
  }
}

async function gate3(): Promise<GateResult> {
  const name = 'G3 emit — hand-written IR -> OTIO -> otiotool --stats reads it';
  const dir = mkdtempSync(join(tmpdir(), 'launchreel-gate-g3-'));
  try {
    const reel: Reel = {
      version: 'launchreel/1',
      title: 'Gate smoke reel',
      fps: 30,
      shots: [
        { id: 's1', kind: 'card', durationSec: 2, label: 'One', card: { title: 'One' } },
        { id: 's2', kind: 'card', durationSec: 3, label: 'Two', card: { title: 'Two' } },
      ],
      narration: [{ id: 'n1', shotId: 's1', text: 'Hello.', atSec: 0.2 }],
      hitPoints: [1, 4],
    };
    const otioPath = join(dir, 'gate.otio');
    writeFileSync(otioPath, otioToJson(buildOtio(reel)));

    const otiotool = join(repoRoot, '.venv', 'bin', 'otiotool');
    if (!existsSync(otiotool)) {
      return {
        name,
        ok: false,
        detail: `otiotool not found at ${otiotool}. Run: python3 -m venv .venv && ./.venv/bin/pip install -r py/requirements.txt`,
      };
    }
    const { stdout } = await execFileAsync(otiotool, ['--input', otioPath, '--stats']);
    if (stdout.trim().length === 0) return { name, ok: false, detail: 'otiotool --stats produced no output' };
    return { name, ok: true, detail: 'otiotool --stats read the round-tripped timeline' };
  } catch (err) {
    return { name, ok: false, detail: errMessage(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function gate4(offline: boolean): Promise<GateResult> {
  const name = 'G4 score — analyze.py measures beats/segments on a rendered track';
  try {
    const audioPath = await resolveGateAudio(offline);
    const analysis = await runAnalyze(audioPath);
    if (analysis.beats.length === 0) return { name, ok: false, detail: 'analyze.py returned zero beats' };
    return {
      name,
      ok: true,
      detail: `${analysis.beats.length} beats, ${analysis.tempo.toFixed(1)} BPM, ${analysis.segments.length} segments`,
    };
  } catch (err) {
    return { name, ok: false, detail: errMessage(err) };
  }
}

async function resolveGateAudio(offline: boolean): Promise<string> {
  const cacheDir = join(selfDir, CACHE_DIR_NAME, 'music');
  if (offline) {
    if (!existsSync(cacheDir)) {
      throw new Error(`--offline: no cached music at ${cacheDir}. Run the gate once with --online first.`);
    }
    const files = readdirSync(cacheDir).filter((f) => f.endsWith('.mp3') || f.endsWith('.wav'));
    if (files.length === 0) throw new Error(`--offline: no cached audio files in ${cacheDir}`);
    return join(cacheDir, files[0]!);
  }
  const tracks = await generateTracks(
    { caption: 'Gate check instrumental', structureTags: ['[Intro]'], targetDurationSec: 20 },
    { outDir: cacheDir, count: 1 },
  );
  return tracks[0]!.path;
}

async function gate5(offline: boolean): Promise<GateResult> {
  const name = 'G5 build — examples/self builds end-to-end, mp4 duration matches the reel';
  const dir = mkdtempSync(join(tmpdir(), 'launchreel-gate-g5-'));
  try {
    const args = ['build', selfDir, '-o', dir];
    if (offline) args.push('--offline');
    const result = await runCli(args);
    if (result.exitCode !== 0) return { name, ok: false, detail: result.stderr.trim() };

    const reel = JSON.parse(readFileSync(join(dir, 'reel.json'), 'utf8')) as Reel;
    const report = JSON.parse(readFileSync(join(dir, 'reel.report.json'), 'utf8')) as { mp4: { durationSec: number } };
    const expected = expectedAssembledDurationSec(reel.shots.map((s) => s.durationSec), XFADE_DURATION_SEC);
    const diff = Math.abs(report.mp4.durationSec - expected);
    if (diff > DURATION_TOLERANCE_SEC) {
      return {
        name,
        ok: false,
        detail: `mp4 ${report.mp4.durationSec.toFixed(2)}s vs expected ${expected.toFixed(2)}s (diff ${diff.toFixed(2)}s)`,
      };
    }
    return { name, ok: true, detail: `mp4 ${report.mp4.durationSec.toFixed(2)}s matches the reel (expected ${expected.toFixed(2)}s)` };
  } catch (err) {
    return { name, ok: false, detail: errMessage(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runGate(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { offline: { type: 'boolean', default: false }, online: { type: 'boolean', default: false } },
    allowPositionals: false,
  });
  const offline = values.online !== true;

  const results: GateResult[] = [];
  results.push(await gate1(offline));
  results.push(await gate3());
  results.push(await gate4(offline));
  results.push(await gate5(offline));

  let allOk = true;
  for (const result of results) {
    const mark = result.ok ? 'PASS' : 'FAIL';
    process.stderr.write(`[${mark}] ${result.name}\n       ${result.detail}\n`);
    if (!result.ok) allOk = false;
  }

  process.exitCode = allOk ? 0 : 1;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

runGate();
