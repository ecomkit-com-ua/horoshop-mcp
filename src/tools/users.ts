/** Customers: users/export, users/import. */

import * as z from 'zod';
import { compact } from '../format.js';
import { callApi, IDEMPOTENT_WRITE, READ_ONLY, type ToolContext } from './shared.js';

const DATE_HINT =
  'Accepted formats: "YYYY-MM-DD", "DD.MM.YYYY", and since Horoshop 3.30 also ' +
  '"YYYY-MM-DD HH:mm:ss".';

export function registerUserTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    'horoshop_users_export',
    {
      title: 'Export Horoshop customers',
      description:
        'Exports registered customers (API function users/export): id, name, email, phone, ' +
        'delivery country/city/address, registration date, newsletter consent and the internal ' +
        'manager note. On Horoshop B2B stores it also returns the customer group, balance and ' +
        'assigned manager. Filter by registration date. This returns personal data — export only ' +
        'what the task needs.',
      inputSchema: z.object({
        from: z.string().optional().describe(`Registered on or after this date. ${DATE_HINT}`),
        to: z.string().optional().describe(`Registered on or before this date. ${DATE_HINT}`),
        limit: z.number().int().positive().max(1000).default(50).describe('How many customers to return.'),
        offset: z.number().int().min(0).optional().describe('Skip this many customers — for paging.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to, limit, offset }) =>
      // As with orders, Horoshop ignores offset unless limit is sent too.
      callApi(ctx, 'users/export', compact({ from, to, limit, offset }), {
        notes: [
          `Showing up to ${limit} customers from offset ${offset ?? 0}. ` +
            `For the next page call again with offset ${(offset ?? 0) + limit}.`,
        ],
      }),
  );

  if (ctx.config.readOnly) return;

  ctx.server.registerTool(
    'horoshop_users_import',
    {
      title: 'Import Horoshop customers',
      description:
        'Creates or updates customer accounts (API function users/import). Customers are matched ' +
        'by email, which must be unique. Required per customer: "title" (full name) and "email". ' +
        'Optional: phone, country, city, address, newsletter_subscription (0/1), note (an ' +
        'internal manager comment, never shown to the customer), and discount_card ' +
        '{discount, active, date_limit, status}. Horoshop B2B stores also accept ' +
        'customer_group_id, balance, balance_currency, manager_id, company, role and site_link.\n\n' +
        'This writes real customer records on a live store. The result is a per-record log: ' +
        'code 0 imported, 1 missing required fields, 2 validation error, 3 unhandled error.',
      inputSchema: z.object({
        users: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .describe('Customers to create or update. Each needs at least "title" and "email".'),
      }),
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ users }) => {
      const invalid = users.filter((u) => !u || typeof u !== 'object' || !('email' in u)).length;
      if (invalid) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${invalid} of ${users.length} customers have no "email" field. Horoshop matches ` +
                `customers by email and rejects entries without one — nothing was sent.`,
            },
          ],
          isError: true,
        };
      }
      return callApi(ctx, 'users/import', { users });
    },
  );
}
