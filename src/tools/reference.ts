/**
 * Store reference data — the eight token-only lookups behind one tool.
 *
 * Separate tools for these would be eight zero-argument entries cluttering the tool list; they
 * are all "read a small dictionary from the store".
 */

import * as z from 'zod';
import { compact } from '../format.js';
import { callApi, READ_ONLY, type ToolContext } from './shared.js';

const KINDS = {
  delivery: {
    fn: 'delivery/export',
    what:
      'delivery options: id, titles per language, delivery type id, enabled flag, the payment ' +
      'option ids each one allows, and the price thresholds in price_options',
  },
  delivery_types: {
    fn: 'delivery/exportTypes',
    what: 'delivery types referenced by delivery option "type" (courier, pickup, Ukrposhta and so on)',
  },
  payment: {
    fn: 'payment/export',
    what:
      'payment options: id, titles and descriptions per language, payment method id, enabled ' +
      'flag, gateway link and payment instructions',
  },
  payment_methods: {
    fn: 'payment/exportMethods',
    what: 'payment methods referenced by payment option "payment_method", with the is_simple flag',
  },
  currencies: {
    fn: 'currency/export',
    what: 'currencies and their exchange rates',
  },
  icons: {
    fn: 'icons/export',
    what: 'product stickers/icons ("Sale", "New", "Hit"). Requires Horoshop 4.0 or newer',
  },
  customer_groups: {
    fn: 'customer-groups/export',
    what:
      'B2B customer groups: visible price level, product visibility, dropshipping flag and the ' +
      'allowed payment and delivery method ids. Horoshop B2B stores only',
  },
  price_levels: {
    fn: 'price-levels/export',
    what:
      'B2B price levels (retail, wholesale tiers) — the level_id values catalog/import expects ' +
      'in price_levels. Horoshop B2B stores only',
  },
} as const;

type Kind = keyof typeof KINDS;

/** Doc bugs and gotchas worth telling the model about, per lookup. */
const NOTES: Partial<Record<Kind, string>> = {
  payment_methods:
    'The Horoshop docs call this field "payment" in prose; the real response key is "paymentMethods".',
  delivery_types:
    'Language variants live under title, i.e. deliveryTypes[i].title.ua, despite what the docs say.',
  customer_groups: 'Returns UNDEFINED_FUNCTION or EMPTY on stores without the B2B module.',
  price_levels: 'Returns UNDEFINED_FUNCTION or EMPTY on stores without the B2B module.',
  icons: 'Returns UNDEFINED_FUNCTION on Horoshop older than 4.0.',
};

export function registerReferenceTools(ctx: ToolContext): void {
  const catalogue = (Object.keys(KINDS) as Kind[]).map((k) => `- ${k}: ${KINDS[k].what}`).join('\n');

  ctx.server.registerTool(
    'horoshop_store_reference',
    {
      title: 'Read Horoshop store reference data',
      description:
        'Reads a store dictionary. These ids are what orders and products refer to, so fetch the ' +
        'relevant one before interpreting an order or building an import.\n\n' +
        `Available kinds:\n${catalogue}`,
      inputSchema: z.object({
        kind: z
          .enum(Object.keys(KINDS) as [Kind, ...Kind[]])
          .describe('Which dictionary to read.'),
        iso: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe(
            'currencies only: ISO code or codes to fetch. Horoshop IGNORES this unless ' +
              'enabled_only is explicitly false, because enabled_only defaults to on.',
          ),
        id: z
          .union([z.number().int(), z.array(z.number().int())])
          .optional()
          .describe('currencies only: currency id or ids to fetch.'),
        enabled_only: z
          .boolean()
          .optional()
          .describe(
            'currencies only: return just the currencies enabled on the storefront. Horoshop ' +
              'treats this as ON by default — pass false to fetch every currency or to make ' +
              '"iso" take effect.',
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ kind, iso, id, enabled_only }) => {
      const { fn } = KINDS[kind];
      const params =
        kind === 'currencies' ? compact({ iso, id, enabledOnly: enabled_only }) : {};

      const misuse =
        kind !== 'currencies' && (iso !== undefined || id !== undefined || enabled_only !== undefined)
          ? `iso, id and enabled_only only apply to kind "currencies" — they were ignored for "${kind}".`
          : undefined;

      const isoIgnored =
        kind === 'currencies' && iso !== undefined && enabled_only !== false
          ? 'Note: "iso" was sent but enabled_only is not false, so Horoshop ignores the filter ' +
            'and returns all enabled currencies. Pass enabled_only: false to filter by ISO code.'
          : undefined;

      return callApi(ctx, fn, params, { notes: [misuse, isoIgnored, NOTES[kind]] });
    },
  );
}
