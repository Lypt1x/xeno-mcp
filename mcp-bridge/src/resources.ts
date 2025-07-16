import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apiGet } from "./api.js";

export function registerResources(server: McpServer) {

  server.resource(
    "clients",
    "xeno://clients",
    {
      description: "Current list of Roblox clients connected to the Xeno executor, including PID, username, status, and logger state.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = await apiGet("/clients");
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to reach xeno-mcp server: ${e.message}` }),
          }],
        };
      }
    }
  );

  server.resource(
    "logs",
    "xeno://logs",
    {
      description: "Latest captured Roblox output logs (most recent 100 entries). For filtered queries, use the get_logs tool instead.",
      mimeType: "application/json",
    },
    async (uri) => {
      try {
        const data = await apiGet("/logs", { limit: "100", order: "desc" });
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(data, null, 2),
          }],
        };
      } catch (e: any) {
        return {
          contents: [{
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to reach xeno-mcp server: ${e.message}` }),
          }],
        };
      }
    }
  );
}
