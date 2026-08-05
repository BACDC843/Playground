/**
 * Dotloop OAuth 2.0 token management.
 *
 * Dotloop refresh tokens do not expire, so the integration stores a refresh token
 * per account and exchanges it for a short-lived access token on demand.
 *
 * The token store is deliberately behind an interface. Today it resolves a single
 * refresh token from the environment; swapping in a database to support many
 * brokerages means replacing `EnvTokenStore` and nothing else.
 */

const TOKEN_URL = "https://auth.dotloop.com/oauth/token";
const REVOKE_URL = "https://auth.dotloop.com/oauth/token/revoke";

/** Refresh an access token this many ms before it actually expires. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Single-tenant token store backed by environment variables.
 * Every account key resolves to the same refresh token.
 */
export class EnvTokenStore {
  constructor(refreshToken) {
    this.refreshToken = refreshToken;
  }

  async get(_accountKey) {
    return this.refreshToken;
  }

  async set(_accountKey, _refreshToken) {
    // No-op: the env-backed store is read-only. A database-backed store would
    // persist rotated refresh tokens here.
  }
}

/**
 * Exchanges refresh tokens for access tokens and caches them in memory.
 *
 * @param {object} opts
 * @param {string} opts.clientId      Dotloop Application Client ID
 * @param {string} opts.clientSecret  Dotloop Application Client secret
 * @param {object} opts.store         Token store with async get/set(accountKey)
 */
export function createTokenManager({ clientId, clientSecret, store }) {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  // accountKey → { accessToken, expiresAt }
  const cache = new Map();

  async function fetchAccessToken(refreshToken) {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
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
      // A 400 here almost always means the refresh token was revoked or the
      // client secret was reset — both need human action, so say so plainly.
      throw new Error(
        `Dotloop token refresh failed (${res.status}). ` +
          `Check DOTLOOP_CLIENT_ID, DOTLOOP_CLIENT_SECRET and DOTLOOP_REFRESH_TOKEN. ` +
          `Response: ${JSON.stringify(body)}`
      );
    }

    return {
      accessToken: body.access_token,
      // Dotloop reports expires_in in seconds; fall back to 30 minutes.
      expiresIn: Number(body.expires_in ?? 1800) * 1000,
      // Dotloop may hand back a rotated refresh token.
      refreshToken: body.refresh_token,
    };
  }

  return {
    /** Returns a valid access token for the account, refreshing if needed. */
    async getAccessToken(accountKey = "default") {
      const cached = cache.get(accountKey);
      if (cached && cached.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
        return cached.accessToken;
      }

      const refreshToken = await store.get(accountKey);
      if (!refreshToken) {
        throw new Error(`No Dotloop refresh token stored for account "${accountKey}".`);
      }

      const result = await fetchAccessToken(refreshToken);

      if (result.refreshToken && result.refreshToken !== refreshToken) {
        await store.set(accountKey, result.refreshToken);
      }

      cache.set(accountKey, {
        accessToken: result.accessToken,
        expiresAt: Date.now() + result.expiresIn,
      });

      return result.accessToken;
    },

    /** Drops the cached access token so the next call refreshes. */
    invalidate(accountKey = "default") {
      cache.delete(accountKey);
    },

    /** Revokes the stored refresh token. Irreversible — requires re-authorization. */
    async revoke(accountKey = "default") {
      const refreshToken = await store.get(accountKey);
      if (!refreshToken) return { revoked: false, reason: "no token stored" };

      const res = await fetch(`${REVOKE_URL}?token=${encodeURIComponent(refreshToken)}`, {
        method: "POST",
        headers: { Authorization: `Basic ${basic}` },
      });

      cache.delete(accountKey);
      return { revoked: res.ok, status: res.status };
    },
  };
}
