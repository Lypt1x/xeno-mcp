import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiGet, apiPost, apiDelete } from "./api.js";
import {
  searchScripts,
  fetchScripts,
  getScriptDetails,
  formatScriptList,
  detectObfuscation,
} from "./scriptblox.js";

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function formatError(data: any): string {
  if (data?.error) {
    const err = String(data.error);
    if (err.includes("Cannot reach Xeno") || err.includes("localhost:3110")) {
      return `The executor is not reachable. In Xeno mode, make sure the Xeno application is open and injected. In generic mode, this error should not appear — check if the xeno-mcp server is running.\n\nDo NOT retry automatically — this requires the user to take action.\n\nOriginal error: ${err}`;
    }
    return `Error: ${err}${data.not_found ? `\nNot found PIDs: ${JSON.stringify(data.not_found)}` : ""}${data.not_attached ? `\nNot attached: ${JSON.stringify(data.not_attached)}` : ""}`;
  }
  return JSON.stringify(data, null, 2);
}

interface ClientInfo {
  pid: string;
  username: string;
  status: number;
  status_text: string;
  logger_attached: boolean;
  label: string; // "Username(PID)"
}

async function fetchClients(): Promise<ClientInfo[]> {
  const data = await apiGet("/clients");
  if (!data?.ok || !Array.isArray(data.clients)) return [];
  return data.clients.map((c: any) => ({
    pid: String(c.pid),
    username: c.username,
    status: c.status,
    status_text: c.status_text,
    logger_attached: !!c.logger_attached,
    label: `${c.username}(${c.pid})`,
  }));
}

function formatCatchError(e: any): string {
  const msg = e?.message || String(e);
  if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
    return "The xeno-mcp HTTP server is not running. Please ask the user to start it (run xeno-mcp.exe), or restart the MCP bridge which auto-starts it. Do NOT retry automatically.";
  }
  return `Failed to reach xeno-mcp server: ${msg}`;
}

/** Resolve "Username(PID)", raw PID, or username to PID strings */
function resolveIdentifiers(identifiers: string[], clients: ClientInfo[]): { pids: string[]; errors: string[] } {
  const pids: string[] = [];
  const errors: string[] = [];

  for (const id of identifiers) {
    // Try "Username(PID)" format
    const match = id.match(/^(.+)\((\d+)\)$/);
    if (match) {
      const client = clients.find(c => c.pid === match[2]);
      if (client) { pids.push(client.pid); continue; }
      errors.push(`Client not found: ${id}`);
      continue;
    }
    // Try pure PID
    if (/^\d+$/.test(id)) {
      const client = clients.find(c => c.pid === id);
      if (client) { pids.push(client.pid); continue; }
      errors.push(`PID not found: ${id}`);
      continue;
    }
    // Try username
    const byName = clients.filter(c => c.username.toLowerCase() === id.toLowerCase());
    if (byName.length === 1) { pids.push(byName[0].pid); continue; }
    if (byName.length > 1) {
      errors.push(`Multiple clients found for username "${id}": ${byName.map(c => c.label).join(", ")}. Please specify as Username(PID).`);
      continue;
    }
    errors.push(`Client not found: ${id}`);
  }
  return { pids, errors };
}

