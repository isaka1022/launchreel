import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { synthesizeLines } from '../speech.js';
import type { NarrationLine } from '../../timeline/schema.js';

/** No network: exercises the macOS `say` fallback only. Skipped off-macOS. */
const testOnDarwin = process.platform === 'darwin' ? it : it.skip;

describe('synthesizeLines', () => {
  testOnDarwin('system providerでmacOS sayを使い1行合成し、実尺を返す', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'launchreel-speech-'));
    const lines: NarrationLine[] = [{ id: 'l1', shotId: 's1', text: 'Hello from LaunchReel.' }];

    const results = await synthesizeLines(lines, { provider: 'system', language: 'en', outDir });

    expect(results).toHaveLength(1);
    expect(results[0]?.provider).toBe('system');
    expect(results[0]?.durationSec).toBeGreaterThan(0);
  }, 20_000);
});
