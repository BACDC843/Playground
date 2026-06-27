#!/usr/bin/env node
/**
 * MCP server for the GoHighLevel API.
 * Exposes tools for contact and opportunity management used by the
 * ghl-renew-urban plugin skills.
 *
 * Required environment variables:
 *   GHL_API_KEY        – GoHighLevel private integration API key
 *   GHL_LOCATION_ID    – Sub-account (location) ID to operate on
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

const { GHL_API_KEY, GHL_LOCATION_ID } = process.env;

if (!GHL_API_KEY || !GHL_LOCATION_ID) {
  process.stderr.write(
    "Error: GHL_API_KEY and GHL_LOCATION_ID environment variables are required.\n"
  );
  process.exit(1);
}

async function ghlFetch(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      Version: API_VERSION,
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GHL API error ${res.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

const TOOLS = [
  {
    name: "ghl_search_contacts",
    description:
      "Search GoHighLevel contacts by name, email, or phone within the configured location.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term (name, email, or phone)" },
        limit: { type: "number", description: "Max results to return (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "ghl_get_contact",
    description: "Retrieve full details for a single GoHighLevel contact by ID.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "GHL contact ID" },
      },
      required: ["contactId"],
    },
  },
  {
    name: "ghl_update_contact",
    description:
      "Update fields on a GoHighLevel contact (tags, custom fields, pipeline stage, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "GHL contact ID" },
        updates: {
          type: "object",
          description:
            "Fields to update. Supported keys: tags (array), customFields (array of {id, field_value}), source, assignedTo.",
        },
      },
      required: ["contactId", "updates"],
    },
  },
  {
    name: "ghl_add_contact_note",
    description: "Add a note to a GoHighLevel contact.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "GHL contact ID" },
        body: { type: "string", description: "Note text" },
      },
      required: ["contactId", "body"],
    },
  },
  {
    name: "ghl_search_opportunities",
    description:
      "Search GoHighLevel opportunities (deals) by name or contact within the configured location.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search term" },
        pipelineId: { type: "string", description: "Filter by pipeline ID (optional)" },
        status: {
          type: "string",
          enum: ["open", "won", "lost", "abandoned", "all"],
          description: "Opportunity status filter (default: open)",
        },
        limit: { type: "number", description: "Max results (default 20)" },
      },
      required: ["query"],
    },
  },
  {
    name: "ghl_get_opportunity",
    description: "Retrieve full details for a single GoHighLevel opportunity by ID.",
    inputSchema: {
      type: "object",
      properties: {
        opportunityId: { type: "string", description: "GHL opportunity ID" },
      },
      required: ["opportunityId"],
    },
  },
  {
    name: "ghl_update_opportunity",
    description:
      "Update a GoHighLevel opportunity (stage, value, close date, status, assignedTo).",
    inputSchema: {
      type: "object",
      properties: {
        opportunityId: { type: "string", description: "GHL opportunity ID" },
        updates: {
          type: "object",
          description:
            "Fields to update. Supported keys: name, stageId, status, monetaryValue, closeDate (ISO 8601), assignedTo.",
        },
      },
      required: ["opportunityId", "updates"],
    },
  },
  {
    name: "ghl_list_pipelines",
    description:
      "List all GoHighLevel pipelines and their stages for the configured location.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "ghl_search_contacts": {
      const params = new URLSearchParams({
        locationId: GHL_LOCATION_ID,
        query: args.query,
        limit: String(args.limit ?? 20),
      });
      const data = await ghlFetch(`/contacts/?${params}`);
      return data.contacts ?? data;
    }

    case "ghl_get_contact": {
      const data = await ghlFetch(`/contacts/${args.contactId}`);
      return data.contact ?? data;
    }

    case "ghl_update_contact": {
      const data = await ghlFetch(`/contacts/${args.contactId}`, {
        method: "PUT",
        body: JSON.stringify(args.updates),
      });
      return data.contact ?? data;
    }

    case "ghl_add_contact_note": {
      const data = await ghlFetch(`/contacts/${args.contactId}/notes`, {
        method: "POST",
        body: JSON.stringify({ body: args.body, userId: "api" }),
      });
      return data.note ?? data;
    }

    case "ghl_search_opportunities": {
      const params = new URLSearchParams({
        location_id: GHL_LOCATION_ID,
        q: args.query,
        limit: String(args.limit ?? 20),
        status: args.status ?? "open",
      });
      if (args.pipelineId) params.set("pipeline_id", args.pipelineId);
      const data = await ghlFetch(`/opportunities/search?${params}`);
      return data.opportunities ?? data;
    }

    case "ghl_get_opportunity": {
      const data = await ghlFetch(`/opportunities/${args.opportunityId}`);
      return data.opportunity ?? data;
    }

    case "ghl_update_opportunity": {
      const data = await ghlFetch(`/opportunities/${args.opportunityId}`, {
        method: "PUT",
        body: JSON.stringify(args.updates),
      });
      return data.opportunity ?? data;
    }

    case "ghl_list_pipelines": {
      const params = new URLSearchParams({ locationId: GHL_LOCATION_ID });
      const data = await ghlFetch(`/opportunities/pipelines?${params}`);
      return data.pipelines ?? data;
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const server = new Server(
  { name: "ghl-renew-urban", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await callTool(name, args ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
