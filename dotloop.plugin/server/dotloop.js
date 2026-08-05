/**
 * Shared Dotloop Public API v2 tools and handlers.
 * Imported by both the stdio server (index.js) and the HTTP server (http-server.js).
 *
 * API reference: https://dotloop.github.io/public-api/
 */

import { writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";

export const API_BASE = "https://api-gateway.dotloop.com/public/v2";

/** Dotloop allows 100 requests per minute per user. */
export const RATE_LIMIT_PER_MINUTE = 100;

/**
 * Builds an authenticated fetch bound to a token manager.
 *
 * @param {object} tokens     Token manager from auth.js
 * @param {string} accountKey Which stored account to act as
 */
export function makeDotloopFetch(tokens, accountKey = "default") {
  return async function dotloopFetch(path, options = {}) {
    const { raw = false, retryOn401 = true, ...init } = options;

    const accessToken = await tokens.getAccessToken(accountKey);

    const res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        ...(init.body && !(init.body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...(init.headers ?? {}),
      },
    });

    // A cached access token can go stale early; refresh once and retry.
    if (res.status === 401 && retryOn401) {
      tokens.invalidate(accountKey);
      return dotloopFetch(path, { ...options, retryOn401: false });
    }

    if (res.status === 429) {
      const reset = res.headers.get("X-RateLimit-Reset");
      throw new Error(
        `Dotloop rate limit hit (${RATE_LIMIT_PER_MINUTE} requests/minute).` +
          (reset ? ` Resets at ${reset}.` : "") +
          ` Narrow the request or process loops in smaller batches.`
      );
    }

    if (raw) {
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Dotloop API error ${res.status}: ${text.slice(0, 500)}`);
      }
      return res;
    }

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(`Dotloop API error ${res.status}: ${JSON.stringify(body).slice(0, 500)}`);
    }

    // Dotloop wraps every successful payload in { meta, data }.
    return body.data !== undefined ? body : { data: body };
  };
}

/** Appends batch_size / batch_number / sort / filter when supplied. */
function listParams(args = {}) {
  const params = new URLSearchParams();
  if (args.batch_size) params.set("batch_size", String(Math.min(args.batch_size, 100)));
  if (args.batch_number) params.set("batch_number", String(args.batch_number));
  if (args.sort) params.set("sort", args.sort);
  if (args.filter) params.set("filter", args.filter);
  if (args.include_details) params.set("include_details", "true");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function loopBase(args) {
  return `/profile/${args.profile_id}/loop/${args.loop_id}`;
}

export const TOOLS = [
  // ── Account & profiles ────────────────────────────────────────────────────
  {
    name: "dotloop_get_account",
    description:
      "Get the authenticated Dotloop account (id, name, email, default profile). Use this first to confirm the connection works.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "dotloop_list_profiles",
    description:
      "List all Dotloop profiles on the account. A profile is an agent/team/office identity; nearly every other call needs a profile_id from here.",
    inputSchema: {
      type: "object",
      properties: {
        batch_size: { type: "number", description: "Results per page (default 20, max 100)" },
        batch_number: { type: "number", description: "Page number (default 1)" },
      },
    },
  },
  {
    name: "dotloop_get_profile",
    description: "Get a single Dotloop profile by ID.",
    inputSchema: {
      type: "object",
      properties: { profile_id: { type: "number" } },
      required: ["profile_id"],
    },
  },

  // ── Loops ─────────────────────────────────────────────────────────────────
  {
    name: "dotloop_list_loops",
    description:
      "List transaction loops for a profile. Supports filtering by status/type/date and sorting by closing date, price, etc. This is the main way to find a deal.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        batch_size: { type: "number", description: "Results per page (default 20, max 100)" },
        batch_number: { type: "number", description: "Page number (default 1)" },
        sort: {
          type: "string",
          description:
            "Sort as '<category>[:asc|desc]'. Categories: default, address, created, updated, purchase_price, listing_date, expiration_date, closing_date, review_submission_date. Example: 'closing_date:asc'",
        },
        filter: {
          type: "string",
          description:
            "Filter as '<key>=<value>', comma-separated. Keys: updated_min, created_min, transaction_type, transaction_status. Example: 'transaction_status=UNDER_CONTRACT'",
        },
        include_details: {
          type: "boolean",
          description:
            "Include full loop details inline. Costs more per call but avoids a follow-up request per loop.",
        },
      },
      required: ["profile_id"],
    },
  },
  {
    name: "dotloop_get_loop",
    description: "Get a single loop's summary (name, status, transaction type, timestamps).",
    inputSchema: {
      type: "object",
      properties: { profile_id: { type: "number" }, loop_id: { type: "number" } },
      required: ["profile_id", "loop_id"],
    },
  },
  {
    name: "dotloop_get_loop_detail",
    description:
      "Get the full contract data for a loop: property address, purchase price, commission, earnest money, contract dates, offer dates, inspection and closing deadlines, listing info, and property characteristics. This is the primary tool for answering questions about a contract's terms.",
    inputSchema: {
      type: "object",
      properties: { profile_id: { type: "number" }, loop_id: { type: "number" } },
      required: ["profile_id", "loop_id"],
    },
  },
  {
    name: "dotloop_get_loop_full",
    description:
      "Convenience tool: fetch a loop's detail, participants, folders, documents, and task lists in one call. Use this when reviewing or summarizing a whole transaction, instead of making five separate calls.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        include_documents: {
          type: "boolean",
          description: "List documents inside each folder (default true).",
        },
      },
      required: ["profile_id", "loop_id"],
    },
  },
  {
    name: "dotloop_update_loop_detail",
    description:
      "Update contract fields on a loop. Pass 'details' as an object of section names to field maps, e.g. {\"Financials\": {\"Purchase/Sale Price\": \"450000\"}, \"Contract Dates\": {\"Closing Date\": \"09/30/2026\"}}. Section and field names must match those returned by dotloop_get_loop_detail exactly.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        details: {
          type: "object",
          description: "Nested object of { sectionName: { fieldName: value } } to write.",
        },
      },
      required: ["profile_id", "loop_id", "details"],
    },
  },
  {
    name: "dotloop_create_loop",
    description:
      "Create a new loop via the loop-it endpoint. Can create the property address and seed participants in one shot.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        name: { type: "string", description: "Loop name, max 200 chars (usually the address)" },
        transactionType: {
          type: "string",
          description:
            "PURCHASE_OFFER, LISTING_FOR_SALE, LISTING_FOR_LEASE, LEASE_OFFER, REAL_ESTATE_OTHER, or OTHER",
        },
        status: {
          type: "string",
          description:
            "e.g. PRE_OFFER, UNDER_CONTRACT, SOLD, ACTIVE_LISTING, PRE_LISTING, LEASED, ARCHIVED",
        },
        streetNumber: { type: "string" },
        streetName: { type: "string" },
        unit: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        county: { type: "string" },
        country: { type: "string" },
        templateId: { type: "number", description: "Loop template to apply on creation" },
        mlsId: { type: "string" },
        mlsPropertyId: { type: "string" },
        participants: {
          type: "array",
          description: "Array of { fullName, email, role }",
          items: {
            type: "object",
            properties: {
              fullName: { type: "string" },
              email: { type: "string" },
              role: { type: "string" },
            },
          },
        },
      },
      required: ["profile_id", "name", "transactionType", "status"],
    },
  },
  {
    name: "dotloop_update_loop",
    description: "Update a loop's summary fields (name, transaction type, status).",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        name: { type: "string" },
        transactionType: { type: "string" },
        status: { type: "string" },
      },
      required: ["profile_id", "loop_id"],
    },
  },

  // ── Folders & documents ───────────────────────────────────────────────────
  {
    name: "dotloop_list_folders",
    description: "List the document folders inside a loop.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        include_archived: { type: "boolean" },
      },
      required: ["profile_id", "loop_id"],
    },
  },
  {
    name: "dotloop_create_folder",
    description: "Create a new document folder inside a loop.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        name: { type: "string" },
      },
      required: ["profile_id", "loop_id", "name"],
    },
  },
  {
    name: "dotloop_list_documents",
    description: "List documents in a loop folder (id, name, timestamps).",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        folder_id: { type: "number" },
        include_archived: { type: "boolean" },
      },
      required: ["profile_id", "loop_id", "folder_id"],
    },
  },
  {
    name: "dotloop_download_document",
    description:
      "Download a document's PDF. By default the file is saved to disk and the local path is returned so it can be read separately — PDFs are far too large to return inline. Set as='base64' only for small files that must be returned over the wire.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        folder_id: { type: "number" },
        document_id: { type: "number" },
        as: {
          type: "string",
          enum: ["file", "base64", "metadata"],
          description:
            "'file' saves to disk and returns the path (default), 'base64' returns encoded bytes, 'metadata' returns JSON info only.",
        },
        filename: { type: "string", description: "Override the saved filename." },
      },
      required: ["profile_id", "loop_id", "folder_id", "document_id"],
    },
  },
  {
    name: "dotloop_upload_document",
    description: "Upload a PDF from a local file path into a loop folder.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        folder_id: { type: "number" },
        file_path: { type: "string", description: "Absolute path to the file to upload" },
        filename: { type: "string", description: "Name to store it under in Dotloop" },
      },
      required: ["profile_id", "loop_id", "folder_id", "file_path"],
    },
  },

  // ── Participants ──────────────────────────────────────────────────────────
  {
    name: "dotloop_list_participants",
    description: "List everyone attached to a loop (buyers, sellers, agents, lender, title, etc.).",
    inputSchema: {
      type: "object",
      properties: { profile_id: { type: "number" }, loop_id: { type: "number" } },
      required: ["profile_id", "loop_id"],
    },
  },
  {
    name: "dotloop_add_participant",
    description: "Add a participant to a loop.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        fullName: { type: "string" },
        email: { type: "string" },
        role: {
          type: "string",
          description:
            "e.g. BUYER, SELLER, LISTING_AGENT, BUYING_AGENT, LOAN_OFFICER, HOME_INSPECTOR, APPRAISER, ESCROW_TITLE_REP, OTHER",
        },
        Phone: { type: "string" },
        "Cell Phone": { type: "string" },
        "Company Name": { type: "string" },
      },
      required: ["profile_id", "loop_id", "fullName", "email", "role"],
    },
  },
  {
    name: "dotloop_update_participant",
    description: "Update a participant on a loop.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        participant_id: { type: "number" },
        updates: {
          type: "object",
          description: "Fields to change, e.g. { fullName, email, role, Phone }",
        },
      },
      required: ["profile_id", "loop_id", "participant_id", "updates"],
    },
  },
  {
    name: "dotloop_remove_participant",
    description: "Remove a participant from a loop. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        participant_id: { type: "number" },
      },
      required: ["profile_id", "loop_id", "participant_id"],
    },
  },

  // ── Tasks & activity ──────────────────────────────────────────────────────
  {
    name: "dotloop_list_tasklists",
    description: "List the task lists on a loop.",
    inputSchema: {
      type: "object",
      properties: { profile_id: { type: "number" }, loop_id: { type: "number" } },
      required: ["profile_id", "loop_id"],
    },
  },
  {
    name: "dotloop_list_tasks",
    description:
      "List the tasks in a loop's task list, including due dates and completion status. Use for checklist and deadline questions.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        task_list_id: { type: "number" },
      },
      required: ["profile_id", "loop_id", "task_list_id"],
    },
  },
  {
    name: "dotloop_list_activities",
    description: "List the activity/audit log for a loop — who did what and when.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        loop_id: { type: "number" },
        batch_size: { type: "number" },
        batch_number: { type: "number" },
      },
      required: ["profile_id", "loop_id"],
    },
  },

  // ── Contacts ──────────────────────────────────────────────────────────────
  {
    name: "dotloop_list_contacts",
    description: "List contacts in the Dotloop address book.",
    inputSchema: {
      type: "object",
      properties: {
        batch_size: { type: "number" },
        batch_number: { type: "number" },
        filter: { type: "string", description: "e.g. 'email=jane@example.com'" },
        sort: { type: "string" },
      },
    },
  },
  {
    name: "dotloop_get_contact",
    description: "Get a single contact by ID.",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "number" } },
      required: ["contact_id"],
    },
  },
  {
    name: "dotloop_create_contact",
    description: "Create a contact in the Dotloop address book.",
    inputSchema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        home: { type: "string" },
        office: { type: "string" },
        fax: { type: "string" },
        address: { type: "string" },
        city: { type: "string" },
        state: { type: "string" },
        zipCode: { type: "string" },
        country: { type: "string" },
      },
    },
  },
  {
    name: "dotloop_update_contact",
    description: "Update an existing contact.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: { type: "number" },
        updates: {
          type: "object",
          description:
            "Fields to change: firstName, lastName, email, home, office, fax, address, city, state, zipCode, country",
        },
      },
      required: ["contact_id", "updates"],
    },
  },
  {
    name: "dotloop_delete_contact",
    description: "Delete a contact. This cannot be undone.",
    inputSchema: {
      type: "object",
      properties: { contact_id: { type: "number" } },
      required: ["contact_id"],
    },
  },

  // ── Templates ─────────────────────────────────────────────────────────────
  {
    name: "dotloop_list_loop_templates",
    description:
      "List the loop templates available to a profile. Template IDs can be passed to dotloop_create_loop.",
    inputSchema: {
      type: "object",
      properties: {
        profile_id: { type: "number" },
        batch_size: { type: "number" },
        batch_number: { type: "number" },
      },
      required: ["profile_id"],
    },
  },
];

/**
 * Builds the tool dispatcher.
 *
 * @param {Function} dotloopFetch  Authenticated fetch from makeDotloopFetch
 * @param {object}   opts
 * @param {string}   opts.downloadDir  Where downloaded PDFs are written
 */
export function makeCallTool(dotloopFetch, { downloadDir = tmpdir() } = {}) {
  return async function callTool(name, args = {}) {
    switch (name) {
      // ── Account & profiles ──────────────────────────────────────────────
      case "dotloop_get_account":
        return await dotloopFetch("/account");

      case "dotloop_list_profiles":
        return await dotloopFetch(`/profile${listParams(args)}`);

      case "dotloop_get_profile":
        return await dotloopFetch(`/profile/${args.profile_id}`);

      // ── Loops ───────────────────────────────────────────────────────────
      case "dotloop_list_loops":
        return await dotloopFetch(`/profile/${args.profile_id}/loop${listParams(args)}`);

      case "dotloop_get_loop":
        return await dotloopFetch(loopBase(args));

      case "dotloop_get_loop_detail":
        return await dotloopFetch(`${loopBase(args)}/detail`);

      case "dotloop_get_loop_full": {
        const base = loopBase(args);
        const includeDocuments = args.include_documents !== false;

        // Fetch the independent pieces together, tolerating partial failures so
        // one missing section does not sink the whole summary.
        const [detail, participants, folders, taskLists] = await Promise.all([
          dotloopFetch(`${base}/detail`).catch((e) => ({ error: e.message })),
          dotloopFetch(`${base}/participant`).catch((e) => ({ error: e.message })),
          dotloopFetch(`${base}/folder`).catch((e) => ({ error: e.message })),
          dotloopFetch(`${base}/tasklist/`).catch((e) => ({ error: e.message })),
        ]);

        const result = { detail, participants, folders, taskLists };

        if (includeDocuments && Array.isArray(folders?.data)) {
          result.documents = {};
          for (const folder of folders.data) {
            const docs = await dotloopFetch(`${base}/folder/${folder.id}/document`).catch((e) => ({
              error: e.message,
            }));
            result.documents[folder.name ?? folder.id] = docs;
          }
        }

        return result;
      }

      case "dotloop_update_loop_detail":
        return await dotloopFetch(`${loopBase(args)}/detail`, {
          method: "PATCH",
          body: JSON.stringify(args.details),
        });

      case "dotloop_create_loop": {
        const { profile_id, ...body } = args;
        return await dotloopFetch(`/loop-it?profile_id=${profile_id}`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }

      case "dotloop_update_loop": {
        const { profile_id, loop_id, ...updates } = args;
        return await dotloopFetch(loopBase(args), {
          method: "PATCH",
          body: JSON.stringify(updates),
        });
      }

      // ── Folders & documents ─────────────────────────────────────────────
      case "dotloop_list_folders": {
        const qs = args.include_archived ? "?include_archived=true" : "";
        return await dotloopFetch(`${loopBase(args)}/folder${qs}`);
      }

      case "dotloop_create_folder":
        return await dotloopFetch(`${loopBase(args)}/folder/`, {
          method: "POST",
          body: JSON.stringify({ name: args.name }),
        });

      case "dotloop_list_documents": {
        const qs = args.include_archived ? "?include_archived=true" : "";
        return await dotloopFetch(`${loopBase(args)}/folder/${args.folder_id}/document${qs}`);
      }

      case "dotloop_download_document": {
        const path = `${loopBase(args)}/folder/${args.folder_id}/document/${args.document_id}`;

        if (args.as === "metadata") {
          return await dotloopFetch(path);
        }

        const res = await dotloopFetch(path, {
          raw: true,
          headers: { Accept: "application/pdf" },
        }).catch((err) => {
          // Metadata on the same document succeeds, so a 403 here is a grant on
          // document content rather than anything wrong with the request.
          if (/\b403\b/.test(err.message)) {
            throw new Error(
              "Dotloop denied access to this document's content (403).\n\n" +
                "Downloads need the document:read scope, which Dotloop grants on " +
                "their side per API client.\n\n" +
                "If it was NOT granted yet: ask your Partner Success Manager to " +
                "enable document downloads for this client.\n\n" +
                "If it WAS just granted: reconnect. A token issued before the " +
                "grant does not carry the new scope, and refreshing it will not " +
                "add one — the connector has to run a fresh Dotloop login. Remove " +
                "and re-add the connector, then approve again.\n\n" +
                "Meanwhile dotloop_get_loop_detail still returns contract terms " +
                "and dotloop_list_documents still shows what paperwork exists."
            );
          }
          throw err;
        });

        const buffer = Buffer.from(await res.arrayBuffer());

        if (args.as === "base64") {
          return {
            document_id: args.document_id,
            contentType: res.headers.get("content-type"),
            bytes: buffer.length,
            base64: buffer.toString("base64"),
          };
        }

        await mkdir(downloadDir, { recursive: true });
        const filename = args.filename ?? `dotloop-doc-${args.document_id}.pdf`;
        const outPath = join(downloadDir, filename);
        await writeFile(outPath, buffer);

        return {
          document_id: args.document_id,
          path: outPath,
          bytes: buffer.length,
          contentType: res.headers.get("content-type"),
          note: "Saved to disk. Read the file at this path to review its contents.",
        };
      }

      case "dotloop_upload_document": {
        const { readFile } = await import("fs/promises");
        const { basename } = await import("path");

        const bytes = await readFile(args.file_path);
        const filename = args.filename ?? basename(args.file_path);

        const form = new FormData();
        form.append("file", new Blob([bytes], { type: "application/pdf" }), filename);

        return await dotloopFetch(`${loopBase(args)}/folder/${args.folder_id}/document/`, {
          method: "POST",
          body: form,
        });
      }

      // ── Participants ────────────────────────────────────────────────────
      case "dotloop_list_participants":
        return await dotloopFetch(`${loopBase(args)}/participant`);

      case "dotloop_add_participant": {
        const { profile_id, loop_id, ...body } = args;
        return await dotloopFetch(`${loopBase(args)}/participant`, {
          method: "POST",
          body: JSON.stringify(body),
        });
      }

      case "dotloop_update_participant":
        return await dotloopFetch(`${loopBase(args)}/participant/${args.participant_id}`, {
          method: "PATCH",
          body: JSON.stringify(args.updates),
        });

      case "dotloop_remove_participant":
        return await dotloopFetch(`${loopBase(args)}/participant/${args.participant_id}`, {
          method: "DELETE",
        });

      // ── Tasks & activity ────────────────────────────────────────────────
      case "dotloop_list_tasklists":
        return await dotloopFetch(`${loopBase(args)}/tasklist/`);

      case "dotloop_list_tasks":
        return await dotloopFetch(`${loopBase(args)}/tasklist/${args.task_list_id}/task`);

      case "dotloop_list_activities":
        return await dotloopFetch(`${loopBase(args)}/activity${listParams(args)}`);

      // ── Contacts ────────────────────────────────────────────────────────
      case "dotloop_list_contacts":
        return await dotloopFetch(`/contact${listParams(args)}`);

      case "dotloop_get_contact":
        return await dotloopFetch(`/contact/${args.contact_id}`);

      case "dotloop_create_contact":
        return await dotloopFetch("/contact", {
          method: "POST",
          body: JSON.stringify(args),
        });

      case "dotloop_update_contact":
        return await dotloopFetch(`/contact/${args.contact_id}`, {
          method: "PATCH",
          body: JSON.stringify(args.updates),
        });

      case "dotloop_delete_contact":
        return await dotloopFetch(`/contact/${args.contact_id}`, { method: "DELETE" });

      // ── Templates ───────────────────────────────────────────────────────
      case "dotloop_list_loop_templates":
        return await dotloopFetch(`/profile/${args.profile_id}/loop-template${listParams(args)}`);

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  };
}
