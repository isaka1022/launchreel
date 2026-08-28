export type EvidenceKind = 'command' | 'output' | 'pause' | 'annotation';

export interface Evidence {
  /** Seconds from the start of the recording. */
  t: number;
  kind: EvidenceKind;
  /** For 'command': the command line. For 'output': the emitted text. */
  text: string;
  /** Seconds this evidence spans, when known (e.g. a pause). */
  durationSec?: number;
}

export interface Recording {
  source: 'cast' | 'tape';
  /** Total length in seconds. */
  durationSec: number;
  /** Terminal size, when the format declares it. */
  cols?: number;
  rows?: number;
  title?: string;
  evidence: Evidence[];
}
