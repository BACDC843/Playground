#!/usr/bin/env node
/**
 * Stdio MCP server — used by the Claude Code plugin (.mcp.json) and Claude Desktop.
 * For hosted/Cowork access use http-server.js instead.
 *
 * Required env vars: DOTLOOP_CLIENT_ID, DOTLOOP_CLIENT_SECRET, DOTLOOP_REFRESH_TOKEN
 * Optional:          DOTLOOP_DOWNLOAD_DIR
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tmpdir } from "os";

import { createTokenManager, EnvTokenStore } from "./auth.js";
import { TOOLS, makeDotloopFetch, makeCallTool } from "./dotloop.js";

const {
  DOTLOOP_CLIENT_ID,
  DOTLOOP_CLIENT_SECRET,
  DOTLOOP_REFRESH_TOKEN,
  DOTLOOP_DOWNLOAD_DIR = tmpdir(),
} = process.env;

if (!DOTLOOP_CLIENT_ID || !DOTLOOP_CLIENT_SECRET || !DOTLOOP_REFRESH_TOKEN) {
  process.stderr.write(
    "Error: DOTLOOP_CLIENT_ID, DOTLOOP_CLIENT_SECRET, and DOTLOOP_REFRESH_TOKEN are required.\n" +
      "Run `npm run get-token` to obtain a refresh token.\n"
  );
  process.exit(1);
}

const tokens = createTokenManager({
  clientId: DOTLOOP_CLIENT_ID,
  clientSecret: DOTLOOP_CLIENT_SECRET,
  store: new EnvTokenStore(DOTLOOP_REFRESH_TOKEN),
});

const dotloopFetch = makeDotloopFetch(tokens);
const callTool = makeCallTool(dotloopFetch, { downloadDir: DOTLOOP_DOWNLOAD_DIR });

const server = new Server({ name: "dotloop", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await callTool(name, args ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
