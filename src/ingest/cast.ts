import { z } from 'zod';
import { PAUSE_THRESHOLD_SEC } from './constants.js';
import type { Evidence, Recording } from './types.js';

/**
 * Parses asciinema .cast recordings (v2 and v3). Per the spec, v2 event times are absolute
 * from recording start; v3 event times are intervals since the previous event. Getting this
 * backwards silently corrupts every timestamp, so the two are branched explicitly below.
 * https://docs.asciinema.org/manual/asciicast/v2/ https://docs.asciinema.org/manual/asciicast/v3/
 */

const PROMPT_PREFIXES = ['$ ', '❯ ', '> ', '# '];

const headerV2Schema = z.object({
  version: z.literal(2),
  width: z.number(),
  height: z.number(),
  title: z.string().optional(),
});

const headerV3Schema = z.object({
  version: z.literal(3),
  term: z.object({ cols: z.number(), rows: z.number() }),
  title: z.string().optional(),
});

interface RawEvent {
  time: number;
  code: string;
  data: string;
}

interface TimedChar {
  ch: string;
  time: number;
}

interface LineAssembly {
  t: number;
  text: string;
}

export function parseCast(content: string): Recording {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const headerLine = lines[0];
  if (headerLine === undefined) throw new Error('empty cast file');

  const header: unknown = JSON.parse(headerLine);
  const v3 = headerV3Schema.safeParse(header);
  const v2 = v3.success ? undefined : headerV2Schema.safeParse(header);

  let cols: number;
  let rows: number;
  let title: string | undefined;
  let isV3: boolean;

  if (v3.success) {
    isV3 = true;
    cols = v3.data.term.cols;
    rows = v3.data.term.rows;
    title = v3.data.title;
  } else if (v2 && v2.success) {
    isV3 = false;
    cols = v2.data.width;
    rows = v2.data.height;
    title = v2.data.title;
  } else {
    throw new Error('unrecognized asciicast header (expected version 2 or 3)');
  }

  const rawEvents: RawEvent[] = [];
  let cursor = 0;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed) || parsed.length < 3) continue;
    const arr: unknown[] = parsed;
    const rawTime = arr[0];
    const rawCode = arr[1];
    const rawData = arr[2];
    if (typeof rawTime !== 'number' || typeof rawCode !== 'string') continue;
    const time = isV3 ? (cursor += rawTime) : rawTime;
    const data = typeof rawData === 'string' ? rawData : String(rawData ?? '');
    rawEvents.push({ time, code: rawCode, data });
  }

  // Only output events draw to the screen, and v3 always appends a terminating "x" event —
  // counting it would push durationSec past what agg will `--select` from the recording.
  const lastOutputEvent = [...rawEvents].reverse().find((e) => e.code === 'o');
  const durationSec = lastOutputEvent ? lastOutputEvent.time : 0;

  const evidence: Evidence[] = [
    ...assembleLines(rawEvents).map(classifyLine),
    ...rawEvents
      .filter((e) => e.code === 'm')
      .map((e): Evidence => ({ t: e.time, kind: 'annotation', text: e.data.length > 0 ? e.data : 'marker' })),
    ...detectPauses(rawEvents),
  ].sort((a, b) => a.t - b.t);

  return { source: 'cast', durationSec, cols, rows, title, evidence };
}

function flattenOutputChars(events: RawEvent[]): TimedChar[] {
  const chars: TimedChar[] = [];
  for (const event of events) {
    if (event.code !== 'o') continue;
    for (const ch of stripAnsi(event.data)) chars.push({ ch, time: event.time });
  }
  return chars;
}

/**
 * Builds one Evidence-worthy line per newline. A bare `\r` (not part of a `\r\n` pair)
 * means the terminal is redrawing the current line in place (progress bars, spinners), so it
 * discards the pending buffer instead of flushing it — otherwise a spinner becomes dozens of
 * near-duplicate Evidence entries.
 */
function assembleLines(events: RawEvent[]): LineAssembly[] {
  const chars = flattenOutputChars(events);
  const results: LineAssembly[] = [];
  let buffer = '';
  let bufferStart: number | null = null;

  const flush = (): void => {
    if (buffer.trim().length > 0 && bufferStart !== null) results.push({ t: bufferStart, text: buffer });
    buffer = '';
    bufferStart = null;
  };

  for (let i = 0; i < chars.length; i++) {
    const current = chars[i];
    if (current === undefined) continue;
    if (current.ch === '\r') {
      const next = chars[i + 1];
      if (next && next.ch === '\n') continue;
      buffer = '';
      bufferStart = null;
      continue;
    }
    if (current.ch === '\n') {
      flush();
      continue;
    }
    if (bufferStart === null) bufferStart = current.time;
    buffer += current.ch;
  }
  flush();
  return results;
}

function classifyLine(line: LineAssembly): Evidence {
  const text = line.text.trim();
  for (const prefix of PROMPT_PREFIXES) {
    if (text.startsWith(prefix)) {
      return { t: line.t, kind: 'command', text: text.slice(prefix.length).trim() };
    }
  }
  return { t: line.t, kind: 'output', text };
}

function detectPauses(events: RawEvent[]): Evidence[] {
  const pauses: Evidence[] = [];
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (!prev || !curr) continue;
    const gap = curr.time - prev.time;
    if (gap >= PAUSE_THRESHOLD_SEC) pauses.push({ t: prev.time, kind: 'pause', text: 'pause', durationSec: gap });
  }
  return pauses;
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Za-z0-9]/g, '')
    .replace(/\x1b[@-Z\\\]^_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
