import { z } from 'zod';
import { chatCompletion, type ChatMessage } from '../drivers/gmi.js';
import { formatZodIssues } from '../report.js';
import type { Reel } from '../timeline/schema.js';
import { M3_MODEL } from './m3.js';

/**
 * Asks M3 to shorten narration lines that overran their shot. Same convention as `designReel`
 * (forced tool call, zod-validated result, throw on failure) but a single round trip — no
 * repair loop. It's the caller's job to fall back to compression/hold when this fails, or when
 * the model's attempt still doesn't fit the budget.
 */

const TOOL_NAME = 'shorten_lines';

export interface RewriteLineRequest {
  id: string;
  text: string;
  rewriteBudgetChars: number;
}

export interface RewrittenLine {
  id: string;
  text: string;
}

export interface RewriteOptions {
  language?: 'en' | 'ja';
  baseUrl?: string;
  timeoutMs?: number;
}

const rewriteResultSchema = z.object({
  lines: z.array(z.object({ id: z.string().min(1), text: z.string().min(1) })).min(1),
});

export async function rewriteLines(
  reel: Reel,
  requests: RewriteLineRequest[],
  options: RewriteOptions = {},
): Promise<RewrittenLine[]> {
  if (requests.length === 0) return [];

  const tools = [
    {
      type: 'function' as const,
      function: {
        name: TOOL_NAME,
        description: 'Emit shortened narration lines that fit their character budgets.',
        parameters: buildToolSchema(),
      },
    },
  ];

  const response = await chatCompletion(
    {
      model: M3_MODEL,
      messages: buildMessages(reel, requests, options.language ?? 'en'),
      tools,
      tool_choice: { type: 'function', function: { name: TOOL_NAME } },
    },
    { baseUrl: options.baseUrl, timeoutMs: options.timeoutMs },
  );

  const toolCall = response.choices[0]?.message.tool_calls?.[0];
  if (toolCall === undefined) throw new Error(`model did not call the "${TOOL_NAME}" tool`);

  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch (err) {
    throw new Error(`tool call arguments were not valid JSON: ${errMessage(err)}`);
  }

  const parsed = rewriteResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`invalid rewrite response:\n${formatZodIssues(parsed.error)}`);

  return parsed.data.lines;
}

function buildToolSchema(): unknown {
  const schema = z.toJSONSchema(rewriteResultSchema);
  delete schema.$schema;
  return schema;
}

function buildMessages(reel: Reel, requests: RewriteLineRequest[], language: 'en' | 'ja'): ChatMessage[] {
  const languageInstruction =
    language === 'ja' ? 'Write the shortened narration in Japanese.' : 'Write the shortened narration in English.';

  const system = [
    `You shorten narration lines for the launch-video reel "${reel.title}" so each fits its time budget.`,
    `Call the "${TOOL_NAME}" tool exactly once with one entry per requested line — do not respond with plain text.`,
    languageInstruction,
    'Preserve meaning and tone; cut filler and restructure sentences rather than truncating mid-word.',
    'Get as close under each budget as you can. If a line truly cannot fit, return your best (still-shortened) attempt anyway.',
  ].join('\n');

  const user = [
    'Shorten these narration lines (character budget includes spaces and punctuation):',
    ...requests.map((r) => `- id=${r.id} budget=${r.rewriteBudgetChars} chars: "${r.text}"`),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
