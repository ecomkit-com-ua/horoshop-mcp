/**
 * A stand-in for the Horoshop API, good enough to exercise the whole client.
 *
 * Runs in the test process on a random port, so a test can inspect `state.hits` to assert what
 * actually went over the wire — how many logins happened, which token each call carried.
 */

import { createServer } from 'node:http';

export const CREDENTIALS = { login: 'apiadmin', password: 's3cret' };

/** Orders the mock store holds. */
const ORDERS = Array.from({ length: 5 }, (_, i) => ({
  id: 1000 + i,
  status: (i % 3) + 1,
  sum: 100 * (i + 1),
  payed: i % 2,
}));

function makeProducts(count, padding) {
  return Array.from({ length: count }, (_, i) => ({
    article: `SKU-${i}`,
    title: { ua: `Товар ${i}` },
    price: i * 10,
    description: { ua: 'Опис '.repeat(padding) },
  }));
}

export async function startMock(options = {}) {
  const { productCount = 300, productPadding = 40 } = options;

  const state = {
    /** Every request that arrived: { path, body }. */
    hits: [],
    /** How many tokens have been handed out. */
    issued: 0,
    validTokens: new Set(),
    /** Make the next authenticated call answer UNAUTHORIZED, as an expired token would. */
    expireNext: false,
    authCalls: () => state.hits.filter((h) => h.path === '/api/auth').length,
    callsTo: (path) => state.hits.filter((h) => h.path === `/api/${path}`).length,
    reset() {
      state.hits.length = 0;
    },
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = req.url.replace(/\/+$/, '');
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return json(res, 400, { status: 'ERROR', response: { message: 'bad json' } });
      }
      state.hits.push({ path, body });

      // A store that is down or missing the API module answers with HTML, not JSON.
      if (path === '/api/_html') {
        res.writeHead(502, { 'Content-Type': 'text/html' });
        return res.end('<html><body>502 Bad Gateway</body></html>');
      }

      if (path === '/api/auth') {
        if (body.login === CREDENTIALS.login && body.password === CREDENTIALS.password) {
          const token = `tok-${++state.issued}`;
          state.validTokens.add(token);
          return json(res, 200, { status: 'OK', response: { token } });
        }
        return json(res, 200, {
          status: 'ERROR',
          response: { message: 'Wrong login or password' },
        });
      }

      if (state.expireNext) {
        state.expireNext = false;
        state.validTokens.delete(body.token);
        return json(res, 200, { status: 'UNAUTHORIZED', response: { message: 'token expired' } });
      }
      if (!body.token || !state.validTokens.has(body.token)) {
        return json(res, 200, { status: 'AUTHORIZATION_ERROR', response: { message: 'bad token' } });
      }

      switch (path) {
        case '/api/orders/get': {
          const limit = body.limit ?? 50;
          const offset = body.offset ?? 0;
          const page = ORDERS.slice(offset, offset + limit);
          if (!page.length) return json(res, 200, { status: 'EMPTY', response: { orders: [] } });
          return json(res, 200, { status: 'OK', response: { orders: page, total: ORDERS.length } });
        }
        case '/api/orders/get_available_statuses':
          return json(res, 200, {
            status: 'OK',
            response: { statuses: [{ id: 1, title: { ua: 'Новий' }, success: false }] },
          });
        case '/api/orders/update':
          return json(res, 200, {
            status: 'WARNING',
            response: { log: [{ order_id: 1001, code: 'NOT_FOUND', message: 'no such order' }] },
          });
        case '/api/catalog/export': {
          const limit = Math.min(body.limit ?? productCount, productCount);
          return json(res, 200, {
            status: 'OK',
            response: { products: makeProducts(limit, productPadding) },
          });
        }
        case '/api/users/export': {
          const limit = body.limit ?? 50;
          const users = Array.from({ length: Math.min(limit, 3) }, (_, i) => ({
            id: i + 1,
            title: `Покупець ${i}`,
            email: `buyer${i}@example.com`,
          }));
          return json(res, 200, { status: 'OK', response: { users } });
        }
        case '/api/pages/export':
          return json(res, 200, { status: 'OK', response: { pages: [{ id: 1, parent: 0 }] } });
        case '/api/hooks/subscribe':
          // Unenveloped, HTTP 201.
          return json(res, 201, { id: 7 });
        case '/api/hooks/unSubscribe':
          // Unenveloped, HTTP 410 Gone is the documented success.
          return json(res, 410, { id: 7, removed: true });
        default:
          if (/\/(export|exportTypes|exportMethods)$/.test(path)) {
            return json(res, 200, { status: 'OK', response: { items: [{ id: 1 }], from: path } });
          }
          if (/\/(import|remove)$/.test(path)) {
            return json(res, 200, { status: 'OK', response: { ok: true, from: path } });
          }
          return json(res, 200, {
            status: 'UNDEFINED_FUNCTION',
            response: { message: `no function ${path}` },
          });
      }
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    state,
    /** What to put in HOROSHOP_DOMAIN. */
    domain: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
