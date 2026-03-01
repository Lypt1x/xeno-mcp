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

CRITICAL — NEVER BLOCK GAME TRAFFIC:
- NEVER replace OnClientInvoke callbacks on RemoteFunctions — this WILL freeze the game
- NEVER let a hook on __namecall, FireServer, or InvokeServer error without returning old(self, ...) — an unhandled error inside a hook drops the call and freezes gameplay
- ALL logging inside hooks MUST be wrapped in pcall() so errors never prevent the original call from going through
- Always call the original function unconditionally: wrap your logic in pcall, THEN return old(self, ...) or old(self, unpack(args)) — never skip calling old()
- Hooks on __namecall must use safeClosure to match the closure type of the original — raw Lua closures can cause silent call drops on some executors
- If hooking __namecall for remotes, prefer the dual-hook redirect pattern: hookfunction(FireServer) + hookmetamethod("__namecall") that redirects remote calls to the hookfunction'd version instead of calling old() directly — see .github/REMOTE_SPY_FINDINGS.md for the full pattern
- Test hooks in isolation before combining — stacked/layered hooks compound failures

STOPPABLE SCRIPTS — CLEANUP PATTERN:
- Every long-running script (listeners, hooks, loops) MUST store a cleanup/disconnect function in getgenv() so it can be stopped later without rejoining
- Use a unique key like getgenv().__MY_FEATURE and include a .Disconnect() or .Stop() method
- Before injecting, check if already running: if getgenv().__MY_FEATURE then getgenv().__MY_FEATURE.Disconnect() end — this prevents stacking
- For hookmetamethod: store the old metamethod and restore it on disconnect
- For event connections: store all RBXScriptConnection objects and call :Disconnect() on each
- For loops: use a flag (e.g. getgenv().__MY_FEATURE_RUNNING = true) and check it each iteration
- Example pattern:
  if getgenv().__SPY then getgenv().__SPY.Disconnect() end
  local connections = {}
  -- ... set up hooks/listeners, table.insert(connections, conn) ...
  getgenv().__SPY = {
    Disconnect = function()
      for _, c in ipairs(connections) do pcall(function() c:Disconnect() end) end
      -- restore hooks: hookmetamethod(game, "__namecall", oldNamecall)
      getgenv().__SPY = nil
      print("Stopped")
    end
  }

VARARG GOTCHA IN LUAU:
- Cannot use '...' inside pcall(function() ... end) — will cause a compile error
- Capture args first: local args = {...} then use args inside pcall and unpack(args) when forwarding

CLIENT IDENTIFICATION:
- Pass clients as "Username(PID)" (e.g. "Lypt1x(35540)"), username, or PID
- Prefer the "Username(PID)" format from get_clients
- If you pass an EMPTY clients array and there is exactly ONE connected client, it will be auto-selected`,
    {
      script: z.string().describe("The Lua script to execute. Must be valid Luau code."),
      clients: z.array(z.string()).optional().describe('Client identifiers — use "Username(PID)" format from get_clients, or just username or PID. Leave empty to auto-select if only one client is connected.'),
    },
    async ({ script, clients: identifiers }) => {
      try {
        const allClients = await fetchClients();

        // Auto-select single client when no identifiers provided
        const resolvedIdentifiers = (!identifiers || identifiers.length === 0)
          ? (allClients.length === 1 ? [allClients[0].label] : [])
          : identifiers;

        if (resolvedIdentifiers.length === 0) {
          if (allClients.length === 0) {
            return text("No clients connected. Cannot execute script.");
          }
          return text(`Multiple clients connected. Please specify which client(s) to target:\n${allClients.map(c => `  - ${c.label}`).join("\n")}`);
        }

        const { pids, errors } = resolveIdentifiers(resolvedIdentifiers, allClients);

        if (errors.length > 0) {
          return text(`Error resolving clients:\n${errors.join("\n")}\n\nAvailable clients: ${allClients.map(c => c.label).join(", ") || "none"}`);
        }

        const data = await apiPost("/execute", { script, pids });
        if (!data.ok) return text(formatError(data));

        // In generic mode, poll for script output to give instant feedback
        if (data.mode === "generic") {
          const afterTs = new Date().toISOString();
          let capturedOutput: string[] = [];
          for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 500));
            try {
              const logs = await apiGet("/logs", {
                after: afterTs,
                limit: "20",
                order: "asc",
              });
              if (logs.logs && Array.isArray(logs.logs)) {
                for (const log of logs.logs) {
                  const line = `[${log.level}] ${log.message}`;
                  if (!capturedOutput.includes(line)) {
                    capturedOutput.push(line);
                  }
                }
              }
              // Stop early if we got error/output logs (not just loader info)
              if (capturedOutput.some(l => l.startsWith("[output]") || l.startsWith("[error]") || l.startsWith("[warn]"))) break;
            } catch { /* ignore polling errors */ }
          }

          if (capturedOutput.length > 0) {
            data.captured_output = capturedOutput;
          }
        }

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
For autoexec setup, the user just needs to save the one-liner above into a .lua file in their executor's autoexec folder.
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

  // --- Remote Spy Tools ---

  server.tool(
    "attach_spy",
    `Start the remote spy on connected Roblox clients. Intercepts both incoming (server→client) and outgoing (client→server) remote events and functions.

