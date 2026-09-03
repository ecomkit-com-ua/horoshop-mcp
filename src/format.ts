/**
 * Turning an ApiResult into an MCP tool result.
 *
 * Two jobs: never throw for an API-level error (a thrown exception becomes an opaque protocol
 * error the model cannot recover from — an `isError` result it can read and retry), and never
 * flood the context (a 500-product catalog export is megabytes).
 */

import type { ApiResult } from './client.js';

export interface ToolTextResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

/** Drops undefined values so optional tool arguments never reach the API as nulls. */
export function compact(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Shrinks a payload to fit the budget. If the data is an object holding one big array
 * (`{products: [...]}`, `{orders: [...]}`), items are dropped from the end and counted, which
 * keeps the result valid JSON. Anything else falls back to a hard string cut.
 */
function shrink(data: unknown, maxBytes: number): { text: string; note?: string } {
  const full = JSON.stringify(data, null, 2) ?? 'null';
  if (bytes(full) <= maxBytes) return { text: full };

  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data as Record<string, unknown>);
    const arrayEntry = entries.find(([, v]) => Array.isArray(v) && v.length > 1);

    if (arrayEntry) {
      const [key, value] = arrayEntry as [string, unknown[]];
      // Binary search for the largest prefix of the array that fits.
      let lo = 0;
      let hi = value.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        const candidate = { ...(data as Record<string, unknown>), [key]: value.slice(0, mid) };
        if (bytes(JSON.stringify(candidate, null, 2)) <= maxBytes) lo = mid;
        else hi = mid - 1;
      }
      const kept = Math.max(lo, 0);
      const trimmed = { ...(data as Record<string, unknown>), [key]: value.slice(0, kept) };
      return {
        text: JSON.stringify(trimmed, null, 2),
        note:
          `Truncated: ${kept} of ${value.length} "${key}" entries are shown, the rest were ` +
          `dropped to fit the response budget. Narrow the request (a smaller limit, a category ` +
          `or article filter, or fewer fields via include_params) to see the rest.`,
      };
    }
  }

  return {
    text: full.slice(0, maxBytes),
    note: 'Truncated: the response exceeded the size budget and was cut. Narrow the request.',
  };
}

export interface ResultOptions {
  maxBytes: number;
  /** Extra guidance for the model — pagination hints, warnings about partial failures. */
  notes?: Array<string | undefined>;
}

export function toolResult(fn: string, result: ApiResult, options: ResultOptions): ToolTextResult {
  if (!result.ok) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Horoshop API error from ${fn}: status ${result.status}` +
            (result.message ? ` — ${result.message}` : '') +
            `\n\n${JSON.stringify(result.data, null, 2)}`,
        },
      ],
      isError: true,
    };
  }

  const notes = (options.notes ?? []).filter((n): n is string => Boolean(n));

  if (result.status === 'EMPTY') {
    notes.unshift('Horoshop returned status EMPTY: the request was valid but matched no records.');
  }
  // A partial success: some records in the batch failed. response.log says which.
  if (result.status === 'WARNING') {
    notes.unshift(
      'Horoshop returned status WARNING: some records failed. Check the "log" array below — ' +
        'each entry carries the article or id and a per-record code and message.',
    );
  }

  const { text, note } = shrink(result.data, options.maxBytes);
  if (note) notes.push(note);

  const body = notes.length ? `${notes.join('\n')}\n\n${text}` : text;

  return { content: [{ type: 'text', text: body }] };
}

/** Turns an unexpected throw (network, non-JSON, bad credentials) into a readable tool error. */
export function errorResult(fn: string, err: unknown): ToolTextResult {
  const message = err instanceof Error ? err.message : String(err);
  const detail =
    err && typeof err === 'object' && 'detail' in err && (err as { detail?: unknown }).detail
      ? `\n\n${String((err as { detail?: unknown }).detail).slice(0, 1000)}`
      : '';
  return {
    content: [{ type: 'text', text: `${fn} failed: ${message}${detail}` }],
    isError: true,
  };
}
