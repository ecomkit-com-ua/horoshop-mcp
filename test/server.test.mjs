/**
 * Integration tests: the built server, spawned as a child process, driven over stdio JSON-RPC
 * against a mock Horoshop. These cover the wiring the unit tests cannot see — the handshake,
 * the tool surface, the token lifecycle, and how each Horoshop response shape lands.
 */

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';

import { startMock } from './support/mock-horoshop.mjs';
import { connect, notesOf, parseBody, startupFailure } from './support/mcp-client.mjs';

describe('horoshop-mcp server', () => {
  let mock;

  before(async () => {
    mock = await startMock();
  });

  after(async () => {
    await mock.close();
  });

  const open = (env) => connect({ domain: mock.domain, env });

  test('handshake advertises the server and a usable tool surface', async () => {
    const client = await open();
    try {
      assert.equal(client.initialize.serverInfo.name, 'horoshop-mcp');
      const tools = await client.listTools();
      assert.equal(tools.length, 14);
      for (const tool of tools) {
        assert.equal(tool.inputSchema.type, 'object', `${tool.name} has no object input schema`);
        assert.ok(tool.description?.length > 40, `${tool.name} needs a real description`);
      }
    } finally {
      await client.close();
    }
  });

  test('read-only mode hides every mutating tool', async () => {
    const client = await open({ HOROSHOP_READONLY: '1' });
    try {
      const names = await client.toolNames();
      for (const write of [
        'horoshop_orders_update',
        'horoshop_products_import',
        'horoshop_users_import',
        'horoshop_product_sets_import',
        'horoshop_product_sets_remove',
        'horoshop_webhook_subscribe',
        'horoshop_webhook_unsubscribe',
      ]) {
        assert.ok(!names.includes(write), `${write} must be hidden in read-only mode`);
      }
      assert.ok(names.includes('horoshop_orders_list'));
      assert.ok(names.includes('horoshop_products_export'));
    } finally {
      await client.close();
    }
  });

  test('read-only mode also gates the raw escape hatch', async () => {
    const client = await open({ HOROSHOP_READONLY: '1' });
    try {
      for (const fn of ['catalog/import', 'orders/update', 'hooks/subscribe']) {
        const { isError, text } = await client.call('horoshop_call', { function: fn });
        assert.equal(isError, true, `${fn} should be refused`);
        assert.match(text, /HOROSHOP_READONLY is set/);
      }
      for (const fn of ['catalog/export', 'orders/get', 'delivery/exportTypes']) {
        const { isError } = await client.call('horoshop_call', { function: fn });
        assert.equal(isError, false, `${fn} is a read and should be allowed`);
      }
    } finally {
      await client.close();
    }
  });

  test('horoshop_call never forwards a caller-supplied token', async () => {
    const client = await open();
    try {
      await client.call('horoshop_call', {
        function: 'catalog/export',
        params: { limit: 1, token: 'forged-token' },
      });
      const call = mock.state.hits.findLast((h) => h.path === '/api/catalog/export');
      assert.notEqual(call.body.token, 'forged-token', 'the forged token must be stripped');
      assert.match(call.body.token, /^tok-\d+$/, 'the real token must be used instead');
    } finally {
      await client.close();
    }
  });

  describe('token lifecycle', () => {
    test('one login serves many calls', async () => {
      mock.state.reset();
      const client = await open();
      try {
        await client.call('horoshop_order_statuses');
        await client.call('horoshop_order_statuses');
        await client.call('horoshop_order_statuses');
        assert.equal(mock.state.authCalls(), 1);
      } finally {
        await client.close();
      }
    });

    test('an expired token is refreshed and the call retried transparently', async () => {
      const client = await open();
      try {
        await client.call('horoshop_order_statuses');
        mock.state.reset();
        mock.state.expireNext = true;

        const { isError, text } = await client.call('horoshop_order_statuses');
        assert.equal(isError, false, `expected recovery, got: ${text.slice(0, 200)}`);
        assert.equal(mock.state.authCalls(), 1, 'exactly one re-login');
        assert.equal(mock.state.callsTo('orders/get_available_statuses'), 2, 'the call was retried');
      } finally {
        await client.close();
      }
    });

    test('concurrent first calls share a single login', async () => {
      mock.state.reset();
      const client = await open();
      try {
        await Promise.all(
          Array.from({ length: 5 }, () => client.call('horoshop_order_statuses')),
        );
        assert.equal(mock.state.authCalls(), 1, 'the in-flight login must be shared');
        assert.equal(mock.state.callsTo('orders/get_available_statuses'), 5);
      } finally {
        await client.close();
      }
    });
  });

  describe('response shapes', () => {
    test('orders paging reports what came back', async () => {
      const client = await open();
      try {
        const { text } = await client.call('horoshop_orders_list', { limit: 2 });
        assert.equal(parseBody(text).orders.length, 2);
        assert.match(notesOf(text), /Showing 2 orders from offset 0/);
        assert.match(notesOf(text), /call again with offset 2/);
      } finally {
        await client.close();
      }
    });

    test('a page past the end is EMPTY and offers no offset', async () => {
      const client = await open();
      try {
        const { text } = await client.call('horoshop_orders_list', { limit: 2, offset: 99 });
        assert.match(notesOf(text), /status EMPTY/);
        assert.doesNotMatch(notesOf(text), /call again with offset|Continue at offset/);
      } finally {
        await client.close();
      }
    });

    test('a truncated export resumes at the last record shown', async () => {
      const client = await open({ HOROSHOP_MAX_RESPONSE_BYTES: '3000' });
      try {
        const { text } = await client.call('horoshop_products_export', { limit: 50 });
        const shown = parseBody(text).products.length;
        const notes = notesOf(text);

        assert.ok(shown > 0 && shown < 50, `expected truncation, got ${shown} of 50`);
        assert.match(notes, new RegExp(`Continue at offset ${shown}\\b`));
        assert.doesNotMatch(
          notes,
          /Continue at offset 50\b/,
          'must not skip the records that were fetched but dropped',
        );
      } finally {
        await client.close();
      }
    });

    test('WARNING surfaces the per-record log rather than looking like success', async () => {
      const client = await open();
      try {
        const { text } = await client.call('horoshop_orders_update', {
          orders: [{ order_id: 1001, status: 2 }],
        });
        assert.match(notesOf(text), /status WARNING/);
        assert.equal(parseBody(text).log[0].code, 'NOT_FOUND');
      } finally {
        await client.close();
      }
    });

    test('the unenveloped webhook responses count as success', async () => {
      const client = await open();
      try {
        // hooks/subscribe answers HTTP 201 with a bare {"id": n}.
        const sub = await client.call('horoshop_webhook_subscribe', {
          event: 'order_created',
          target_url: 'https://example.com/hook',
        });
        assert.equal(sub.isError, false, sub.text.slice(0, 200));
        assert.equal(parseBody(sub.text).id, 7);

        // hooks/unSubscribe answers HTTP 410 Gone, which is the documented success.
        const unsub = await client.call('horoshop_webhook_unsubscribe', {
          id: 7,
          target_url: 'https://example.com/hook',
        });
        assert.equal(unsub.isError, false, unsub.text.slice(0, 200));
      } finally {
        await client.close();
      }
    });

    test('an unknown API function is an isError result, not a crash', async () => {
      const client = await open();
      try {
        const { isError, text } = await client.call('horoshop_call', { function: 'totally/madeup' });
        assert.equal(isError, true);
        assert.match(text, /UNDEFINED_FUNCTION/);
        // The server must still be alive afterwards.
        assert.equal((await client.call('horoshop_order_statuses')).isError, false);
      } finally {
        await client.close();
      }
    });

    test('an HTML response explains itself instead of a JSON parse error', async () => {
      const client = await open();
      try {
        const { isError, text } = await client.call('horoshop_call', { function: '_html' });
        assert.equal(isError, true);
        assert.match(text, /non-JSON response \(HTTP 502\)/);
        assert.match(text, /Check that the domain is a Horoshop store/);
      } finally {
        await client.close();
      }
    });
  });

  describe('input guards', () => {
    test('bad enum and bad URL are rejected before any request', async () => {
      const client = await open();
      try {
        const bad = await client.call('horoshop_webhook_subscribe', {
          event: 'not_an_event',
          target_url: 'https://example.com/hook',
        });
        assert.equal(bad.isError, true);
        assert.match(bad.text, /Invalid option/);

        const badUrl = await client.call('horoshop_webhook_subscribe', {
          event: 'order_created',
          target_url: 'not-a-url',
        });
        assert.equal(badUrl.isError, true);
        assert.match(badUrl.text, /Invalid URL/);
      } finally {
        await client.close();
      }
    });

    test('an import missing its match key is refused without touching the store', async () => {
      mock.state.reset();
      const client = await open();
      try {
        const products = await client.call('horoshop_products_import', {
          products: [{ title: 'no article here' }],
        });
        assert.equal(products.isError, true);
        assert.match(products.text, /no "article" field/);
        assert.match(products.text, /nothing was sent/);
        assert.equal(mock.state.callsTo('catalog/import'), 0);

        const users = await client.call('horoshop_users_import', {
          users: [{ title: 'no email here' }],
        });
        assert.equal(users.isError, true);
        assert.match(users.text, /no "email" field/);
        assert.equal(mock.state.callsTo('users/import'), 0);
      } finally {
        await client.close();
      }
    });

    test('reference lookups warn when an argument does not apply', async () => {
      const client = await open();
      try {
        const wrongKind = await client.call('horoshop_store_reference', {
          kind: 'payment',
          iso: 'UAH',
        });
        assert.match(wrongKind.text, /only apply to kind "currencies"/);

        const ignored = await client.call('horoshop_store_reference', {
          kind: 'currencies',
          iso: 'UAH',
        });
        assert.match(ignored.text, /Horoshop ignores the filter/);
      } finally {
        await client.close();
      }
    });
  });

  describe('startup and credentials', () => {
    test('rejected credentials name the screen that fixes them', async () => {
      const client = await connect({
        domain: mock.domain,
        env: { HOROSHOP_PASSWORD: 'wrong-password' },
      });
      try {
        const { isError, text } = await client.call('horoshop_order_statuses');
        assert.equal(isError, true);
        assert.match(text, /rejected the credentials/);
        assert.match(text, /Wrong login or password/);
        assert.match(text, /Налаштування → Адміни/);
      } finally {
        await client.close();
      }
    });

    test('missing configuration fails fast and says which variable', async () => {
      const { code, stderr } = await startupFailure({
        HOROSHOP_DOMAIN: '',
        HOROSHOP_LOGIN: '',
        HOROSHOP_PASSWORD: '',
      });
      assert.equal(code, 1);
      assert.match(stderr, /HOROSHOP_DOMAIN is not set/);
    });

    test('a placeholder domain is caught rather than dialled', async () => {
      const { code, stderr } = await startupFailure({
        HOROSHOP_DOMAIN: 'REPLACE_WITH_STORE_DOMAIN',
        HOROSHOP_LOGIN: 'x',
        HOROSHOP_PASSWORD: 'y',
      });
      assert.equal(code, 1);
      assert.match(stderr, /does not look like a domain/);
    });

    test('a domain given as a full URL is accepted', async () => {
      const client = await connect({ domain: `http://${mock.domain}/admin/` });
      try {
        assert.equal((await client.call('horoshop_order_statuses')).isError, false);
      } finally {
        await client.close();
      }
    });
  });
});