BEHAVIOR:
- Logs are deduplicated by default: only the FIRST occurrence of each unique remote (by path + direction + method) is logged
- To get ALL calls for a specific remote, use spy_subscribe after attaching
- Spy logs are stored with source="remote_spy" — query them with get_logs using source="remote_spy"
- Filter by direction using tag="in" or tag="out"
- The spy uses the dual-hook redirect pattern (hookfunction + hookmetamethod) to avoid blocking game traffic

REQUIREMENTS:
- Only works in generic mode (requires UNC hook functions: hookfunction, hookmetamethod, newcclosure)
- In Xeno mode, returns an error explaining why it can't work
- Logger should be attached first so you can see spy status messages

CLEANUP:
- Use detach_spy to stop the spy and restore all hooks
- The spy auto-cleans up when the player leaves the game`,
    {
      pids: z.array(z.string()).optional().describe('Client identifiers (Xeno mode only). In generic mode, omit this — the spy script is sent via the exchange directory.'),
    },
    async ({ pids }) => {
      try {
        const data = await apiPost("/spy/attach", { pids: pids || [] });
        if (!data.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "detach_spy",
    `Stop the remote spy and restore all hooks. This disconnects all listeners and restores the original __namecall, FireServer, and InvokeServer functions.

After detaching, no more spy logs will be generated. Server-side spy state (subscriptions, tracked clients) is also cleared.`,
    {
      pids: z.array(z.string()).optional().describe('Client identifiers (Xeno mode only). In generic mode, omit this.'),
    },
    async ({ pids }) => {
      try {
        const data = await apiPost("/spy/detach", { pids: pids || [] });
        if (!data.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "spy_subscribe",
    `Subscribe to a specific remote path for full logging (bypasses dedup). By default, the spy only logs the first occurrence of each remote. Subscribing to a remote path makes the spy log EVERY call to that remote, including all arguments.

Use this when you need to track the data being sent to or received from a specific remote over time.

Supports partial matching: subscribing to "Remotes" will match "Remotes.SetAFK", "Remotes.BuyItem", etc.

Example paths: "ReplicatedStorage.Remotes.SetAFK", "ReplicatedStorage.TS.GeneratedNetworkRemotes"`,
    {
      path: z.string().describe('The remote path (or partial path) to subscribe to. Supports partial matching.'),
      pids: z.array(z.string()).optional().describe('Client identifiers (Xeno mode only).'),
    },
    async ({ path, pids }) => {
      try {
        const data = await apiPost("/spy/subscribe", { path, pids: pids || [] });
        if (!data.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "spy_unsubscribe",
    `Unsubscribe from a remote path, returning it to dedup-only mode. After unsubscribing, only the first occurrence of calls to this remote will be logged again.`,
    {
      path: z.string().describe('The remote path to unsubscribe from.'),
      pids: z.array(z.string()).optional().describe('Client identifiers (Xeno mode only).'),
    },
    async ({ path, pids }) => {
      try {
        const data = await apiPost("/spy/unsubscribe", { path, pids: pids || [] });
        if (!data.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  // ── Game Scanner Tools ─────────────────────────────────────────────────

  server.tool(
    "scan_game",
    `Scan a Roblox game's entire client-side hierarchy and cache it on disk. Captures: instance tree, decompiled scripts, remotes, properties, and services.

The scanner injects a Lua script into the game client that walks the hierarchy, decompiles scripts (if the executor supports it), and streams the data back to the server in chunks. Results are persisted as JSON files and can be queried later without re-scanning.

FRESHNESS: If a scan already exists for this PlaceId, compares the stored PlaceVersion with the current one. If versions match and force=false, returns the cached manifest without re-scanning.

