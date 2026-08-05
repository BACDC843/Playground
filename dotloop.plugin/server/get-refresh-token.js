#!/usr/bin/env node
/**
 * One-time helper: walks the Dotloop OAuth 2.0 authorization-code flow on your
 * own machine and prints the evergreen refresh token.
 *
 * This replaces the Postman/Insomnia steps in the Dotloop Quick Start Guide.
 *
 * Prerequisites:
 *   1. Your Dotloop Application Client must list this exact redirect URL:
 *        http://localhost:5858/callback
 *      (change the port with REDIRECT_PORT if you registered a different one)
 *   2. DOTLOOP_CLIENT_ID and DOTLOOP_CLIENT_SECRET must be set, either in the
 *      environment or in server/.env
 *
 * Usage:
 *   npm run get-token
 */

import { createServer } from "http";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const AUTH_URL = "https://auth.dotloop.com/oauth/authorize";
const TOKEN_URL = "https://auth.dotloop.com/oauth/token";

const here = dirname(fileURLToPath(import.meta.url));

/** Loads server/.env into process.env without adding a dependency. */
async function loadDotEnv() {
  try {
    const raw = await readFile(join(here, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // No .env file — rely on the ambient environment.
  }
}

await loadDotEnv();

const CLIENT_ID = process.env.DOTLOOP_CLIENT_ID;
const CLIENT_SECRET = process.env.DOTLOOP_CLIENT_SECRET;
const PORT = Number(process.env.REDIRECT_PORT ?? 5858);
const REDIRECT_URI = process.env.DOTLOOP_REDIRECT_URI ?? `http://localhost:${PORT}/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing DOTLOOP_CLIENT_ID or DOTLOOP_CLIENT_SECRET.\n" +
      "Copy .env.example to .env and fill in the values from your Dotloop Client, then rerun."
  );
  process.exit(1);
}

const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

async function exchangeCode(code) {
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
  });

  const res = await fetch(`${TOKEN_URL}?${params}`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Token exchange failed (${res.status}): ${JSON.stringify(body)}`);
  }
  return body;
}

const authorizeUrl =
  `${AUTH_URL}?` +
  new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
  });

function reportSuccess(token) {
  console.log("\n" + "=".repeat(70));
  console.log("SUCCESS — add this line to server/.env:\n");
  console.log(`DOTLOOP_REFRESH_TOKEN=${token.refresh_token}`);
  console.log("\n" + "=".repeat(70));
  console.log(
    "\nTreat this like a password. It does not expire and grants access to\n" +
      "your Dotloop data. Never commit it or paste it into a chat window.\n"
  );
}

/**
 * Manual mode — for redirect URLs this script cannot serve, such as an https
 * URL or one pointing at a real domain. Dotloop still redirects the browser
 * there with ?code=... in the query string, even if the page fails to load,
 * so the code can simply be copied out of the address bar.
 */
async function runManual(reason) {
  const { createInterface } = await import("readline/promises");

  if (reason) console.log(`\n${reason}`);

  console.log("\nStep 1. Open this URL in your browser, log into Dotloop, and click Approve:\n");
  console.log(authorizeUrl);
  console.log(
    `\nStep 2. Your browser will be sent to ${REDIRECT_URI} — that page will\n` +
      "probably show an error, which is fine. What matters is the address bar.\n" +
      "Copy the WHOLE URL from it and paste it below.\n"
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("Paste the redirected URL (or just the code): ")).trim();
  rl.close();

  let code = answer;
  if (answer.includes("?") || answer.includes("code=")) {
    try {
      code = new URL(answer).searchParams.get("code") ?? code;
    } catch {
      code = new URLSearchParams(answer.split("?").pop()).get("code") ?? code;
    }
  }

  if (!code) {
    console.error("\nCould not find a code in that input.");
    process.exit(1);
  }

  try {
    reportSuccess(await exchangeCode(code));
  } catch (err) {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
}

// A redirect URL this script cannot listen on has to be handled by hand.
const canServeRedirect = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(REDIRECT_URI);

if (process.argv.includes("--manual")) {
  await runManual();
} else if (!canServeRedirect) {
  await runManual(
    `Your redirect URL is ${REDIRECT_URI}, which this script cannot listen on.\n` +
      "Switching to manual mode — same result, one extra copy/paste."
  );
} else {
  startCallbackServer();
}

function startCallbackServer() {
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/callback") {
    res.writeHead(404).end("Not found");
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Authorization failed</h1><p>${error}</p>`);
    console.error(`\nAuthorization failed: ${error}`);
    server.close();
    process.exitCode = 1;
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }

  try {
    const token = await exchangeCode(code);

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(
      "<h1>Connected.</h1><p>Your refresh token was printed in the terminal. " +
        "You can close this tab.</p>"
    );

    reportSuccess(token);
  } catch (err) {
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h1>Token exchange failed</h1><pre>${err.message}</pre>`);
    console.error(`\n${err.message}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});

server.listen(PORT, () => {
  console.log("\nOpen this URL in your browser, log into Dotloop, and click Approve:\n");
  console.log(authorizeUrl);
  console.log(`\nWaiting for the redirect to ${REDIRECT_URI} ...`);
  console.log("(Press Ctrl+C to cancel, or rerun with --manual to paste the code by hand.)\n");
});

server.on("error", async (err) => {
  if (err.code === "EADDRINUSE") {
    await runManual(`Port ${PORT} is already in use. Switching to manual mode.`);
  } else {
    console.error(`\n${err.message}`);
    process.exit(1);
  }
});
}
