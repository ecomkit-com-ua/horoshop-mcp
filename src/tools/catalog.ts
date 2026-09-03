/** Catalog: catalog/export, catalog/import, pages/export. */

import * as z from 'zod';
import { compact } from '../format.js';
import { callApi, IDEMPOTENT_WRITE, READ_ONLY, type ToolContext } from './shared.js';

/** Horoshop refuses more than 500 products per export to protect the store's server. */
const EXPORT_MAX_LIMIT = 500;

export function registerCatalogTools(ctx: ToolContext): void {
  ctx.server.registerTool(
    'horoshop_products_export',
    {
      title: 'Export Horoshop products',
      description:
        'Exports products from the store catalog (API function catalog/export): titles, ' +
        'articles, prices, availability, categories, characteristics, images, stock residues ' +
        'and SEO fields. Filter by category, by article, or by whether the product is shown. ' +
        `Horoshop caps a single export at ${EXPORT_MAX_LIMIT} products — page with offset. ` +
        'Exported fields vary by the data template attached to each product, so a field missing ' +
        'from the result may simply not exist on that product.',
      inputSchema: z.object({
        parent_id: z
          .union([z.number().int(), z.array(z.number().int())])
          .optional()
          .describe('Category id, or a list of ids. Get ids from horoshop_categories_export.'),
        parent: z
          .string()
          .optional()
          .describe(
            'Category path instead of an id, backslash-separated, e.g. ' +
              '"Розвиваючі іграшки \\ Іграшки для малюків". Prefer parent_id.',
          ),
        article: z
          .union([z.string(), z.array(z.string())])
          .optional()
          .describe('Article (SKU), or a list of them. Requires Horoshop 3.21.1 or newer.'),
        display_in_showcase: z
          .union([z.literal(0), z.literal(1)])
          .optional()
          .describe('1 for products shown on the site, 0 for hidden ones.'),
        include_params: z
          .array(z.string())
          .optional()
          .describe(
            'Only export these fields. The keys article, parent_article and parent are always ' +
              'returned. Use this to keep large exports readable.',
          ),
        exclude_params: z
          .array(z.string())
          .optional()
          .describe('Fields to leave out. Takes priority over include_params.'),
        limit: z
          .number()
          .int()
          .positive()
          .default(50)
          .describe(`How many products to return. Horoshop's hard maximum is ${EXPORT_MAX_LIMIT}.`),
        offset: z.number().int().min(0).optional().describe('Skip this many products — for paging.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ parent_id, parent, article, display_in_showcase, include_params, exclude_params, limit, offset }) => {
      const effectiveLimit = Math.min(limit, EXPORT_MAX_LIMIT);

      // The docs nest the selection criteria under `expr` and keep paging at the top level.
      const expr = compact({
        'parent.id': parent_id,
        parent,
        article,
        display_in_showcase,
      });

      const params = compact({
        expr: Object.keys(expr).length ? expr : undefined,
        limit: effectiveLimit,
        offset,
        includedParams: include_params,
        excludedParams: exclude_params,
      });

      return callApi(ctx, 'catalog/export', params, {
        notes: [
          limit > EXPORT_MAX_LIMIT
            ? `limit was lowered from ${limit} to ${EXPORT_MAX_LIMIT}: Horoshop refuses larger exports.`
            : undefined,
          `Showing up to ${effectiveLimit} products from offset ${offset ?? 0}. ` +
            `For the next page call again with offset ${(offset ?? 0) + effectiveLimit}.`,
        ],
      });
    },
  );

  ctx.server.registerTool(
    'horoshop_categories_export',
    {
      title: 'Export Horoshop categories',
      description:
        'Lists the store catalog sections (API function pages/export) with their ids, parent ids, ' +
        'titles per language, section discount and image. Call this to resolve the category ids ' +
        'that horoshop_products_export and horoshop_products_import expect. Note that Horoshop ' +
        'returns content pages such as "Contacts" or "About us" alongside real product ' +
        'categories — they are not distinguishable by a flag, only by where they sit in the tree.',
      inputSchema: z.object({
        parent: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Parent section id to list children of. 0 is the root.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ parent }) => callApi(ctx, 'pages/export', { parent }),
  );

  if (ctx.config.readOnly) return;

  ctx.server.registerTool(
    'horoshop_products_import',
    {
      title: 'Import Horoshop products',
      description:
        'Creates or updates products in the store catalog (API function catalog/import). ' +
        'Products are matched by "article"; an unknown article creates a new product.\n\n' +
        'DESTRUCTIVE DEFAULTS — read before calling:\n' +
        '- images, gallery_common and gallery_360 each default to override:true, which DELETES ' +
        'the existing gallery before uploading. Pass override:false to append, or omit the ' +
        'gallery entirely to leave it alone.\n' +
        '- accessories and gifts REPLACE the current lists rather than adding to them.\n' +
        'There is no undo. Update one test article first and verify with horoshop_products_export.\n\n' +
        'Each product is a free-form object matching the Horoshop docs. Required: "article". ' +
        'For a NEW product also "title" and either "parent" (backslash-separated category path) ' +
        'or "parent": {"id": N}. Common fields: price, price_old, discount, presence, currency, ' +
        'description, seo_title, seo_description, brand, gtin, mpn, icons, characteristics, ' +
        'display_in_showcase. Text fields accept either a plain value for all languages or ' +
        '{"ua": "...", "ru": "..."}. Stock goes in residues[{warehouse, quantity}] and only works ' +
        'when warehouse tracking is on; "presence" only works when it is off. Images must be ' +
        'public URLs, at most 5 MB, jpeg/gif/png.\n\n' +
        'The result is a per-article log: code 0 means imported, other codes explain what failed.',
      inputSchema: z.object({
        products: z
          .array(z.record(z.string(), z.unknown()))
          .min(1)
          .describe('Products to create or update. Each object needs at least "article".'),
      }),
      annotations: IDEMPOTENT_WRITE,
    },
    async ({ products }) => {
      const missing = products.filter((p) => !p || typeof p !== 'object' || !('article' in p)).length;
      if (missing) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${missing} of ${products.length} products have no "article" field. Horoshop ` +
                `matches products by article and rejects entries without one — nothing was sent.`,
            },
          ],
          isError: true,
        };
      }
      return callApi(ctx, 'catalog/import', { products });
    },
  );
}
