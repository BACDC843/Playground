#!/usr/bin/env node
/**
 * Stdio MCP server — used by the Claude Code plugin (.mcp.json) for local/CLI sessions.
 * For hosted/Cowork access use http-server.js instead.
 *
 * Required env vars: GHL_API_KEY, GHL_LOCATION_ID
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, makeGhlFetch, makeCallTool } from "./ghl.js";

const { GHL_API_KEY, GHL_LOCATION_ID } = process.env;

if (!GHL_API_KEY || !GHL_LOCATION_ID) {
  process.stderr.write("Error: GHL_API_KEY and GHL_LOCATION_ID are required.\n");
  process.exit(1);
}

const ghlFetch = makeGhlFetch(GHL_API_KEY);
const callTool = makeCallTool(ghlFetch, GHL_LOCATION_ID);

const server = new Server(
  { name: "ghl-renew-urban", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

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
