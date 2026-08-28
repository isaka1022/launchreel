import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Append-only spend log at `.launchreel/spend.jsonl`. Every model used today is Free, but the
 * ledger records `usd: 0` entries now so a later paid model shows up without a schema change.
 */

const LEDGER_PATH = '.launchreel/spend.jsonl';

export interface SpendEntry {
  model: string;
  kind: string;
  usd: number;
  at: string;
  note?: string;
}

export function appendSpend(entry: SpendEntry): void {
  const dir = dirname(LEDGER_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(LEDGER_PATH, `${JSON.stringify(entry)}\n`);
}

export function totalSpendUsd(): number {
  if (!existsSync(LEDGER_PATH)) return 0;
  const content = readFileSync(LEDGER_PATH, 'utf8');
  let total = 0;
  for (const line of content.split('\n')) {
    if (line.trim().length === 0) continue;
    const entry = JSON.parse(line) as SpendEntry;
    total += entry.usd;
  }
  return total;
}
