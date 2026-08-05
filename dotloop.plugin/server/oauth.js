/**
 * OAuth 2.0 provider that lets Claude connect agents to their own Dotloop data.
 *
 * Claude's custom-connector UI has no field for a static bearer token, so a
 * hosted server has to speak OAuth. This module makes the MCP server its own
 * authorization server and brokers the real login to Dotloop:
 *
 *   Claude  --OAuth-->  this server  --OAuth-->  Dotloop
 *
 * Each agent logs into Dotloop themselves. We keep their Dotloop refresh token
 * and hand Claude an opaque token of our own that maps back to it, so one
 * deployment serves a whole brokerage and no agent ever sees a credential.
 *
 * Implements the pieces Claude requires:
 *   - RFC 9728 protected resource metadata
 *   - RFC 8414 authorization server metadata
 *   - RFC 7591 dynamic client registration
 *   - PKCE S256 (Claude sends a code_challenge on every request)
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";

const DOTLOOP_AUTH = "https://auth.dotloop.com/oauth/authorize";
const DOTLOOP_TOKEN = "https://auth.dotloop.com/oauth/token";
const DOTLOOP_ACCOUNT = "https://api-gateway.dotloop.com/public/v2/account";

/** Access tokens Claude holds are short-lived; it refreshes on 401. */
const ACCESS_TOKEN_TTL_MS = 60 * 60_000;

const token = () => randomBytes(32).toString("hex");

