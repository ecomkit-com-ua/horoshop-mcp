/** Orders: orders/get, orders/get_available_statuses, orders/update. */

import * as z from 'zod';
import { compact } from '../format.js';
import { callApi, DESTRUCTIVE, READ_ONLY, type ToolContext } from './shared.js';

const DATE_HINT =
  'Accepted formats: "YYYY-MM-DD", "DD.MM.YYYY", and since Horoshop 3.30 also ' +
  '"YYYY-MM-DD HH:mm:ss". Inclusive.';

const ORDER_STATUS_HINT =
  'Built-in statuses: 1 new, 2 processing, 3 delivered, 4 not delivered, 6 shipping. ' +
  'A store can define its own — call horoshop_order_statuses for the real list.';

export function registerOrderTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    'horoshop_orders_list',
    {
      title: 'List Horoshop orders',
      description:
        'Lists orders from the Horoshop store (API function orders/get), with their line items, ' +
        'delivery and payment details, totals, discounts and UTM analytics. ' +
        `Filter by date range, order ids or status. ${ORDER_STATUS_HINT} ` +
        'Order data comes back in the language of the site version the order was placed on.',
      inputSchema: z.object({
        from: z.string().optional().describe(`Only orders placed on or after this date. ${DATE_HINT}`),
        to: z.string().optional().describe(`Only orders placed on or before this date. ${DATE_HINT}`),
        ids: z.array(z.number().int()).optional().describe('Specific order numbers to fetch.'),
        status: z
          .union([z.number().int(), z.array(z.number().int())])
          .optional()
          .describe(`Status id, or a list of them. ${ORDER_STATUS_HINT}`),
        additional_data: z
          .boolean()
          .optional()
          .describe(
            'Include the delivery-operator block (Nova Poshta / Ukrposhta waybill numbers, ' +
              'sender and recipient warehouses, tracking status). Off by default.',
          ),
        limit: z.number().int().positive().max(1000).default(50).describe('How many orders to return.'),
        offset: z.number().int().min(0).optional().describe('Skip this many orders — for paging.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ from, to, ids, status, additional_data, limit, offset }) => {
      // Horoshop ignores `offset` unless `limit` travels with it, so limit always goes on the wire.
      const params = compact({
        from,
        to,
        ids,
        status,
        additionalData: additional_data,
        limit,
        offset,
      });

      const result = await callApi(ctx, 'orders/get', params, {
        notes: [
          `Requested up to ${limit} orders starting at offset ${offset ?? 0}. ` +
            `For the next page call again with offset ${(offset ?? 0) + limit}.`,
        ],
      });
      return result;
    },
  );

  ctx.server.registerTool(
    'horoshop_order_statuses',
    {
      title: 'List Horoshop order statuses',
      description:
        'Returns every order status configured on the store, with its id, its titles per site ' +
        'language, and whether it counts as a successful delivery (API function ' +
        'orders/get_available_statuses). Requires Horoshop 4.0 or newer. Use this before ' +
        'filtering or updating orders, since stores can rename statuses and add their own.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      callApi(ctx, 'orders/get_available_statuses', {}, {
        notes: [
          'If this returns UNDEFINED_FUNCTION, the store runs a Horoshop older than 4.0 — fall ' +
            'back to the built-in ids: 1 new, 2 processing, 3 delivered, 4 not delivered, 6 shipping.',
        ],
      }),
  );

  if (ctx.config.readOnly) return;

  ctx.server.registerTool(
    'horoshop_orders_update',
    {
      title: 'Update Horoshop orders',
      description:
        'Changes the status, payment flag or tracking code of existing orders (API function ' +
        'orders/update). This writes to a live store: a status change is visible to the customer ' +
        'and can trigger notification emails. Verify the status ids with horoshop_order_statuses ' +
        'first, and update only the orders you were asked to. ' +
        'A partial failure comes back as status WARNING with a per-order log.',
      inputSchema: z.object({
        orders: z
          .array(
            z.object({
              order_id: z.number().int().describe('The order number.'),
              status: z
                .number()
                .int()
                .optional()
                .describe(`New status id. ${ORDER_STATUS_HINT}`),
              payed: z
                .number()
                .int()
                .min(0)
                .max(1)
                .optional()
                .describe('Payment flag: 1 paid, 0 not paid.'),
              tracking_code: z
                .string()
                .optional()
                .describe(
                  'Legacy Ukrposhta tracking code shown in the customer account. Horoshop marks ' +
                    'this parameter as old.',
                ),
              own_tracking_code: z
                .string()
                .optional()
                .describe(
                  'Nova Poshta or Ukrposhta tracking code generated in an external system. ' +
                    'Horoshop marks this as not yet released, so it may be rejected.',
                ),
            }),
          )
          .min(1)
          .describe('Orders to update, each identified by order_id.'),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ orders }) => callApi(ctx, 'orders/update', { orders }),
  );
}
