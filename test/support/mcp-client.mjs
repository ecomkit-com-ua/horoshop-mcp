/**
 * A minimal MCP stdio client, so the integration tests drive the real server the way a real
 * client does: spawn the built dist/index.js, speak JSON-RPC over its stdin/stdout.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENTRY = resolve(HERE, '../../dist/index.js');

const CREDENTIALS = { login: 'apiadmin', password: 's3cret' };

/** Spawns the server without connecting; use for startup-failure assertions. */
export function spawnServer(env = {}) {
  return spawn('node', [ENTRY], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Runs the server to completion and returns its exit code and stderr. */
export async function startupFailure(env = {}) {
  const child = spawnServer(env);
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end();
  const [code] = await once(child, 'exit');
  return { code, stderr };
}

/**
 * Connects to a freshly spawned server pointed at `domain`, completes the MCP handshake, and
 * returns handles for calling tools. Always `await client.close()`.
 */
export async function connect({ domain, env = {} } = {}) {
  const child = spawnServer({
    HOROSHOP_DOMAIN: domain,
    HOROSHOP_LOGIN: CREDENTIALS.login,
    HOROSHOP_PASSWORD: CREDENTIALS.password,
    HOROSHOP_INSECURE_HTTP: '1',
    ...env,
  });

  const stderr = [];
  child.stderr.on('data', (d) => stderr.push(String(d)));

  let buffer = '';
  let nextId = 0;
  const pending = new Map();

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // Not our frame; the transport is line-delimited JSON.
      }
      const resolver = pending.get(message.id);
      if (resolver) {
        pending.delete(message.id);
        resolver(message);
      }
    }
  });

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 15_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  const initialize = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'horoshop-mcp-tests', version: '0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  return {
    initialize: initialize.result,
    stderr: () => stderr.join(''),

    /** Tool names currently advertised. */
    async toolNames() {
      const { result } = await request('tools/list', {});
      return result.tools.map((t) => t.name);
    },

    async listTools() {
      const { result } = await request('tools/list', {});
      return result.tools;
    },

    /** Calls a tool and returns { text, isError }. */
    async call(name, args = {}) {
      const message = await request('tools/call', { name, arguments: args });
      if (message.error) return { text: message.error.message, isError: true, protocolError: true };
      return {
        text: message.result.content.map((c) => c.text).join('\n'),
        isError: Boolean(message.result.isError),
      };
    },

    async close() {
      child.kill();
      await once(child, 'exit').catch(() => {});
    },
  };
}

/** Pulls the JSON body out of a tool result, ignoring the leading prose notes. */
export function parseBody(text) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error(`no JSON found in tool result: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

/** The prose notes that precede the JSON body. */
export function notesOf(text) {
  const start = text.search(/[[{]/);
  return (start < 0 ? text : text.slice(0, start)).trim();
}
