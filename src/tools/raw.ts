/**
 * Escape hatch.
 *
 * The typed tools cover the documented API, but Horoshop ships new functions between releases of
 * this package, and B2B stores have corners the docs barely describe. This calls anything.
 */

import * as z from 'zod';
import { callApi, type ToolContext } from './shared.js';

const KNOWN_READ_ONLY = /(?:^|\/)(?:export|exportTypes|exportMethods|get|get_available_statuses)$/;

export function registerRawTool(ctx: ToolContext): void {
  ctx.server.registerTool(
    'horoshop_call',
    {
      title: 'Call any Horoshop API function',
      description:
        'Calls a Horoshop API function directly, for anything the dedicated tools do not cover ' +
        '(new functions, undocumented parameters, B2B specifics). Pass the function name as it ' +
        'appears in the docs, e.g. "catalog/export", "orders/get", "customer-groups/export". ' +
        'Authentication is handled for you — do not pass a token. ' +
        'Prefer the dedicated tools when one exists: they carry the parameter names, the limits ' +
        'and the warnings. Docs: https://horoshop.notion.site/api-doc',
      inputSchema: z.object({
        function: z
          .string()
          .min(1)
          .describe('API function path without /api/ and without a token, e.g. "catalog/export".'),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Request body parameters, exactly as the docs name them.'),
      }),
      annotations: {
        // The target is caller-chosen, so this cannot be advertised as read-only.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ function: fn, params }) => {
      if (/\btoken\b/i.test(fn)) {
        return {
          content: [{ type: 'text' as const, text: 'Pass only the function path — the token is added for you.' }],
          isError: true,
        };
      }
      if (ctx.config.readOnly && !KNOWN_READ_ONLY.test(fn.replace(/\/+$/, ''))) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `HOROSHOP_READONLY is set and "${fn}" is not a recognised read function, so it ` +
                `was not called. Unset HOROSHOP_READONLY to allow writes.`,
            },
          ],
          isError: true,
        };
      }
      const cleaned = params ? { ...params } : {};
      delete cleaned.token;
      return callApi(ctx, fn, cleaned);
    },
  );
}
