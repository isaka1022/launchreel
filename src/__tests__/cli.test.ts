import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runEmit, runFit, runIngest } from '../cli.js';
import { totalDurationSec, type Reel } from '../timeline/schema.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const castFixture = join(repoRoot, 'src', 'ingest', '__tests__', 'fixtures', 'sample.cast');
const reelFixture = join(repoRoot, 'examples', 'vhs-demo', 'reel.json');

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
  it('vhs-demoのreelを処理して総尺が伸びる', () => {
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
