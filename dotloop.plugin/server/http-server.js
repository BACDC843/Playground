#!/usr/bin/env node
/**
 * HTTP MCP server — hosted for Claude Desktop, Cowork, web, and mobile.
 *
 * Runs in one of two modes:
 *
 *   OAuth mode (default when PUBLIC_URL is set)
 *     Each agent adds the connector, clicks through a Dotloop login, and gets
 *     their own data. This is the mode to use for a brokerage — no install and
 *     no credential handling on the agent's side.
 *
 *   Single-account mode (MCP_AUTH_TOKEN set, PUBLIC_URL unset)
 *     Every caller acts as one Dotloop account using a stored refresh token.
 *     Useful for testing and for tools that can send a fixed bearer header.
 *     Claude's connector UI cannot supply one, so this is not the agent path.
 *
 * Environment:
 *   DOTLOOP_CLIENT_ID      – Dotloop Application Client ID          (both modes)
 *   DOTLOOP_CLIENT_SECRET  – Dotloop Application Client secret      (both modes)
 *   PUBLIC_URL             – Public https base URL, no trailing /   (OAuth mode)
 *   STORE_PATH             – Where to persist grants  (default ./data/oauth.json)
 *   DOTLOOP_REFRESH_TOKEN  – Stored refresh token          (single-account mode)
 *   MCP_AUTH_TOKEN         – Fixed bearer token            (single-account mode)
 *   PORT                   – Listen port (the host usually sets this)
 */

import express from "express";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { loadEnv } from "./env.js";
import { FileStore } from "./store.js";
import { createOAuthProvider } from "./oauth.js";
import { createTokenManager, EnvTokenStore } from "./auth.js";
import { TOOLS, makeDotloopFetch, makeCallTool } from "./dotloop.js";

// No-op when hosted — platform-provided variables take precedence.
loadEnv();

const {
  DOTLOOP_CLIENT_ID,
  DOTLOOP_CLIENT_SECRET,
  DOTLOOP_REFRESH_TOKEN,
  MCP_AUTH_TOKEN,
  PUBLIC_URL,
  STORE_PATH = join(process.cwd(), "data", "oauth.json"),
  DOTLOOP_DOWNLOAD_DIR = tmpdir(),
  PORT = "3000",
} = process.env;

const OAUTH_MODE = Boolean(PUBLIC_URL);

/**
 * A hosted process that exits on boot shows up only as a 502, so the reason has
 * to be legible in the logs. Name the missing variables rather than the rule.
 */
function fail(lines) {
  process.stderr.write(
    "\n" + "=".repeat(64) + "\nDotloop MCP server cannot start.\n\n" +
      lines.join("\n") +
      "\n\nSeen in this environment: " +
      Object.keys(process.env)
        .filter((k) => k.startsWith("DOTLOOP_") || k === "PUBLIC_URL" || k === "MCP_AUTH_TOKEN")
        .sort()
        .join(", ") +
      "\n" + "=".repeat(64) + "\n"
  );
  process.exit(1);
}

const missing = [
  ["DOTLOOP_CLIENT_ID", DOTLOOP_CLIENT_ID],
  ["DOTLOOP_CLIENT_SECRET", DOTLOOP_CLIENT_SECRET],
].filter(([, v]) => !v);

if (missing.length) {
  fail([`Missing required variable(s): ${missing.map(([k]) => k).join(", ")}`]);
}

if (!OAUTH_MODE && !(MCP_AUTH_TOKEN && DOTLOOP_REFRESH_TOKEN)) {
  fail([
    "No mode selected.",
    "",
    "  For agents (Desktop, Cowork, mobile), set:",
    "    PUBLIC_URL=https://<your-host>      <- no trailing slash",
    "",
    "  For a single fixed account, set BOTH:",
    "    MCP_AUTH_TOKEN and DOTLOOP_REFRESH_TOKEN",
  ]);
}

if (OAUTH_MODE && !/^https?:\/\/[^/]+$/.test(PUBLIC_URL)) {
  // A trailing slash or a path silently breaks OAuth discovery, because the
  // resource URL then no longer matches what the user typed into Claude.
  fail([
    `PUBLIC_URL is "${PUBLIC_URL}", which is not a bare origin.`,
    "Use exactly: https://<your-host>   (no trailing slash, no path)",
  ]);
}

const MCP_PATH = "/mcp";

const store = OAUTH_MODE ? new FileStore(STORE_PATH) : null;

