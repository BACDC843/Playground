/**
 * Persistence for the OAuth provider.
 *
 * Everything the provider needs to remember lives behind this interface:
 * registered clients, in-flight authorization requests, issued codes, and the
 * per-agent Dotloop refresh tokens.
 *
 * The file-backed implementation is deliberately simple. It is enough for a
 * single instance serving one brokerage. Moving to Postgres or Redis for
 * multi-instance hosting means implementing the same six methods.
 *
 * NOTE ON HOSTING: platforms like Railway give each deploy a fresh filesystem,
 * so a redeploy drops the file and agents reconnect. Set STORE_PATH to a
 * mounted volume to survive deploys.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

/** Records older than this are pruned on write. */
const TTL = {
  pending: 15 * 60_000, // an in-flight authorization
  code: 5 * 60_000, // an issued authorization code
};

export class FileStore {
  constructor(path) {
    this.path = path;
    this.data = { clients: {}, pending: {}, codes: {}, grants: {} };
    this.#load();
  }

  #load() {
    try {
      const raw = readFileSync(this.path, "utf8");
      this.data = { clients: {}, pending: {}, codes: {}, grants: {}, ...JSON.parse(raw) };
    } catch {
      // No file yet — start empty.
    }
  }

  #persist() {
    const now = Date.now();
    for (const bucket of ["pending", "codes"]) {
      const ttl = bucket === "pending" ? TTL.pending : TTL.code;
      for (const [k, v] of Object.entries(this.data[bucket])) {
        if (now - (v.created ?? 0) > ttl) delete this.data[bucket][k];
      }
    }
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (err) {
      process.stderr.write(`Warning: could not persist OAuth store: ${err.message}\n`);
    }
  }

  // ── Registered clients (RFC 7591) ─────────────────────────────────────────
  putClient(clientId, record) {
    this.data.clients[clientId] = record;
    this.#persist();
  }

  getClient(clientId) {
    return this.data.clients[clientId];
  }

  // ── In-flight authorization requests ──────────────────────────────────────
  putPending(state, record) {
    this.data.pending[state] = { ...record, created: Date.now() };
    this.#persist();
  }

  takePending(state) {
    const r = this.data.pending[state];
    delete this.data.pending[state];
    this.#persist();
    return r;
  }

  // ── Issued authorization codes ────────────────────────────────────────────
  putCode(code, record) {
    this.data.codes[code] = { ...record, created: Date.now() };
    this.#persist();
  }

  takeCode(code) {
    const r = this.data.codes[code];
    delete this.data.codes[code];
    this.#persist();
    return r;
  }

  // ── Long-lived grants: our token -> an agent's Dotloop refresh token ──────
  putGrant(token, record) {
    this.data.grants[token] = { ...record, created: Date.now() };
    this.#persist();
  }

  getGrant(token) {
    return this.data.grants[token];
  }

  deleteGrant(token) {
    delete this.data.grants[token];
    this.#persist();
  }

  /** Agents currently connected, for the admin listing. */
  listGrants() {
    const seen = new Map();
    for (const [token, g] of Object.entries(this.data.grants)) {
      if (g.kind !== "refresh") continue;
      seen.set(token, {
        account: g.account ?? "(unknown)",
        created: new Date(g.created).toISOString(),
      });
    }
    return [...seen.values()];
  }
}
