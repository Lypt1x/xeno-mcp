#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { INSTRUCTIONS } from "./instructions.js";

const BASE_URL = process.env.XENO_MCP_URL || "http://localhost:3111";

// Try to reach the HTTP server; if it's not running, start it automatically
async function ensureHttpServer(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.ok) return; // already running
  } catch {
    // not running — start it
  }

  const bridgeDir = dirname(fileURLToPath(import.meta.url));
  // Binary lives at xeno-mcp/target/release/xeno-mcp.exe relative to mcp-bridge/dist/
  const exe = resolve(bridgeDir, "..", "..", "target", "release", "xeno-mcp.exe");

  const args = ["--console"];
  const secret = process.env.XENO_MCP_SECRET;
  if (secret) args.push("--secret", secret);

  const mode = process.env.XENO_MCP_MODE;
  if (mode) args.push("--mode", mode);

  // For generic mode, user only needs to provide XENO_MCP_WORKSPACE (the executor's workspace folder).
  // The bridge derives exchange-dir (OS path) and executor-exchange-dir (executor-relative path) from it.
  const workspace = process.env.XENO_MCP_WORKSPACE;
  if (workspace) {
    args.push("--exchange-dir", resolve(workspace, "exchange"));
    args.push("--executor-exchange-dir", "exchange");
  }

  // Advanced: override derived paths if needed
  const exchangeDir = process.env.XENO_MCP_EXCHANGE_DIR;
  if (exchangeDir) args.push("--exchange-dir", exchangeDir);

  const executorExchangeDir = process.env.XENO_MCP_EXECUTOR_EXCHANGE_DIR;
  if (executorExchangeDir) args.push("--executor-exchange-dir", executorExchangeDir);

  const child = spawn(exe, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  // Wait for it to become ready (up to 5s)
  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) return;
    } catch { /* not ready yet */ }
  }
  // If it still didn't start, continue anyway — tools will show connection errors
}

await ensureHttpServer();

const server = new McpServer({
  name: "xeno-mcp",
  version: "1.0.0",
}, {
  instructions: INSTRUCTIONS,
});

registerTools(server);
registerResources(server);

const transport = new StdioServerTransport();
await server.connect(transport);
