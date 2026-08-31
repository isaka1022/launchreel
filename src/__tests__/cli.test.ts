import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { motionSummaryLines, runEmit, runFit, runIngest } from '../cli.js';
import { totalDurationSec, type Reel } from '../timeline/schema.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const castFixture = join(repoRoot, 'src', 'ingest', '__tests__', 'fixtures', 'sample.cast');
const reelFixture = join(repoRoot, 'src', '__tests__', 'fixtures', 'vhs-demo-reel.json');

describe('motionSummaryLines', () => {
  it('4つの実測値を意味が分かる2行に収め、各行を88桁以下にする', () => {
    const summary = motionSummaryLines({
      totalSec: 104.369,
      footageSec: 54.169,
      changingSec: 21.593,
      graphicSec: 0,
      heldSec: 50.2,
    });

    expect(summary).toEqual([
      'footage 54.17s (52%); cards 0.0s (0%); last-frame hold 50.2s (48%)',
      'within footage: screen changes for 21.59s (21% of reel)',
    ]);
    expect(summary.every((line) => !line.includes('\n'))).toBe(true);

    // Widest case a reel can reach: a long enough reel that every share needs three digits.
    const widest = motionSummaryLines({
      totalSec: 331.71,
      footageSec: 110.57,
      changingSec: 110.57,
      graphicSec: 110.57,
      heldSec: 110.57,
    });
    const outputLines = widest.map((line) => `  motion: ${line}`);
    expect(Math.max(...outputLines.map((line) => line.length))).toBeLessThanOrEqual(88);
  });
});

describe('runIngest', () => {
  it('sample.castをRecording JSONに変換し、stdoutにJSON、stderrにサマリを出す', () => {
    const result = runIngest([castFixture]);

    expect(result.exitCode).toBe(0);
    const recording = JSON.parse(result.stdout) as { source: string; evidence: unknown[] };
    expect(recording.source).toBe('cast');
    expect(recording.evidence.length).toBeGreaterThan(0);
    expect(result.stderr).toContain('ingested sample.cast');
  });
});

describe('runFit', () => {
  it('実際のreelを処理して総尺が伸びる', () => {
    const originalReel = JSON.parse(readFileSync(reelFixture, 'utf8')) as Reel;
    const originalTotal = totalDurationSec(originalReel);

    const result = runFit([reelFixture]);

    expect(result.exitCode).toBe(0);
    const fitted = JSON.parse(result.stdout) as Reel;
    expect(totalDurationSec(fitted)).toBeGreaterThan(originalTotal);
    expect(result.stderr).toContain('fit:');
  });
});

describe('runEmit', () => {
  it('OTIOを生成し、OTIO_SCHEMAがTimeline.1になる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchreel-'));
    const outPath = join(dir, 'out.otio');

    const result = runEmit([reelFixture, '--otio', outPath]);

    expect(result.exitCode).toBe(0);
    const doc = JSON.parse(readFileSync(outPath, 'utf8')) as { OTIO_SCHEMA: string };
    expect(doc.OTIO_SCHEMA).toBe('Timeline.1');
    expect(result.stderr).toContain('emit:');
  });
});

describe('エラーハンドリング', () => {
  it('不正なJSONを渡すと、スタックトレースでない読めるエラーメッセージでexit 1になる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchreel-'));
    const badFile = join(dir, 'bad.json');
    writeFileSync(badFile, '{ not valid json');

    const result = runFit([badFile]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain('    at ');
    expect(result.stderr.trim().length).toBeGreaterThan(0);
  });
});
