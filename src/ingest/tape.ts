import { PAUSE_THRESHOLD_SEC } from './constants.js';
import type { Evidence, Recording } from './types.js';

/**
 * Parses vhs .tape scripts. Tape has no real timestamps, so this replays each statement
 * against a virtual clock (typing speed × char count, key presses, Sleep) to reconstruct a
 * timeline comparable to a real recording. https://github.com/charmbracelet/vhs
 */

const DEFAULT_TYPING_SPEED_MS = 50;
const HIDDEN_SETUP_LABEL = 'hidden setup';

type Statement =
  | { kind: 'comment'; text: string }
  | { kind: 'type'; text: string; speedOverrideMs?: number }
  | { kind: 'key'; name: string; count: number; speedOverrideMs?: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'hide' }
  | { kind: 'show' }
  | { kind: 'setTypingSpeed'; ms: number }
  | { kind: 'ignored' };

export function parseTape(content: string): Recording {
  const statements = content
    .split('\n')
    .map((raw) => parseLine(raw))
    .filter((s): s is Statement => s !== null);

  let typingSpeedMs = DEFAULT_TYPING_SPEED_MS;
  let clockSec = 0;
  let hidden = false;
  let hiddenStartSec = 0;
  const evidence: Evidence[] = [];

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i];
    if (!statement) continue;

    switch (statement.kind) {
      case 'comment':
        if (!hidden) evidence.push({ t: clockSec, kind: 'annotation', text: statement.text });
        break;
      case 'setTypingSpeed':
        typingSpeedMs = statement.ms;
        break;
      case 'ignored':
        break;
      case 'hide':
        hidden = true;
        hiddenStartSec = clockSec;
        break;
      case 'show':
        if (hidden) {
          evidence.push({
            t: hiddenStartSec,
            kind: 'annotation',
            text: HIDDEN_SETUP_LABEL,
            durationSec: clockSec - hiddenStartSec,
          });
        }
        hidden = false;
        break;
      case 'sleep': {
        const startSec = clockSec;
        const sleepSec = statement.ms / 1000;
        clockSec += sleepSec;
        if (!hidden && sleepSec >= PAUSE_THRESHOLD_SEC) {
          evidence.push({ t: startSec, kind: 'pause', text: 'pause', durationSec: sleepSec });
        }
        break;
      }
      case 'type': {
        const startSec = clockSec;
        const perCharMs = statement.speedOverrideMs ?? typingSpeedMs;
        clockSec += (statement.text.length * perCharMs) / 1000;
        const next = nextActionable(statements, i + 1);
        if (!hidden && next && next.kind === 'key' && next.name === 'Enter') {
          evidence.push({ t: startSec, kind: 'command', text: statement.text });
        }
        break;
      }
      case 'key': {
        const perStrokeMs = statement.speedOverrideMs ?? typingSpeedMs;
        clockSec += (perStrokeMs * statement.count) / 1000;
        break;
      }
    }
  }

  return { source: 'tape', durationSec: clockSec, evidence };
}

function nextActionable(statements: Statement[], from: number): Statement | undefined {
  for (let i = from; i < statements.length; i++) {
    const s = statements[i];
    if (s && s.kind !== 'comment') return s;
  }
  return undefined;
}

const KEY_NAMES = ['Enter', 'Backspace', 'Tab', 'Space', 'Up', 'Down', 'Left', 'Right', 'Escape', 'PageUp', 'PageDown'];
const KEY_PATTERN = new RegExp(`^(${KEY_NAMES.join('|')}|Ctrl\\+\\S+)(?:@(\\S+))?(?:\\s+(\\d+))?$`);

function parseLine(raw: string): Statement | null {
  const line = raw.trim();
  if (line.length === 0) return null;
  if (line.startsWith('#')) return { kind: 'comment', text: line.slice(1).trim() };

  let m = line.match(/^Set\s+TypingSpeed\s+(\S+)$/);
  if (m && m[1]) return { kind: 'setTypingSpeed', ms: parseDuration(m[1]) };

  if (/^Set\s+\S+\s+.+$/.test(line) || /^Output\s+.+$/.test(line)) return { kind: 'ignored' };
  if (line === 'Hide') return { kind: 'hide' };
  if (line === 'Show') return { kind: 'show' };

  m = line.match(/^Sleep\s+(\S+)$/);
  if (m && m[1]) return { kind: 'sleep', ms: parseDuration(m[1]) };

  m = line.match(/^Type(?:@(\S+))?\s+"((?:[^"\\]|\\.)*)"$/);
  if (m) {
    return {
      kind: 'type',
      text: unescapeTypeText(m[2] ?? ''),
      speedOverrideMs: m[1] ? parseDuration(m[1]) : undefined,
    };
  }
  m = line.match(/^Type(?:@(\S+))?\s+`([^`]*)`$/);
  if (m) {
    return { kind: 'type', text: m[2] ?? '', speedOverrideMs: m[1] ? parseDuration(m[1]) : undefined };
  }

  m = line.match(KEY_PATTERN);
  if (m && m[1]) {
    return {
      kind: 'key',
      name: m[1],
      count: m[3] ? Number(m[3]) : 1,
      speedOverrideMs: m[2] ? parseDuration(m[2]) : undefined,
    };
  }

  return { kind: 'ignored' };
}

function unescapeTypeText(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

function parseDuration(value: string): number {
  const ms = value.match(/^([\d.]+)ms$/);
  if (ms && ms[1]) return Number(ms[1]);
  const sec = value.match(/^([\d.]+)s$/);
  if (sec && sec[1]) return Number(sec[1]) * 1000;
  const bare = Number(value);
  if (!Number.isNaN(bare)) return bare * 1000;
  return DEFAULT_TYPING_SPEED_MS;
}
