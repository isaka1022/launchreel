import type { z } from 'zod';

/**
 * Shared by the CLI's own error output and the model repair loop, so a failed Reel is
 * described the same way everywhere: one `path: message` line per issue.
 */
export function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('\n');
}
