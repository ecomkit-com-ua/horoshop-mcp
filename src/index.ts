#!/usr/bin/env node
/**
 * horoshop-mcp — an MCP server for the Horoshop e-commerce API.
 *
 * Docs: https://horoshop.notion.site/api-doc
 * Repo: https://github.com/serg9375/horoshop-mcp
 *
 * stdout is the JSON-RPC channel. Every diagnostic must go to stderr.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

import { loadConfig } from './config.js';
import { HoroshopClient } from './client.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerOrderTools } from './tools/orders.js';
import { registerUserTools } from './tools/users.js';
import { registerReferenceTools } from './tools/reference.js';
import { registerProductSetTools } from './tools/sets.js';
import { registerWebhookTools } from './tools/hooks.js';
import { registerRawTool } from './tools/raw.js';
import type { ToolContext } from './tools/shared.js';

const VERSION = '0.1.0';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new HoroshopClient(config);

  const server = new McpServer({
    name: 'horoshop-mcp',
    version: VERSION,
  });

  const ctx: ToolContext = { server, client, config };

  registerOrderTools(ctx);
  registerCatalogTools(ctx);
  registerUserTools(ctx);
  registerReferenceTools(ctx);
  registerProductSetTools(ctx);
  registerWebhookTools(ctx);
  registerRawTool(ctx);

  await server.connect(new StdioServerTransport());

  console.error(
    `horoshop-mcp ${VERSION} ready for ${config.domain}` +
      (config.readOnly ? ' (read-only: write tools are hidden)' : ''),
  );
}

main().catch((err: unknown) => {
  console.error(`horoshop-mcp failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
