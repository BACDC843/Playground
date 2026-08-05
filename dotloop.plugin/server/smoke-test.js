#!/usr/bin/env node
/**
 * Connection check — confirms the credentials work end to end without touching data.
 *
 * Calls GET /account, then lists profiles, then lists the first few loops on the
 * first profile. Every call is read-only.
 *
 * Usage: npm run smoke
 */

import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

import { createTokenManager, EnvTokenStore } from "./auth.js";
import { makeDotloopFetch, makeCallTool } from "./dotloop.js";

const here = dirname(fileURLToPath(import.meta.url));

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

const { DOTLOOP_CLIENT_ID, DOTLOOP_CLIENT_SECRET, DOTLOOP_REFRESH_TOKEN } = process.env;

if (!DOTLOOP_CLIENT_ID || !DOTLOOP_CLIENT_SECRET || !DOTLOOP_REFRESH_TOKEN) {
  console.error(
    "Missing credentials. Fill in server/.env first:\n" +
      "  DOTLOOP_CLIENT_ID, DOTLOOP_CLIENT_SECRET, DOTLOOP_REFRESH_TOKEN\n" +
      "Run `npm run get-token` if you do not have a refresh token yet."
  );
  process.exit(1);
}

const tokens = createTokenManager({
  clientId: DOTLOOP_CLIENT_ID,
  clientSecret: DOTLOOP_CLIENT_SECRET,
  store: new EnvTokenStore(DOTLOOP_REFRESH_TOKEN),
});

const callTool = makeCallTool(makeDotloopFetch(tokens));

function pass(msg) {
  console.log(`  PASS  ${msg}`);
}

function fail(msg, err) {
  console.log(`  FAIL  ${msg}`);
  console.log(`        ${err.message}`);
}

console.log("\nDotloop connection check\n" + "-".repeat(40));

let profileId;

try {
  const account = await callTool("dotloop_get_account");
  const d = account.data ?? account;
  pass(`Authenticated as ${d.name ?? "(unnamed)"} <${d.email ?? "?"}>`);
} catch (err) {
  fail("GET /account", err);
  process.exit(1);
}

try {
  const profiles = await callTool("dotloop_list_profiles", { batch_size: 100 });
  const list = profiles.data ?? [];
  pass(`Found ${list.length} profile(s)`);
  for (const p of list) {
    console.log(`        - ${p.id}  ${p.name} (${p.type ?? "?"})`);
  }
  profileId = list[0]?.id;
} catch (err) {
  fail("GET /profile", err);
}

if (profileId) {
  try {
    const loops = await callTool("dotloop_list_loops", {
      profile_id: profileId,
      batch_size: 5,
      sort: "updated:desc",
    });
    const list = loops.data ?? [];
    pass(`Read ${list.length} recent loop(s) on profile ${profileId}`);
    for (const l of list) {
      console.log(`        - ${l.id}  ${l.name}  [${l.status ?? "?"}]`);
    }

    // The account that owns the API client is usually a dedicated, empty one.
    // Reaching real transactions means authorizing as the agent who owns them.
    if (list.length === 0) {
      console.log(
        `\n  NOTE  The connection works, but this account has no loops.\n` +
          `        A dedicated API account (api@yourdomain.com) houses the\n` +
          `        Application Client — it does not hold transactions.\n\n` +
          `        To reach an agent's loops, rerun \`npm run get-token\` and log in\n` +
          `        as that agent at the Dotloop approval screen. Same Client ID and\n` +
          `        Secret; the refresh token is what decides whose data you see.\n\n` +
          `        Log out of Dotloop in your browser first, or use a private window —\n` +
          `        an existing session can skip the login prompt and silently reuse\n` +
          `        the account you are already signed into.`
      );
    }
  } catch (err) {
    fail(`GET /profile/${profileId}/loop`, err);
  }
} else {
  console.log("  SKIP  loop listing (no profile found)");
}

console.log("-".repeat(40));
console.log("Done.\n");
