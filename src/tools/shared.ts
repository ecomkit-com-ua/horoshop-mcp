/** Wiring shared by every tool module. */

import type { McpServer } from '@modelcontextprotocol/server';
import type { Config } from '../config.js';
import type { HoroshopClient } from '../client.js';
import { errorResult, toolResult, type Pagination, type ToolTextResult } from '../format.js';

export interface ToolContext {
  server: McpServer;
  client: HoroshopClient;
  config: Config;
}

export interface CallOptions {
  notes?: Array<string | undefined>;
  /** Paginated tools pass this instead of writing their own paging note — see format.ts. */
  pagination?: Pagination;
}

/**
 * Calls an API function and formats the result. Every failure mode — network, bad credentials,
 * API-level error — comes back as an `isError` tool result rather than a thrown exception.
 */
export async function callApi(
  ctx: ToolContext,
  fn: string,
  params: Record<string, unknown> = {},
  options: CallOptions = {},
): Promise<ToolTextResult> {
  try {
    const result = await ctx.client.call(fn, params);
    return toolResult(fn, result, {
      maxBytes: ctx.config.maxResponseBytes,
      notes: options.notes,
      pagination: options.pagination,
    });
  } catch (err) {
    return errorResult(fn, err);
  }
}

/** Annotation presets, so the hints stay consistent across modules. */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const DESTRUCTIVE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

/** A write that creates or replaces by key, so repeating it lands the same state. */
export const IDEMPOTENT_WRITE = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
} as const;