SCOPES: Control what gets scanned:
- "tree" — full instance hierarchy (classes, names, paths)
- "scripts" — all LocalScripts and ModuleScripts with decompiled source + auto-generated outlines
- "remotes" — RemoteEvents, RemoteFunctions, BindableEvents, BindableFunctions
- "properties" — key properties of BaseParts, Humanoids, Models, etc.
- "services" — top-level game services with direct children summary

TIMING: Scans can take 30–120 seconds depending on game size. The tool polls /scan/status until completion or timeout.`,
    {
      client: z.string().describe('Client identifier — use "Username(PID)" format, username, or PID. Only one client can be scanned at a time.'),
      scopes: z.array(z.string()).optional().describe('Scopes to scan. Default: all scopes. Options: "tree", "scripts", "remotes", "properties", "services"'),
      force: z.boolean().optional().describe('Force a fresh scan even if cached data exists and is up to date. Default: false.'),
    },
    async ({ client, scopes, force }) => {
      try {
        const allClients = await fetchClients();
        const { pids, errors } = resolveIdentifiers([client], allClients);

        if (errors.length > 0) {
          return text(`Error resolving client:\n${errors.join("\n")}\n\nAvailable clients: ${allClients.map(c => c.label).join(", ") || "none"}`);
        }

        const pid = pids[0];

        // Step 1: Get PlaceId + PlaceVersion from the client
        const metaScript = `
          local HttpService = game:GetService("HttpService")
          local MarketplaceService = game:GetService("MarketplaceService")
          local name = "Unknown"
          pcall(function()
            name = MarketplaceService:GetProductInfo(game.PlaceId).Name
          end)
          print("__SCAN_META__" .. HttpService:JSONEncode({
            placeId = game.PlaceId,
            placeVersion = game.PlaceVersion,
            gameName = name,
          }))
        `;
        await apiPost("/execute", { script: metaScript, pids: [pid] });

        // Wait briefly for the print to arrive in logs
        await new Promise(r => setTimeout(r, 1500));

        // Read the metadata from logs
        const logs = await apiGet("/logs", { search: "__SCAN_META__", limit: "1", order: "desc" });
        let placeId: number | null = null;
        let placeVersion: number | null = null;

        if (logs?.logs?.length > 0) {
          const msg = logs.logs[0].message;
          const jsonStart = msg.indexOf("{");
          if (jsonStart >= 0) {
            try {
              const meta = JSON.parse(msg.slice(jsonStart));
              placeId = meta.placeId;
              placeVersion = meta.placeVersion;
            } catch { /* parse failed */ }
          }
        }

        // Step 2: check if cached data is fresh
        if (placeId && !force) {
          try {
            const cached = await apiGet(`/games/${placeId}`);
            if (cached?.ok && cached.manifest) {
              const storedVersion = cached.manifest.place_version;
              if (storedVersion === placeVersion) {
                return text(JSON.stringify({
                  ok: true,
                  status: "cached",
                  message: `Game data is up to date (PlaceVersion ${placeVersion}). Use get_game_tree, get_game_scripts, etc. to query it.`,
                  manifest: cached.manifest,
                }, null, 2));
              }
            }
          } catch { /* no cached data */ }
        }

        // Step 3: inject the scanner
        const scopeList = scopes || ["services", "tree", "scripts", "remotes", "properties"];
        const scopeJson = JSON.stringify(scopeList);

        // Fetch the scanner template from the server (template vars get filled in server-side)
        const scriptResp = await fetch(
          `http://localhost:${process.env.XENO_MCP_PORT || 3111}/scanner-script?scopes=${encodeURIComponent(scopeJson)}`
        );
        const scannerScript = await scriptResp.text();

        const execResult = await apiPost("/execute", { script: scannerScript, pids: [pid] });
        if (!execResult.ok) return text(formatError(execResult));

        // Step 4: poll scan status until complete or timeout
        const timeoutMs = 180_000; // 3 minutes
        const pollInterval = 3000;
        const start = Date.now();

        while (Date.now() - start < timeoutMs) {
          await new Promise(r => setTimeout(r, pollInterval));

          const status = await apiGet("/scan/status");
          if (!status?.ok) continue;

          const activeScan = status.scans?.find((s: any) => s.place_id === placeId);
          if (!activeScan) {
            // Scan finished (removed from active) — check for manifest
            if (placeId) {
              const result = await apiGet(`/games/${placeId}`);
              if (result?.ok && result.manifest) {
                return text(JSON.stringify({
                  ok: true,
                  status: "complete",
                  message: `Scan complete! ${result.manifest.instance_count} instances, ${result.manifest.script_count} scripts, ${result.manifest.remote_count} remotes scanned in ${result.manifest.scan_duration_secs.toFixed(1)}s.`,
                  manifest: result.manifest,
                }, null, 2));
              }
            }
            // No manifest yet but scan gone — might have failed
            break;
          }
        }

        // Timeout or scan disappeared without manifest
        if (placeId) {
          const finalCheck = await apiGet(`/games/${placeId}`);
          if (finalCheck?.ok && finalCheck.manifest) {
            return text(JSON.stringify({
              ok: true,
              status: "complete",
              manifest: finalCheck.manifest,
            }, null, 2));
          }
        }

        return text(JSON.stringify({
          ok: false,
          error: "Scan timed out or failed. The scanner may still be running in-game. Check scan status with get_scan_status.",
        }, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_scan_status",
    `Check the status of any active game scans. Returns which scans are currently in progress, what chunk type they're receiving, and when they started.`,
    {},
    async () => {
      try {
        const data = await apiGet("/scan/status");
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "list_scanned_games",
    `List all games that have been scanned and stored on disk. Returns an array of manifests with PlaceId, game name, PlaceVersion, scan date, instance/script/remote counts, and tree hash.

Use this to see what game data is available before querying specific scopes.`,
    {},
    async () => {
      try {
        const data = await apiGet("/games");
        if (!data?.ok) return text(formatError(data));

        if (!data.games || data.games.length === 0) {
          return text("No games have been scanned yet. Use scan_game to scan a game first.");
        }

        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_game_info",
    `Get the scan manifest for a specific game by PlaceId. Returns metadata: PlaceVersion, game name, scan date, instance/script/remote counts, tree hash, scanned scopes, and whether the executor supported decompilation.`,
    {
      placeId: z.number().describe("The Roblox PlaceId of the game."),
    },
    async ({ placeId }) => {
      try {
        const data = await apiGet(`/games/${placeId}`);
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_game_tree",
    `Get the instance tree for a scanned game. Returns the full hierarchy of Instances with name, class name, path, and children.

FILTERING: Use path, className, or search to narrow results. Use maxDepth to limit tree depth.
- path: filter by path prefix (e.g. "Workspace.Map")
- className: filter by exact class name (e.g. "Part", "Model")
- search: substring match on name or path
- maxDepth: limit how many levels deep to return children`,
    {
      placeId: z.number().describe("The Roblox PlaceId."),
      path: z.string().optional().describe("Filter by path prefix (e.g. 'Workspace.Map')"),
      className: z.string().optional().describe("Filter by exact ClassName"),
      search: z.string().optional().describe("Search by name or path substring"),
      maxDepth: z.number().optional().describe("Maximum tree depth to return"),
    },
    async ({ placeId, path, className, search, maxDepth }) => {
      try {
        const params: Record<string, string> = {};
        if (path) params.path = path;
        if (className) params.class = className;
        if (search) params.search = search;
        if (maxDepth !== undefined) params.max_depth = String(maxDepth);

        const data = await apiGet(`/games/${placeId}/tree`, params);
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_game_scripts",
    `Get scripts from a scanned game. By default returns OUTLINES only (function signatures, requires, services used, remote accesses, top-level variables, line count) — NOT full source code. This keeps responses small and avoids flooding the context window.

To get full decompiled source: set includeSource=true AND provide a path filter. Never request all sources at once — filter to the specific script(s) you need.

WORKFLOW:
1. Call with no filters to see all script outlines
2. Identify interesting scripts from their outlines
3. Call again with includeSource=true and path="Exact.Script.Path" to read specific sources

FILTERING:
- path: filter by path prefix
- className: "LocalScript" or "ModuleScript"
- search: searches in script path and outline content`,
    {
      placeId: z.number().describe("The Roblox PlaceId."),
      path: z.string().optional().describe("Filter by script path prefix"),
      className: z.string().optional().describe("Filter by ClassName: 'LocalScript' or 'ModuleScript'"),
      search: z.string().optional().describe("Search in path and outline content"),
      includeSource: z.boolean().optional().describe("Include full decompiled source code. MUST be combined with a path filter. Default: false"),
    },
    async ({ placeId, path, className, search, includeSource }) => {
      try {
        if (includeSource && !path && !search) {
          return text("When includeSource is true, you MUST provide a path or search filter to avoid returning all script sources at once. Filter to specific scripts first.");
        }

        const params: Record<string, string> = {};
        if (path) params.path = path;
        if (className) params.class = className;
        if (search) params.search = search;
        if (includeSource) params.include_source = "true";

        const data = await apiGet(`/games/${placeId}/scripts`, params);
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_game_remotes",
    `Get all remote and bindable instances from a scanned game. Returns path and class name for each.

FILTERING:
- className: filter by type (e.g. "RemoteEvent", "RemoteFunction", "BindableEvent")
- path: filter by path prefix
- search: substring match on path`,
    {
      placeId: z.number().describe("The Roblox PlaceId."),
      path: z.string().optional().describe("Filter by path prefix"),
      className: z.string().optional().describe("Filter by ClassName"),
      search: z.string().optional().describe("Search by path substring"),
    },
    async ({ placeId, path, className, search }) => {
      try {
        const params: Record<string, string> = {};
        if (path) params.path = path;
        if (className) params.class = className;
        if (search) params.search = search;

        const data = await apiGet(`/games/${placeId}/remotes`, params);
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_game_properties",
    `Get scanned instance properties from a game. Returns key properties (Position, Size, Material, etc.) for BaseParts, Models, Humanoids, Cameras, Lights, Sounds, and UI components.

FILTERING:
- path: filter by path prefix
- className: filter by ClassName
- search: substring match on path`,
    {
      placeId: z.number().describe("The Roblox PlaceId."),
      path: z.string().optional().describe("Filter by path prefix"),
      className: z.string().optional().describe("Filter by ClassName"),
      search: z.string().optional().describe("Search by path substring"),
    },
    async ({ placeId, path, className, search }) => {
      try {
        const params: Record<string, string> = {};
        if (path) params.path = path;
        if (className) params.class = className;
        if (search) params.search = search;

        const data = await apiGet(`/games/${placeId}/properties`, params);
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "get_game_services",
    `Get the top-level game services from a scanned game. Returns service name, class name, child count, and a summary of direct children.`,
    {
      placeId: z.number().describe("The Roblox PlaceId."),
    },
    async ({ placeId }) => {
      try {
        const data = await apiGet(`/games/${placeId}/services`);
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "check_game_freshness",
    `Check whether stored game data is still up to date by comparing the cached PlaceVersion with the live one. Runs a small Lua snippet to fetch the current PlaceVersion and compares it with what's stored.

Returns whether the data is fresh or stale, and both version numbers.`,
    {
      client: z.string().describe('Client identifier — use "Username(PID)" format, username, or PID.'),
      placeId: z.number().describe("The PlaceId to check freshness for."),
    },
    async ({ client, placeId }) => {
      try {
        const allClients = await fetchClients();
        const { pids, errors } = resolveIdentifiers([client], allClients);
        if (errors.length > 0) {
          return text(`Error resolving client:\n${errors.join("\n")}`);
        }

        // Get stored version
        const cached = await apiGet(`/games/${placeId}`);
        if (!cached?.ok || !cached.manifest) {
          return text(`No stored data found for PlaceId ${placeId}. Run scan_game first.`);
        }
        const storedVersion = cached.manifest.place_version;

        // Get current version from client
        await apiPost("/execute", {
          script: `print("__VERSION_CHECK__" .. game.PlaceVersion)`,
          pids: [pids[0]],
        });
        await new Promise(r => setTimeout(r, 1000));
        const logs = await apiGet("/logs", { search: "__VERSION_CHECK__", limit: "1", order: "desc" });

        let currentVersion: number | null = null;
        if (logs?.logs?.length > 0) {
          const match = logs.logs[0].message.match(/__VERSION_CHECK__(\d+)/);
          if (match) currentVersion = parseInt(match[1], 10);
        }

        if (currentVersion === null) {
          return text("Could not retrieve current PlaceVersion from client. Make sure the logger is attached and the player is in-game.");
        }

        const fresh = currentVersion === storedVersion;
        return text(JSON.stringify({
          ok: true,
          fresh,
          stored_version: storedVersion,
          current_version: currentVersion,
          message: fresh
            ? "Game data is up to date."
            : `Game data is stale. Stored: v${storedVersion}, Current: v${currentVersion}. Run scan_game with force=true to update.`,
        }, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "delete_game_data",
    `Delete all stored scan data for a game. This removes the manifest, tree, scripts, remotes, properties, and services files from disk. Irreversible.`,
    {
      placeId: z.number().describe("The PlaceId of the game to delete data for."),
    },
    async ({ placeId }) => {
      try {
        const data = await apiDelete(`/games/${placeId}`);
        if (!data?.ok) return text(formatError(data));
        return text(JSON.stringify(data, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );
}