export function registerTools(server: McpServer) {

  server.tool(
    "get_health",
    "Get the health status of the xeno-mcp server, executor connection, connected Roblox clients, and logger attachment state. Call this first to verify everything is operational and to determine the active mode (xeno or generic).",
    {},
    async () => {
      try {
        const data = await apiGet("/health");
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_clients",
    `List all connected Roblox clients.
In Xeno mode: returns each client as "Username(PID)" with their status and logger state.
In generic mode: returns clients by username with connection and heartbeat info.

Use these identifiers for execute_lua and attach_logger.

IMPORTANT: Before executing scripts or reading logs, check if the logger is attached (Xeno mode) or if a client is connected (generic mode). If not, guide the user through setup.`,
    {},
    async () => {
      try {
        const data = await apiGet("/clients");
        if (!data?.ok) return text(formatError(data));

        // Generic mode returns different client format
        if (data.mode === "generic") {
          if (!Array.isArray(data.clients) || data.clients.length === 0) {
            return text("No clients connected. The user needs to run the loader in their executor. Tell them to paste this into their executor and run it:\n\nloadstring(game:HttpGet(\"http://localhost:3111/loader-script\"))()\n\nOnce they see an in-game notification saying 'Loader connected', they should tell you and you can proceed.");
          }
          return text(JSON.stringify(data, null, 2));
        }

        // Xeno mode
        const clients = data.clients?.map((c: any) => ({
          client: `${c.username}(${c.pid})`,
          status: c.status_text,
          logger_attached: !!c.logger_attached,
        })) ?? [];

        if (clients.length === 0) {
          return text("No Roblox clients are connected. In Xeno mode, make sure Xeno is open and injected. In generic mode, run the loader script first.");
        }

        return text(JSON.stringify({ ok: true, clients }, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "execute_lua",
    `Execute a Lua script on one or more Roblox clients.

IMPORTANT REQUIREMENTS:
- The client must be "Attached" (status 3) in Xeno mode, or connected via the loader in generic mode
- The logger MUST be attached first (via attach_logger) so you can read script output through get_logs
- Without the logger, your script runs but you have NO way to see its output or verify it worked
- If the logger is not attached, ASK THE USER whether to attach it before proceeding
- Scripts are fire-and-forget: all local variables are lost after execution

EXECUTION CONSTRAINTS:
- Runs client-side only (LocalPlayer context)
- To persist state across executions, store values in getgenv() with unique keys
- Event connections MUST be stored in getgenv() and disconnected when no longer needed
- Use request() for HTTP calls, NOT HttpService:RequestAsync
- Wrap risky code in pcall() for error handling

CLIENT IDENTIFICATION:
- Pass clients as "Username(PID)" (e.g. "Lypt1x(35540)"), username, or PID
- Prefer the "Username(PID)" format from get_clients`,
    {
      script: z.string().describe("The Lua script to execute. Must be valid Luau code."),
      clients: z.array(z.string()).describe('Client identifiers — use "Username(PID)" format from get_clients, or just username or PID.'),
    },
    async ({ script, clients: identifiers }) => {
      try {
        const allClients = await fetchClients();
        const { pids, errors } = resolveIdentifiers(identifiers, allClients);

        if (errors.length > 0) {
          return text(`Error resolving clients:\n${errors.join("\n")}\n\nAvailable clients: ${allClients.map(c => c.label).join(", ") || "none"}`);
        }

        const data = await apiPost("/execute", { script, pids });
        if (!data.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "attach_logger",
    `Attach the log-forwarding script to one or more Roblox clients. Once attached, all Roblox output (print, warn, error) from those clients is captured and forwarded to the xeno-mcp server. You can then query logs with get_logs.

The logger:
- Uses getgenv().__XENO_MCP_LOGGER to prevent double-attachment
- Sends in-game notifications to confirm attachment status
- Automatically detects when the player leaves a game and updates server state
- Only needs to be attached once per client session

Clients must be "Attached" (status 3). If already attached, returns info without re-attaching.

CLIENT IDENTIFICATION:
- Pass clients as "Username(PID)" (e.g. "Lypt1x(35540)"), username, or PID
- Prefer the "Username(PID)" format from get_clients`,
    {
      clients: z.array(z.string()).describe('Client identifiers — use "Username(PID)" format from get_clients, or just username or PID.'),
    },
    async ({ clients: identifiers }) => {
      try {
        const allClients = await fetchClients();
        const { pids, errors } = resolveIdentifiers(identifiers, allClients);

        if (errors.length > 0) {
          return text(`Error resolving clients:\n${errors.join("\n")}\n\nAvailable clients: ${allClients.map(c => c.label).join(", ") || "none"}`);
        }

        const data = await apiPost("/attach-logger", { pids });
        if (!data.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_logs",
    `Query captured Roblox output logs with optional filters. Returns logs from clients that have the logger attached. Logs include the message, level (info/warn/error/output/script), source, PID, username, timestamp, and tags.

Every executed script is automatically logged with level "script", so you can retrieve previously run scripts by filtering with level "script".

IMPORTANT: Before calling this tool, ensure the logger is attached to the target client(s). If no logger is attached, you will get no logs. Ask the user whether to attach the logger first.

PAGINATION: Results are paginated with 50 logs per page by default (max: 1000). The response includes: total, page, per_page, total_pages, has_more.
- Use the "page" parameter (1-indexed) to navigate pages. Page 1 is the first page.
- Alternatively use "offset" for manual offset-based pagination.
- Check "has_more" in the response to know if there are more pages.
- Use "total_pages" to know the last page number.
- Results are sorted newest-first by default.`,
    {
      level: z.string().optional().describe("Filter by log level: 'info', 'warn', 'error', 'output', or 'script'"),
      source: z.string().optional().describe("Filter by source (substring match)"),
      search: z.string().optional().describe("Search log messages (substring match, case-insensitive)"),
      tag: z.string().optional().describe("Filter by tags (comma-separated)"),
      pid: z.string().optional().describe("Filter by client PID"),
      page: z.number().optional().describe("Page number (1-indexed). Default: 1. Use this for easy pagination."),
      limit: z.number().optional().describe("Results per page (default: 50, max: 1000)"),
      offset: z.number().optional().describe("Skip this many results (alternative to page-based pagination)"),
      order: z.string().optional().describe("Sort order: 'asc' (oldest first) or 'desc' (newest first, default)"),
      after: z.string().optional().describe("Only logs after this ISO 8601 timestamp"),
      before: z.string().optional().describe("Only logs before this ISO 8601 timestamp"),
    },
    async (params) => {
      try {
        const queryParams: Record<string, string> = {};
        if (params.level) queryParams.level = params.level;
        if (params.source) queryParams.source = params.source;
        if (params.search) queryParams.search = params.search;
        if (params.tag) queryParams.tag = params.tag;
        if (params.pid) queryParams.pid = params.pid;
        if (params.page !== undefined) queryParams.page = String(params.page);
        if (params.limit !== undefined) queryParams.limit = String(params.limit);
        if (params.offset !== undefined) queryParams.offset = String(params.offset);
        if (params.order) queryParams.order = params.order;
        if (params.after) queryParams.after = params.after;
        if (params.before) queryParams.before = params.before;

        const data = await apiGet("/logs", queryParams);

        // Inform the agent when there are no logs
        if (data.total === 0) {
          const clients = await fetchClients();
          const hints: string[] = [];

          if (clients.length === 0) {
            hints.push("No Roblox clients are connected.");
          } else {
            const withoutLogger = clients.filter(c => !c.logger_attached);
            const withLogger = clients.filter(c => c.logger_attached);

            if (withLogger.length === 0) {
              hints.push(`No clients have the logger attached. Available clients: ${clients.map(c => c.label).join(", ")}. Ask the user whether to attach the logger to these clients using attach_logger.`);
            } else {
              hints.push(`Logger is attached on ${withLogger.map(c => c.label).join(", ")} but no logs were captured. This usually means the player is not inside a game yet (e.g. still on the Roblox home page or game selection screen). Logs are only produced when the player is actively in a game session.`);
              if (withoutLogger.length > 0) {
                hints.push(`Logger is NOT attached on: ${withoutLogger.map(c => c.label).join(", ")}.`);
              }
            }
          }

          data.hint = hints.join(" ");
        }

        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "clear_logs",
    "Clear all stored logs from the xeno-mcp server. This is irreversible.",
    {},
    async () => {
      try {
        const data = await apiDelete("/logs");
        if (!data.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_loader_script",
    `Get the raw generic loader script source code. This is an INTERNAL/ADVANCED tool — only used when the server runs in generic mode (--mode generic).

IMPORTANT: In most cases, you should NOT call this tool. Instead, tell the user to paste this one-liner into their executor:
  loadstring(game:HttpGet("http://localhost:3111/loader-script"))()

This tool exists only for advanced use cases (e.g., inspecting the loader source, saving it to autoexec).
The loader includes the logger — no separate attach_logger step is needed in generic mode.`,
    {},
    async () => {
      try {
        const resp = await fetch(`http://localhost:${process.env.XENO_MCP_PORT || 3111}/loader-script`);
        const script = await resp.text();
        return text(`INTERNAL: Raw loader script source. Do NOT paste this into the chat for the user. Instead, tell them to run:\n\nloadstring(game:HttpGet("http://localhost:3111/loader-script"))()\n\n---\n\n${script}`);
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  // ── ScriptBlox Tools ───────────────────────────────────────────────────

  server.tool(
    "search_scripts",
    `Search for Roblox scripts on ScriptBlox by keyword.

Returns a paginated list of scripts (10 per page) with metadata: title, game, author, verified status, key system, views, likes, and ID.

PRESENTATION RULES:
- Present results as a numbered list to the user
- Highlight verified scripts (✅) vs unverified scripts (⚠️)
- Note scripts with key systems (🔑) — the user will need to obtain a key
- Note patched scripts (❌) — these likely no longer work
- Provide your analysis of which scripts look trustworthy based on: verified status, view count, like/dislike ratio, and whether they are patched
- The user is always the authority — present information and let them decide

PAGINATION: Use the "page" parameter to navigate. Response includes total_pages.`,
    {
      query: z.string().describe("Search keyword (e.g. 'aimbot', 'auto farm', 'blox fruits')"),
      page: z.number().optional().describe("Page number (default: 1)"),
      mode: z.string().optional().describe("'free' or 'paid'"),
      verified: z.boolean().optional().describe("Filter to verified scripts only"),
      key: z.boolean().optional().describe("Filter by key system (true = has key, false = no key)"),
      universal: z.boolean().optional().describe("Filter to universal scripts only"),
      sortBy: z.string().optional().describe("Sort by: 'views', 'likeCount', 'createdAt', 'updatedAt'"),
      order: z.string().optional().describe("Sort order: 'asc' or 'desc' (default: 'desc')"),
    },
    async (params) => {
      try {
        const data = await searchScripts({
          query: params.query,
          page: params.page,
          max: 10,
          mode: params.mode,
          verified: params.verified,
          key: params.key,
          universal: params.universal,
          sortBy: params.sortBy,
          order: params.order,
        });

        const scripts = data.result?.scripts ?? [];
        const totalPages = data.result?.totalPages ?? 0;
        const currentPage = params.page ?? 1;

        const list = formatScriptList(scripts);
        const pagination = `\nPage ${currentPage} of ${totalPages}${data.result?.nextPage ? ` | Next page: ${data.result.nextPage}` : " (last page)"}`;

        return text(`**ScriptBlox Search: "${params.query}"**\n\n${list}${pagination}\n\nUse get_script_details with the script ID to inspect a script before executing.`);
      } catch (e: any) {
        return text(`ScriptBlox API error: ${e.message}`);
      }
    }
  );

  server.tool(
    "browse_scripts",
    `Browse trending, popular, or recent scripts on ScriptBlox (no keyword required).

Returns a paginated list of scripts (10 per page) with the same metadata as search_scripts.

Use sortBy to control what you see:
- "views" — most viewed scripts
- "likeCount" — most liked scripts
- "createdAt" — newest scripts
- "updatedAt" — recently updated scripts

Same PRESENTATION RULES and safety awareness as search_scripts apply.`,
    {
      page: z.number().optional().describe("Page number (default: 1)"),
      sortBy: z.string().optional().describe("Sort by: 'views', 'likeCount', 'createdAt', 'updatedAt'"),
      order: z.string().optional().describe("Sort order: 'asc' or 'desc' (default: 'desc')"),
      mode: z.string().optional().describe("'free' or 'paid'"),
      verified: z.boolean().optional().describe("Filter to verified scripts only"),
      key: z.boolean().optional().describe("Filter by key system"),
      universal: z.boolean().optional().describe("Filter to universal scripts only"),
      placeId: z.number().optional().describe("Filter by Roblox game place ID"),
    },
    async (params) => {
      try {
        const data = await fetchScripts({
          page: params.page,
          max: 10,
          sortBy: params.sortBy,
          order: params.order,
          mode: params.mode,
          verified: params.verified,
          key: params.key,
          universal: params.universal,
          placeId: params.placeId,
        });

        const scripts = data.result?.scripts ?? [];
        const totalPages = data.result?.totalPages ?? 0;
        const currentPage = params.page ?? 1;

        const list = formatScriptList(scripts);
        const pagination = `\nPage ${currentPage} of ${totalPages}${data.result?.nextPage ? ` | Next page: ${data.result.nextPage}` : " (last page)"}`;

        return text(`**ScriptBlox Browse**\n\n${list}${pagination}\n\nUse get_script_details with the script ID to inspect a script before executing.`);
      } catch (e: any) {
        return text(`ScriptBlox API error: ${e.message}`);
      }
    }
  );

  server.tool(
    "get_script_details",
    `Fetch full details and raw source code of a specific ScriptBlox script.

Returns: title, game, author, description, verified status, key system info, view/like counts, and the raw script content.

SAFETY RULES — YOU MUST FOLLOW THESE:
1. If the script is NOT verified: You MUST tell the user it is unverified and ask if they want to proceed. Do NOT silently continue.
2. If the script appears obfuscated (the response will tell you): WARN the user that the script content cannot be inspected for safety and suggest caution.
3. If the script has a key system: INFORM the user that a key is required and they may need to visit an external link to get it.
4. NEVER auto-execute a script from this tool. Always present the information and let the user decide.
5. The user is ALWAYS the authority. Present your analysis and recommendations, then wait for their decision.`,
    {
      script_id: z.string().describe("The ScriptBlox script ID (the _id field from search/browse results)"),
    },
    async ({ script_id }) => {
      try {
        const { meta, rawScript } = await getScriptDetails(script_id);
        const isObfuscated = rawScript ? detectObfuscation(rawScript) : false;

        const warnings: string[] = [];
        if (!meta.verified) warnings.push("⚠️ UNVERIFIED: This script has not been verified by ScriptBlox. Ask the user for confirmation before proceeding.");
        if (isObfuscated) warnings.push("⚠️ OBFUSCATED: This script appears to be obfuscated. The code cannot be meaningfully inspected for safety. Advise the user to proceed with caution.");
        if (meta.key) warnings.push(`🔑 KEY SYSTEM: This script requires a key. ${meta.keyLink ? `Key link: ${meta.keyLink}` : "The user will need to find the key source."}`);
        if (meta.isPatched) warnings.push("❌ PATCHED: This script is marked as patched and may no longer work.");

        const info = [
          `**${meta.title}**`,
          ``,
          `Game: ${meta.game?.name ?? (meta.universal ? "Universal" : "Unknown")}`,
          `Author: ${meta.owner?.username ?? "Unknown"}`,
          `Verified: ${meta.verified ? "✅ Yes" : "⚠️ No"}`,
          `Key System: ${meta.key ? "🔑 Yes" : "No"}`,
          `Universal: ${meta.universal ? "Yes" : "No"}`,
          `Patched: ${meta.isPatched ? "❌ Yes" : "No"}`,
          `Views: ${meta.views} | Likes: ${meta.likeCount} | Dislikes: ${meta.dislikeCount}`,
          `Created: ${meta.createdAt} | Updated: ${meta.updatedAt}`,
          meta.description ? `\nDescription: ${meta.description}` : "",
        ].filter(Boolean).join("\n");

        const warningBlock = warnings.length > 0 ? `\n\n--- WARNINGS ---\n${warnings.join("\n")}` : "";
        const scriptPreview = rawScript
          ? `\n\n--- SCRIPT CONTENT (${rawScript.length} chars${isObfuscated ? ", OBFUSCATED" : ""}) ---\n${rawScript.length > 3000 ? rawScript.slice(0, 3000) + "\n... [truncated]" : rawScript}`
          : "\n\n--- SCRIPT CONTENT ---\nUnable to retrieve raw script content.";

        return text(`${info}${warningBlock}${scriptPreview}\n\nScript ID: ${meta._id}\nTo execute this script, use execute_scriptblox_script with this ID and target clients.`);
      } catch (e: any) {
        return text(`ScriptBlox API error: ${e.message}`);
      }
    }
  );

  server.tool(
    "execute_scriptblox_script",
    `Fetch a script from ScriptBlox and execute it on target Roblox clients.

This is a convenience tool that combines get_script_details + execute_lua.

CRITICAL SAFETY RULES:
1. If the script is NOT verified: You MUST STOP and return the script details to the user. Ask them to confirm execution. Do NOT execute unverified scripts without explicit user approval.
2. If the script is obfuscated: WARN the user before executing.
3. If the script has a key system: INFORM the user they need a key.
4. The user MUST have seen the script details (via get_script_details or from this tool's response) before you execute.
5. The user is ALWAYS the final authority on whether to execute.

WORKFLOW:
- If unverified: return details + ask for confirmation → user says yes → call this tool again with confirmed=true
- If verified: execute directly but still show warnings for obfuscation/key system`,
    {
      script_id: z.string().describe("The ScriptBlox script ID"),
      clients: z.array(z.string()).describe('Client identifiers — use "Username(PID)" format from get_clients, or just username or PID.'),
      confirmed: z.boolean().optional().describe("Set to true ONLY after the user has explicitly confirmed execution of an unverified script. Default: false."),
    },
    async ({ script_id, clients: identifiers, confirmed }) => {
      try {
        // Fetch script
        const { meta, rawScript } = await getScriptDetails(script_id);

        if (!rawScript) {
          return text(`Failed to retrieve script content for "${meta.title}" (${script_id}). Cannot execute without script content.`);
        }

        const isObfuscated = detectObfuscation(rawScript);

        // Safety gate: block unverified scripts unless user confirmed
        if (!meta.verified && !confirmed) {
          const warnings: string[] = ["⚠️ UNVERIFIED SCRIPT — EXECUTION BLOCKED"];
          warnings.push(`This script "${meta.title}" is NOT verified by ScriptBlox.`);
          warnings.push(`Author: ${meta.owner?.username ?? "Unknown"} | Views: ${meta.views} | Likes: ${meta.likeCount}`);
          if (isObfuscated) warnings.push("⚠️ The script also appears to be OBFUSCATED and cannot be inspected.");
          if (meta.key) warnings.push(`🔑 This script requires a key system.${meta.keyLink ? ` Key link: ${meta.keyLink}` : ""}`);
          if (meta.isPatched) warnings.push("❌ This script is marked as PATCHED and may not work.");
          warnings.push("");
          warnings.push("Ask the user if they want to:");
          warnings.push("1. View the script content first (use get_script_details)");
          warnings.push("2. Execute anyway (call this tool again with confirmed=true)");
          warnings.push("3. Cancel");
          return text(warnings.join("\n"));
        }

        // Warnings for verified scripts
        const notes: string[] = [];
        if (isObfuscated) notes.push("⚠️ Note: This script appears obfuscated.");
        if (meta.key) notes.push(`🔑 Note: This script uses a key system.${meta.keyLink ? ` Key link: ${meta.keyLink}` : ""}`);
        if (meta.isPatched) notes.push("❌ Note: This script is marked as patched.");

        // Resolve clients and execute
        const allClients = await fetchClients();
        const { pids, errors } = resolveIdentifiers(identifiers, allClients);

        if (errors.length > 0) {
          return text(`Error resolving clients:\n${errors.join("\n")}\n\nAvailable clients: ${allClients.map(c => c.label).join(", ") || "none"}`);
        }

        const data = await apiPost("/execute", { script: rawScript, pids });
        if (!data.ok) return text(formatError(data));

        const result = [
          `✅ Executed "${meta.title}" on ${pids.length} client(s).`,
          ...notes,
          "",
          JSON.stringify(data, null, 2),
        ];
        return text(result.join("\n"));
      } catch (e: any) {
        if (e.message?.includes("ECONNREFUSED") || e.message?.includes("fetch failed")) {
          return text(formatCatchError(e));
        }
        return text(`Error: ${e.message}`);
      }
    }
  );
}
