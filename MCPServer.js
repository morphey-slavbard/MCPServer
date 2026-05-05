#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import http from "http";

// ─── Config ────────────────────────────────────────────────────────────────
const DY_API_KEY    = process.env.DY_API_KEY    || "";
const DY_SECTION_ID = process.env.DY_SECTION_ID || "";
const DY_DATA_CENTER = process.env.DY_DATA_CENTER || "dy-api.com"; // dy-api.com = EU, dy-api.eu = US
const PORT          = parseInt(process.env.PORT  || "3000", 10);

if (!DY_API_KEY)    console.warn("[warn] DY_API_KEY not set");
if (!DY_SECTION_ID) console.warn("[warn] DY_SECTION_ID not set");

// ─── In-memory session store ────────────────────────────────────────────────
// Maps a sessionKey (e.g. a userId or IP) to DY conversation state.
// In production, replace with Redis or similar.
const sessions = new Map();

function getSession(key) {
  if (!sessions.has(key)) {
    sessions.set(key, { chatId: null, dyid: null, dyid_server: null, dySession: null });
  }
  return sessions.get(key);
}

function applyResponseCookies(session, cookies = []) {
  for (const c of cookies) {
    // DY cookie names arrive with a leading underscore: _dyid, _dyid_server, _dyjsession
    const n = c.name.toLowerCase().replace(/^_/, "");
    if (n === "dyid")        session.dyid        = c.value;
    if (n === "dyid_server") session.dyid_server = c.value;
    if (n === "dyjsession")  session.dySession   = c.value;
  }
}

// ─── DY Shopping Muse call ──────────────────────────────────────────────────
async function callShoppingMuse({ text, sessionKey, pageUrl, pageReferrer, deviceType }) {
  const session = getSession(sessionKey);

  const query = { text };
  if (session.chatId) query.chatId = session.chatId;

  // Per DY docs: send {} for new users; pass dyid + dyid_server for returning users
  const userObj = session.dyid
    ? { dyid: session.dyid, ...(session.dyid_server ? { dyid_server: session.dyid_server } : {}) }
    : {};

  const sessionObj = session.dySession ? { dy: session.dySession } : {};

  const body = {
    user:    userObj,
    session: sessionObj,
    query,
    context: {
      device: {
        userAgent: "DY-MCP-Connector/1.0",
        ip:        "0.0.0.0",
      },
      page: {
        location: pageUrl || "https://example.com",
        ...(pageReferrer ? { referrer: pageReferrer } : {}),
        locale:   "en_GB",
        type:     "OTHER",
        data:     [],
      },
      channel: deviceType === "mobile" ? "app" : "web",
    },
    selector: { names: [] },
    options:  { returnAnalyticsMetadata: false },
  };

  const res = await fetch(`https://${DY_DATA_CENTER}/v2/serve/user/assistant`, {
    method:  "POST",
    headers: {
      "Content-Type": "application/json",
      "DY-API-Key":   DY_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DY API error ${res.status}: ${errText}`);
  }

  const json = await res.json();

  // Persist cookies for next turn
  if (json.cookies) applyResponseCookies(session, json.cookies);

  // Extract payload
  let data;
  try {
    data = json.choices[0].variations[0].payload.data;
  } catch {
    throw new Error("Unexpected response shape from DY API");
  }

  // Persist chatId for next turn
  if (data.chatId) session.chatId = data.chatId;

  return { data, session };
}

// ─── Format DY response for Claude ─────────────────────────────────────────
function formatResponse({ data, session }) {
  const lines = [];

  if (data.assistant) {
    lines.push(data.assistant);
    lines.push("");
  }

  if (data.support) {
    lines.push("⚠️  Support handoff flagged — this user may need customer service assistance.");
    lines.push("");
  }

  if (data.widgets && data.widgets.length > 0) {
    for (const widget of data.widgets) {
      if (widget.title) lines.push(`### ${widget.title}`);
      if (widget.slots && widget.slots.length > 0) {
        for (const slot of widget.slots) {
          const pd  = slot.productData || {};
          const name  = pd.name  || pd.title || slot.sku;
          const price = pd.price || pd.Price || pd.sale_price;
          const url   = pd.url   || pd.link  || "";
          const img   = pd.image_url || pd.imageUrl || pd.image || "";

          let line = `- **${name}** (SKU: ${slot.sku}, slotId: ${slot.slotId})`;
          if (price) line += ` — £${parseFloat(price).toFixed(2)}`;
          if (url)   line += ` — [View product](${url})`;
          if (img)   line += `\n  ![${name}](${img})`;
          lines.push(line);
        }
      }
      lines.push("");
    }
  }

  // Session state (useful for debugging / multi-turn awareness)
  lines.push(`---`);
  lines.push(`_Session: chatId ${session.chatId ? "active" : "none"} · dyid ${session.dyid ? "set" : "none"}_`);

  return lines.join("\n").trim();
}

// ─── MCP Server ─────────────────────────────────────────────────────────────
const server = new McpServer({
  name:    "dy-shopping-muse",
  version: "1.0.0",
});

server.tool(
  "ask_shopping_muse",
  "Send a natural language query to Dynamic Yield's Shopping Muse API. " +
  "Returns personalised product recommendations and an assistant message. " +
  "Maintains conversation context automatically across multiple calls. " +
  "Use for product discovery, guided shopping, and conversational search.",
  {
    query: z.string().min(1).max(250).describe(
      "The user's natural language shopping query, e.g. 'I need a gift for my mum under £50' or 'show me bestselling trainers'."
    ),
    session_key: z.string().optional().describe(
      "An identifier to scope the conversation state (e.g. a user ID or 'default'). Defaults to 'default'."
    ),
    page_url: z.string().url().optional().describe(
      "The URL of the page the user is on. Provides context to DY for personalisation."
    ),
    page_referrer: z.string().url().optional().describe(
      "The referrer URL (previous page). Improves DY targeting accuracy."
    ),
    device_type: z.enum(["desktop", "mobile", "tablet"]).optional().describe(
      "The user's device type. Defaults to desktop."
    ),
  },
  async ({ query, session_key, page_url, page_referrer, device_type }) => {
    try {
      const result = await callShoppingMuse({
        text:         query,
        sessionKey:   session_key || "default",
        pageUrl:      page_url,
        pageReferrer: page_referrer,
        deviceType:   device_type || "desktop",
      });

      return {
        content: [{ type: "text", text: formatResponse(result) }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Error calling Shopping Muse: ${err.message}` }],
        isError: true,
      };
    }
  }
);

// ─── HTTP server (Streamable HTTP transport for remote MCP) ─────────────────
const transport = new StreamableHTTPServerTransport({ path: "/mcp" });

const httpServer = http.createServer(async (req, res) => {
  // Health check endpoint
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", server: "dy-shopping-muse-mcp" }));
    return;
  }
  transport.handleRequest(req, res);
});

await server.connect(transport);

httpServer.listen(PORT, () => {
  console.log(`[dy-shopping-muse-mcp] Listening on port ${PORT}`);
  console.log(`[dy-shopping-muse-mcp] MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`[dy-shopping-muse-mcp] Health check: http://localhost:${PORT}/health`);
});