const oauth = OAUTH_MODE
  ? createOAuthProvider({
      publicUrl: PUBLIC_URL,
      mcpPath: MCP_PATH,
      clientId: DOTLOOP_CLIENT_ID,
      clientSecret: DOTLOOP_CLIENT_SECRET,
      store,
    })
  : null;

/**
 * Builds a tool dispatcher scoped to one agent's Dotloop refresh token.
 * Token managers are cached so repeated calls reuse a live access token.
 */
const dispatchers = new Map();

function dispatcherFor(dotloopRefreshToken) {
  let cached = dispatchers.get(dotloopRefreshToken);
  if (!cached) {
    const tokens = createTokenManager({
      clientId: DOTLOOP_CLIENT_ID,
      clientSecret: DOTLOOP_CLIENT_SECRET,
      store: new EnvTokenStore(dotloopRefreshToken),
    });
    cached = makeCallTool(makeDotloopFetch(tokens), { downloadDir: DOTLOOP_DOWNLOAD_DIR });
    dispatchers.set(dotloopRefreshToken, cached);
  }
  return cached;
}

function createMcpServer(callTool) {
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

const app = express();
// DCR posts JSON; the token endpoint posts form-urlencoded. Both are required.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (OAUTH_MODE) oauth.mount(app);

app.get("/health", (_req, res) =>
  res.json({ status: "ok", service: "dotloop-mcp", mode: OAUTH_MODE ? "oauth" : "single-account" })
);

/** Connected agents, for checking who is set up. Never exposes tokens. */
app.get("/agents", (req, res) => {
  if (!OAUTH_MODE) return res.status(404).json({ error: "not in oauth mode" });
  if (!MCP_AUTH_TOKEN) {
    return res.status(404).json({ error: "set MCP_AUTH_TOKEN to enable this listing" });
  }
  const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
  if (!bearer || bearer !== MCP_AUTH_TOKEN) return res.status(401).json({ error: "unauthorized" });
  res.json({ agents: store.listGrants() });
});

function bearerFrom(req) {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Resolves the caller to a dispatcher, or sends the appropriate rejection.
 * Returns null when the response has already been sent.
 */
function authenticate(req, res) {
  const bearer = bearerFrom(req);

  if (!OAUTH_MODE) {
    if (bearer !== MCP_AUTH_TOKEN) {
      res.status(401).json({ error: "Unauthorized" });
      return null;
    }
    return dispatcherFor(DOTLOOP_REFRESH_TOKEN);
  }

  const grant = oauth.resolveAccessToken(bearer);
  if (!grant) {
    // Must be a 401 carrying WWW-Authenticate, or Claude never starts OAuth.
    oauth.challenge(res);
    return null;
  }
  return dispatcherFor(grant.dotloopRefreshToken);
}

// Active sessions: sessionId → StreamableHTTPServerTransport
const sessions = new Map();

app.post(MCP_PATH, async (req, res) => {
  const callTool = authenticate(req, res);
  if (!callTool) return;

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

      await createMcpServer(callTool).connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get(MCP_PATH, async (req, res) => {
  if (!authenticate(req, res)) return;
  const transport = sessions.get(req.headers["mcp-session-id"]);
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handleRequest(req, res);
});

app.delete(MCP_PATH, async (req, res) => {
  if (!authenticate(req, res)) return;
  const transport = sessions.get(req.headers["mcp-session-id"]);
  if (transport) {
    await transport.close();
    sessions.delete(transport.sessionId);
  }
  res.status(200).json({ status: "closed" });
});

// Bind on all interfaces explicitly; hosts route to the container's external IP.
const server = app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Dotloop MCP server listening on 0.0.0.0:${PORT} (${OAUTH_MODE ? "OAuth" : "single-account"} mode)`);
  if (OAUTH_MODE) {
    console.log(`Connector URL for agents:  ${oauth.resourceUrl}`);
    console.log(`Add this to your Dotloop client's Redirect URLs:`);
    console.log(`  ${oauth.dotloopRedirect}`);
    console.log(`Grant store: ${STORE_PATH}`);
  }
});

server.on("error", (err) => {
  process.stderr.write(`\nFailed to bind port ${PORT}: ${err.message}\n`);
  process.exit(1);
});

// An unhandled rejection would otherwise kill the process with no explanation.
process.on("unhandledRejection", (err) => {
  process.stderr.write(`\nUnhandled rejection: ${err?.stack ?? err}\n`);
});
