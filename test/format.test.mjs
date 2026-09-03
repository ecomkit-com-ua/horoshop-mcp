/**
 * Unit tests for the result formatter — above all for the interaction between paging and
 * truncation, where a wrong next offset silently loses records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { compact, errorResult, toolResult } from '../dist/format.js';
import { notesOf, parseBody } from './support/mcp-client.mjs';

/** A successful API result carrying `data`. */
const ok = (data, status = 'OK') => ({ ok: true, status, data, httpStatus: 200 });

/** `count` records, each roughly `padding` bytes of filler. */
const records = (count, padding = 100) =>
  Array.from({ length: count }, (_, i) => ({ id: i, filler: 'x'.repeat(padding) }));

const render = (result, options) => toolResult('catalog/export', result, options).content[0].text;

const paging = (over = {}) => ({
  key: 'products',
  label: 'products',
  offset: 0,
  limit: 50,
  ...over,
});

test('compact drops undefined but keeps falsy values', () => {
  assert.deepEqual(compact({ a: 1, b: undefined, c: 0, d: false, e: null }), {
    a: 1,
    c: 0,
    d: false,
    e: null,
  });
});

test('a full page advises the next offset', () => {
  const text = render(ok({ products: records(50, 10) }), {
    maxBytes: 1_000_000,
    pagination: paging(),
  });
  assert.match(notesOf(text), /Showing 50 products from offset 0/);
  assert.match(notesOf(text), /call again with offset 50/);
  assert.equal(parseBody(text).products.length, 50);
});

test('a short page is reported as the last page, with no next offset', () => {
  const notes = notesOf(
    render(ok({ products: records(12, 10) }), { maxBytes: 1_000_000, pagination: paging() }),
  );
  assert.match(notes, /Showing all 12 products from offset 0/);
  assert.match(notes, /this is the last page/);
  assert.doesNotMatch(notes, /call again with offset/);
});

test('the next offset counts from the records shown, not the limit requested', () => {
  // 50 records asked for and returned, but only some of them fit the budget.
  const text = render(ok({ products: records(50, 200) }), {
    maxBytes: 4_000,
    pagination: paging(),
  });
  const shown = parseBody(text).products.length;
  const notes = notesOf(text);

  assert.ok(shown > 0 && shown < 50, `expected a partial page, got ${shown} of 50`);
  assert.match(notes, new RegExp(`Showing ${shown} of the 50 products`));
  // The whole point: resume where the visible records stop.
  assert.match(notes, new RegExp(`Continue at offset ${shown}\\b`));
  // And say plainly that the naive offset would skip the dropped ones.
  assert.match(notes, new RegExp(`not ${0 + 50}\\b`));
  assert.match(notes, new RegExp(`${50 - shown} products were fetched but dropped`));
});

test('the next offset respects a non-zero starting offset', () => {
  const text = render(ok({ products: records(50, 200) }), {
    maxBytes: 4_000,
    pagination: paging({ offset: 300 }),
  });
  const shown = parseBody(text).products.length;
  assert.match(notesOf(text), new RegExp(`Continue at offset ${300 + shown}\\b`));
  assert.match(notesOf(text), new RegExp(`not ${300 + 50}\\b`));
});

test('a truncated page stays valid JSON', () => {
  const text = render(ok({ products: records(50, 200), total: 500 }), {
    maxBytes: 4_000,
    pagination: paging(),
  });
  const body = parseBody(text); // throws if the JSON was cut mid-record
  assert.equal(body.total, 500, 'sibling keys survive truncation');
  assert.ok(Array.isArray(body.products));
});

test('when not even one record fits, paging is not offered as the fix', () => {
  const notes = notesOf(
    render(ok({ products: records(3, 5_000) }), { maxBytes: 500, pagination: paging() }),
  );
  assert.match(notes, /could not fit even one of the 3 products/);
  assert.match(notes, /Paging cannot help/);
  assert.doesNotMatch(notes, /Continue at offset/);
});

test('an EMPTY page says so and offers no offset', () => {
  const notes = notesOf(
    render(ok({ orders: [] }, 'EMPTY'), {
      maxBytes: 1_000_000,
      pagination: paging({ key: 'orders', label: 'orders' }),
    }),
  );
  assert.match(notes, /status EMPTY/);
  assert.doesNotMatch(notes, /Continue at offset|call again with offset/);
});

test('a payload with no records array gives no next offset at all', () => {
  const notes = notesOf(
    render(ok({ blob: 'y'.repeat(5_000) }), { maxBytes: 500, pagination: paging() }),
  );
  assert.match(notes, /cut mid-record/);
  assert.match(notes, /no safe next offset/);
  assert.doesNotMatch(notes, /Continue at offset \d/);
});

test('the records array is found by the named key, not merely the longest one', () => {
  // `log` is longer than `products`, but `products` is what is being paged.
  const data = { products: records(40, 200), log: records(500, 5) };
  const text = render(ok(data), { maxBytes: 6_000, pagination: paging() });
  const body = parseBody(text);
  assert.ok(body.products.length < 40, 'products should be the array that was trimmed');
  assert.equal(body.log.length, 500, 'log must be left intact');
});

test('a missing named key falls back to the longest array', () => {
  // Horoshop does not always name the key the docs promise.
  const text = render(ok({ unexpected: records(40, 200) }), {
    maxBytes: 4_000,
    pagination: paging(),
  });
  const shown = parseBody(text).unexpected.length;
  assert.ok(shown > 0 && shown < 40);
  assert.match(notesOf(text), new RegExp(`Continue at offset ${shown}\\b`));
});

test('WARNING points at the per-record log', () => {
  const notes = notesOf(
    render(ok({ log: [{ order_id: 1, code: 2 }] }, 'WARNING'), { maxBytes: 1_000_000 }),
  );
  assert.match(notes, /status WARNING/);
  assert.match(notes, /"log" array/);
});

test('a non-paginated tool still reports truncation', () => {
  const notes = notesOf(render(ok({ items: records(40, 200) }), { maxBytes: 4_000 }));
  assert.match(notes, /Truncated: \d+ of 40 "items" entries/);
});

test('an API-level error comes back as isError with the payload attached', () => {
  const result = toolResult('orders/get', {
    ok: false,
    status: 'UNDEFINED_FUNCTION',
    data: { message: 'no such function' },
    message: 'no such function',
    httpStatus: 200,
  }, { maxBytes: 1_000_000 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /status UNDEFINED_FUNCTION/);
  assert.match(result.content[0].text, /no such function/);
});

test('a thrown failure becomes a readable isError result', () => {
  const err = Object.assign(new Error('Could not reach Horoshop'), { detail: '<html>502</html>' });
  const result = errorResult('auth', err);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /auth failed: Could not reach Horoshop/);
  assert.match(result.content[0].text, /<html>502<\/html>/);
});

test('extra notes from the tool survive alongside the paging note', () => {
  const notes = notesOf(
    render(ok({ products: records(50, 10) }), {
      maxBytes: 1_000_000,
      notes: ['limit was lowered from 900 to 500: Horoshop refuses larger exports.', undefined],
      pagination: paging(),
    }),
  );
  assert.match(notes, /limit was lowered from 900 to 500/);
  assert.match(notes, /call again with offset 50/);
});
