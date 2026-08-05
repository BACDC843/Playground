#!/usr/bin/env node
/**
 * HTTP MCP server — hosted on Railway/Render/Fly for Cowork, Desktop, and any remote client.
 * Implements the MCP Streamable HTTP transport so mcp-remote can connect to it.
 *
 * Required env vars:
 *   DOTLOOP_CLIENT_ID      – Dotloop Application Client ID
 *   DOTLOOP_CLIENT_SECRET  – Dotloop Application Client secret
 *   DOTLOOP_REFRESH_TOKEN  – Evergreen refresh token for the account to act as
 *   MCP_AUTH_TOKEN         – Secret token clients must send as: Authorization: Bearer <token>
 *   PORT                   – HTTP port (default 3000; Railway sets this automatically)
 */

import express from "express";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadEnv } from "./env.js";
import { createTokenManager, EnvTokenStore } from "./auth.js";
import { TOOLS, makeDotloopFetch, makeCallTool } from "./dotloop.js";

// No-op when hosted — platform-provided variables take precedence.
loadEnv();

const {
  DOTLOOP_CLIENT_ID,
  DOTLOOP_CLIENT_SECRET,
  DOTLOOP_REFRESH_TOKEN,
  MCP_AUTH_TOKEN,
  DOTLOOP_DOWNLOAD_DIR = tmpdir(),
  PORT = "3000",
} = process.env;

if (!DOTLOOP_CLIENT_ID || !DOTLOOP_CLIENT_SECRET || !DOTLOOP_REFRESH_TOKEN || !MCP_AUTH_TOKEN) {
  process.stderr.write(
    "Error: DOTLOOP_CLIENT_ID, DOTLOOP_CLIENT_SECRET, DOTLOOP_REFRESH_TOKEN, " +
      "and MCP_AUTH_TOKEN are required.\n"
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

function createMcpServer() {
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

  return server;
}

// Active sessions: sessionId → StreamableHTTPServerTransport
const sessions = new Map();

function authMiddleware(req, res, next) {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== MCP_AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

const app = express();
app.use(express.json());

// Health check — Railway and Render use this to confirm the service is up
app.get("/health", (_req, res) => res.json({ status: "ok", service: "dotloop-mcp" }));

app.post("/mcp", authMiddleware, async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = sessionId ? sessions.get(sessionId) : null;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => sessions.set(id, transport),
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      const server = createMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

app.get("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessions.get(sessionId);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handleRequest(req, res);
});

app.delete("/mcp", authMiddleware, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessions.get(sessionId);
  if (transport) {
    await transport.close();
    sessions.delete(sessionId);
  }
  res.status(200).json({ status: "closed" });
});

app.listen(Number(PORT), () => {
  console.log(`Dotloop MCP server running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
