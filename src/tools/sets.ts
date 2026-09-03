/** Product sets ("Разом дешевше"): productSet/import, productSet/remove. */

import * as z from 'zod';
import { callApi, DESTRUCTIVE, IDEMPOTENT_WRITE, type ToolContext } from './shared.js';

export function registerProductSetTools(ctx: ToolContext): void {
  if (ctx.config.readOnly) return;

  ctx.server.registerTool(
    'horoshop_product_sets_import',
    {
      title: 'Import Horoshop product sets',
      description:
        'Creates or updates bundles of products sold together at a discount (API function ' +
        'productSet/import). A set is matched by its own "article", which must be unique across ' +
        'both sets and products. A set holds at least two and by default at most five products, ' +
        'referenced by their articles — each must already exist in the catalog.\n\n' +
        'The result is a per-set log: code 0 imported, 101 article missing, 102 the article ' +
        'collides with an existing product, 104 a member product was not found, 106 unknown currency.',
      inputSchema: z.object({
        items: z
          .array(
            z.object({
              article: z.string().describe('Unique article of the set itself.'),
              products: z
                .array(z.string())
                .min(2)
                .describe('Articles of the products in the set. At least 2, by default at most 5.'),
              title: z.string().optional().describe('Set name. Defaults to "Разом дешевше".'),
              discountPercent: z
                .number()
                .int()
                .min(0)
                .max(100)
                .optional()
                .describe('Discount on the set, as a whole percentage.'),
              discountedPrice: z
                .number()
                .optional()
                .describe('Final set price. Computed from the discount if omitted.'),
              currency: z.string().optional().describe('ISO currency code, e.g. "UAH".'),
              enabled: z.boolean().optional().describe('Whether the set is active.'),
              sortOrder: z
                .number()
                .int()
                .optional()
                .describe('Display order — lower values rank higher.'),
            }),
          )
          .min(1)
          .describe('Product sets to create or update.'),
      }),
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ items }) => callApi(ctx, 'productSet/import', { items }),
  );

  ctx.server.registerTool(
    'horoshop_product_sets_remove',
    {
      title: 'Delete Horoshop product sets',
      description:
        'Permanently deletes product sets by article (API function productSet/remove). This ' +
        'removes the bundle only, not the products in it. There is no undo — confirm the exact ' +
        'articles before calling.',
      inputSchema: z.object({
        articles: z.array(z.string()).min(1).describe('Articles of the sets to delete.'),
      }),
      annotations: DESTRUCTIVE,
    },
    async ({ articles }) => callApi(ctx, 'productSet/remove', { articles }),
  );
}
