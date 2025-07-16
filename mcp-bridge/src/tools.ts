import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apiGet, apiPost, apiDelete } from "./api.js";

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

function formatError(data: any): string {
  if (data?.error) {
    const err = String(data.error);
    if (err.includes("Cannot reach Xeno") || err.includes("localhost:3110")) {
      return `The Xeno executor is not reachable. Please ask the user to:\n1. Make sure the Xeno executor application is open\n2. Make sure Xeno is injected into a Roblox client\n\nDo NOT retry automatically — this requires the user to take action.\n\nOriginal error: ${err}`;
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
    "Get the health status of the xeno-mcp server, Xeno executor connection, connected Roblox clients, and logger attachment state. Call this first to verify everything is operational.",
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
    `List all Roblox clients currently connected to the Xeno executor.
Returns each client as "Username(PID)" with their status and logger state.
Use these identifiers for execute_lua and attach_logger — you can pass the full "Username(PID)" format, just the username, or just the PID.

IMPORTANT: Before executing scripts or reading logs, check if the logger is attached. If not, ask the user whether to attach it.`,
    {},
    async () => {
      try {
        const clients = await fetchClients();
        if (clients.length === 0) {
          const data = await apiGet("/clients");
          if (!data?.ok) return text(formatError(data));
          return text("No Roblox clients are connected to Xeno.");
        }

        const summary = clients.map(c => ({
          client: c.label,
          status: c.status_text,
          logger_attached: c.logger_attached,
        }));
        return text(JSON.stringify({ ok: true, clients: summary }, null, 2));
      } catch (e: any) {
        return text(formatCatchError(e));
      }
    }
  );

  server.tool(
    "execute_lua",
    `Execute a Lua script on one or more Roblox clients.

IMPORTANT REQUIREMENTS:
- The client must be "Attached" (status 3) — meaning Xeno is injected and the player is in a game
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
    `Query captured Roblox output logs with optional filters. Returns logs from clients that have the logger attached. Logs include the message, level (info/warn/error), source, PID, username, timestamp, and tags.

IMPORTANT: Before calling this tool, ensure the logger is attached to the target client(s). If no logger is attached, you will get no logs. Ask the user whether to attach the logger first.

Results are paginated (default limit: 100, max: 1000) and sorted newest-first by default.`,
    {
      level: z.string().optional().describe("Filter by log level: 'info', 'warn', or 'error'"),
      source: z.string().optional().describe("Filter by source (substring match)"),
      search: z.string().optional().describe("Search log messages (substring match, case-insensitive)"),
      tag: z.string().optional().describe("Filter by tags (comma-separated)"),
      pid: z.string().optional().describe("Filter by client PID"),
      limit: z.number().optional().describe("Max results to return (default: 100, max: 1000)"),
      offset: z.number().optional().describe("Skip this many results (for pagination)"),
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
            hints.push("No Roblox clients are connected to Xeno.");
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
}
