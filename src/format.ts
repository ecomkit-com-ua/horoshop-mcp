/**
 * Turning an ApiResult into an MCP tool result.
 *
 * Three jobs: never throw for an API-level error (a thrown exception becomes an opaque protocol
 * error the model cannot recover from — an `isError` result it can read and retry), never flood
 * the context (a 500-product catalog export is megabytes), and never lose a record between pages.
 *
 * That last one is why the pagination hint is built here and not by the calling tool. Paging and
 * truncation interact: the tool knows the limit it asked for, but only this module knows how many
 * records actually survived the size budget, and the next offset has to be counted from what was
 * shown. Advising `offset + limit` after a truncated page silently skips everything that was
 * fetched but dropped.
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

/** What a paginated tool asked Horoshop for, so the next offset can be derived from the result. */
export interface Pagination {
  /** Response key holding the records, e.g. "products". Falls back to the longest array found. */
  key: string;
  /** What to call the records in prose, e.g. "products", "orders", "customers". */
  label: string;
  /** The offset that was requested. */
  offset: number;
  /** The limit that actually went on the wire, after any clamping. */
  limit: number;
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The records array inside a response. `key` is "" when the payload is itself an array. */
interface Records {
  key: string;
  items: unknown[];
}

/**
 * Locates the records array in a response: the named key if present, otherwise the longest
 * array-valued property. Horoshop names these inconsistently across functions, and the docs
 * do not always match the wire, so the fallback matters.
 */
function findRecords(data: unknown, preferredKey?: string): Records | undefined {
  if (Array.isArray(data)) return { key: '', items: data };
  if (!data || typeof data !== 'object') return undefined;

  const entries = Object.entries(data as Record<string, unknown>);

  if (preferredKey) {
    const named = entries.find(([key, value]) => key === preferredKey && Array.isArray(value));
    if (named) return { key: named[0], items: named[1] as unknown[] };
  }

  let best: Records | undefined;
  for (const [key, value] of entries) {
    if (!Array.isArray(value)) continue;
    if (!best || value.length > best.items.length) best = { key, items: value };
  }
  return best;
}

interface Shrunk {
  text: string;
  /** Records kept in the text, when a records array was found. */
  kept?: number;
  /** Records the API actually returned, before trimming. */
  total?: number;
  /** The payload holds no records array and had to be cut mid-string, so the JSON is broken. */
  hardCut?: boolean;
}

/**
 * Shrinks a payload to fit the budget. If a records array is present, items are dropped from the
 * end and counted, which keeps the result valid JSON. Anything else falls back to a string cut.
 */
function shrink(data: unknown, maxBytes: number, records?: Records): Shrunk {
  const full = JSON.stringify(data, null, 2) ?? 'null';
  const total = records?.items.length;

  if (bytes(full) <= maxBytes) return { text: full, kept: total, total };

  if (records && records.items.length >= 1) {
    const { key, items } = records;
    const rebuild = (count: number): unknown =>
      key === '' ? items.slice(0, count) : { ...(data as Record<string, unknown>), [key]: items.slice(0, count) };

    // Binary search for the largest prefix of the array that fits.
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (bytes(JSON.stringify(rebuild(mid), null, 2)) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    const kept = Math.max(lo, 0);
    return { text: JSON.stringify(rebuild(kept), null, 2), kept, total };
  }

  return { text: full.slice(0, maxBytes), hardCut: true };
}

/**
 * The paging advice. Every branch either points at an offset that resumes exactly where the
 * shown records stop, or gives no offset at all — it must never point past a dropped record.
 */
function paginationNotes(p: Pagination, shrunk: Shrunk): string[] {
  const { kept, total, hardCut } = shrunk;

  if (hardCut || kept === undefined || total === undefined) {
    return [
      `Truncated: the response exceeded the size budget and was cut mid-record, so the JSON ` +
        `below is incomplete and no safe next offset can be given. Lower the limit (it was ` +
        `${p.limit}) or request fewer fields, then call again from offset ${p.offset}.`,
    ];
  }

  if (kept < total) {
    if (kept === 0) {
      return [
        `The response budget could not fit even one of the ${total} ${p.label} Horoshop ` +
          `returned. Paging cannot help here — request fewer fields, or raise ` +
          `HOROSHOP_MAX_RESPONSE_BYTES.`,
      ];
    }
    return [
      `Showing ${kept} of the ${total} ${p.label} Horoshop returned for this page: the rest did ` +
        `not fit the response budget.`,
      `Continue at offset ${p.offset + kept} — not ${p.offset + p.limit}. ${total - kept} ` +
        `${p.label} were fetched but dropped, and resuming at ${p.offset + p.limit} would skip ` +
        `them. To fit more per call, lower the limit or request fewer fields.`,
    ];
  }

  // Nothing was dropped: the page is whole, so the requested limit tells us if more may follow.
  if (total === 0) return []; // The EMPTY note already says this.

  if (total < p.limit) {
    return [
      `Showing all ${total} ${p.label} from offset ${p.offset}. Horoshop returned fewer than the ` +
        `${p.limit} requested, so this is the last page.`,
    ];
  }

  return [
    `Showing ${total} ${p.label} from offset ${p.offset}. For the next page call again with ` +
      `offset ${p.offset + total}.`,
  ];
}

export interface ResultOptions {
  maxBytes: number;
  /** Extra guidance for the model — doc gotchas, warnings about partial failures. */
  notes?: Array<string | undefined>;
  /** Set by paginated tools; the paging advice is derived from the trimmed result. */
  pagination?: Pagination;
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

  const records = findRecords(result.data, options.pagination?.key);
  const shrunk = shrink(result.data, options.maxBytes, records);

  if (options.pagination) {
    notes.push(...paginationNotes(options.pagination, shrunk));
  } else if (shrunk.hardCut) {
    notes.push('Truncated: the response exceeded the size budget and was cut. Narrow the request.');
  } else if (shrunk.kept !== undefined && shrunk.total !== undefined && shrunk.kept < shrunk.total) {
    notes.push(
      `Truncated: ${shrunk.kept} of ${shrunk.total} "${records?.key || 'records'}" entries are ` +
        `shown, the rest were dropped to fit the response budget. Narrow the request to see the rest.`,
    );
  }

  const body = notes.length ? `${notes.join('\n')}\n\n${shrunk.text}` : shrunk.text;

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
