/**
 * Minimal .env loader — avoids a dependency for what is a dozen lines.
 *
 * Real environment variables always win, so a hosted deployment that sets
 * config through its platform is unaffected by a stray .env file.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));

/** Loads server/.env into process.env. Missing file is not an error. */
export function loadEnv(path = join(here, ".env")) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    // Strip one layer of surrounding quotes; Windows paths often get pasted
    // in with them, and the backslashes inside must survive untouched.
    const value = trimmed.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");

    if (!(key in process.env)) process.env[key] = value;
  }

  return true;
}