function s256(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Constant-time compare that tolerates length mismatch. */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * @param {object} opts
 * @param {string} opts.publicUrl     Base URL this server is reachable at, no trailing slash
 * @param {string} opts.mcpPath       Path of the MCP endpoint, e.g. "/mcp"
 * @param {string} opts.clientId      Dotloop Application Client ID
 * @param {string} opts.clientSecret  Dotloop Application Client secret
 * @param {object} opts.store         Store from store.js
 */
export function createOAuthProvider({ publicUrl, mcpPath, clientId, clientSecret, store }) {
  const base = publicUrl.replace(/\/$/, "");
  const resourceUrl = `${base}${mcpPath}`;
  const dotloopRedirect = `${base}/oauth/dotloop-callback`;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  async function dotloopTokenRequest(params) {
    const res = await fetch(`${DOTLOOP_TOKEN}?${new URLSearchParams(params)}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Dotloop token request failed (${res.status}): ${JSON.stringify(body)}`);
    }
    return body;
  }

  /** Labels the grant with the agent's email so the admin listing is readable. */
  async function describeAccount(accessToken) {
    try {
      const res = await fetch(DOTLOOP_ACCOUNT, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      });
      if (!res.ok) return null;
      const body = await res.json();
      return body?.data?.email ?? null;
    } catch {
      return null;
    }
  }

  /** Resolves a bearer token from Claude to that agent's Dotloop refresh token. */
  function resolveAccessToken(bearer) {
    if (!bearer) return null;
    const grant = store.getGrant(bearer);
    if (!grant || grant.kind !== "access") return null;
    if (grant.expiresAt && grant.expiresAt < Date.now()) {
      store.deleteGrant(bearer);
      return null;
    }
    return grant;
  }

  /** The 401 that tells Claude where to find our metadata. */
  function challenge(res) {
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`
    );
    return res.status(401).json({ error: "unauthorized" });
  }

  function mount(app) {
    // ── Discovery ─────────────────────────────────────────────────────────
    const protectedResource = (_req, res) =>
      res.json({
        // Must match the URL the user types into Claude, exactly.
        resource: resourceUrl,
        authorization_servers: [base],
        scopes_supported: ["dotloop"],
        bearer_methods_supported: ["header"],
      });

    app.get("/.well-known/oauth-protected-resource", protectedResource);
    // Claude probes the path-suffixed form first when there is no header hint.
    app.get(`/.well-known/oauth-protected-resource${mcpPath}`, protectedResource);

    const authServerMetadata = (_req, res) =>
      res.json({
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        // Claude registers as a public client and authenticates with none.
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        scopes_supported: ["dotloop"],
      });

    app.get("/.well-known/oauth-authorization-server", authServerMetadata);
    app.get(`/.well-known/oauth-authorization-server${mcpPath}`, authServerMetadata);

    // ── Dynamic client registration (RFC 7591) ────────────────────────────
    app.post("/register", (req, res) => {
      const body = req.body ?? {};
      const redirectUris = body.redirect_uris ?? [];

      if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
        return res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: "redirect_uris is required",
        });
      }

      const id = `c_${token()}`;
      store.putClient(id, {
        redirect_uris: redirectUris,
        client_name: body.client_name ?? "unknown",
        created: Date.now(),
      });

      res.status(201).json({
        client_id: id,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      });
    });

    // ── Authorization: hand the agent off to Dotloop ──────────────────────
    app.get("/authorize", (req, res) => {
      const {
        client_id,
        redirect_uri,
        state,
        code_challenge,
        code_challenge_method,
        response_type,
      } = req.query;

      const client = store.getClient(client_id);
      if (!client) {
        return res.status(400).send("Unknown client_id. Try removing and re-adding the connector.");
      }
      if (!client.redirect_uris.includes(redirect_uri)) {
        return res.status(400).send("redirect_uri does not match this client's registration.");
      }
      if (response_type !== "code") {
        return res.status(400).send("Only response_type=code is supported.");
      }
      // PKCE is mandatory: Claude always sends S256, and accepting a request
      // without it would let an intercepted code be redeemed by anyone.
      if (!code_challenge || code_challenge_method !== "S256") {
        return res.status(400).send("PKCE with code_challenge_method=S256 is required.");
      }

      const linkState = token();
      store.putPending(linkState, {
        client_id,
        redirect_uri,
        claude_state: state ?? null,
        code_challenge,
      });

      const url =
        `${DOTLOOP_AUTH}?` +
        new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: dotloopRedirect,
          state: linkState,
        });

      res.redirect(url);
    });

    // ── Dotloop sends the agent back here ─────────────────────────────────
    app.get("/oauth/dotloop-callback", async (req, res) => {
      const { code, state, error } = req.query;

      const pending = state ? store.takePending(state) : null;
      if (!pending) {
        return res
          .status(400)
          .send("This login link expired or was already used. Start the connection again.");
      }

      const back = new URL(pending.redirect_uri);
      if (pending.claude_state) back.searchParams.set("state", pending.claude_state);

      if (error || !code) {
        back.searchParams.set("error", error ? String(error) : "access_denied");
        return res.redirect(back.toString());
      }

      try {
        const dotloop = await dotloopTokenRequest({
          grant_type: "authorization_code",
          code,
          redirect_uri: dotloopRedirect,
        });

        if (!dotloop.refresh_token) {
          throw new Error("Dotloop did not return a refresh token.");
        }

        const account = await describeAccount(dotloop.access_token);

        const ourCode = token();
        store.putCode(ourCode, {
          client_id: pending.client_id,
          redirect_uri: pending.redirect_uri,
          code_challenge: pending.code_challenge,
          dotloopRefreshToken: dotloop.refresh_token,
          account,
        });

        back.searchParams.set("code", ourCode);
        res.redirect(back.toString());
      } catch (err) {
        process.stderr.write(`Dotloop callback failed: ${err.message}\n`);
        back.searchParams.set("error", "server_error");
        res.redirect(back.toString());
      }
    });

    // ── Token endpoint ────────────────────────────────────────────────────
    app.post("/token", (req, res) => {
      const body = req.body ?? {};
      const grantType = body.grant_type;

      if (grantType === "authorization_code") {
        const record = store.takeCode(body.code);
        if (!record) {
          return res.status(400).json({ error: "invalid_grant" });
        }
        if (record.client_id !== body.client_id) {
          return res.status(400).json({ error: "invalid_grant" });
        }
        if (!body.code_verifier || !safeEqual(s256(body.code_verifier), record.code_challenge)) {
          return res.status(400).json({ error: "invalid_grant" });
        }

        return res.json(issue(record.dotloopRefreshToken, record.account));
      }

      if (grantType === "refresh_token") {
        const existing = store.getGrant(body.refresh_token);
        if (!existing || existing.kind !== "refresh") {
          // RFC 6749 code — Claude keys its retry logic on this exact value.
          return res.status(400).json({ error: "invalid_grant" });
        }

        // Public clients require refresh token rotation; the old one dies here.
        store.deleteGrant(body.refresh_token);
        return res.json(issue(existing.dotloopRefreshToken, existing.account));
      }

      return res.status(400).json({ error: "unsupported_grant_type" });
    });

    function issue(dotloopRefreshToken, account) {
      const accessToken = token();
      const refreshToken = token();

      store.putGrant(accessToken, {
        kind: "access",
        dotloopRefreshToken,
        account,
        expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      });
      store.putGrant(refreshToken, { kind: "refresh", dotloopRefreshToken, account });

      return {
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
        refresh_token: refreshToken,
        scope: "dotloop",
      };
    }
  }

  return { mount, resolveAccessToken, challenge, dotloopRedirect, resourceUrl };
}
