<p align="center">
  <img src="assets/banner.jpg" alt="xeno-mcp banner" width="100%" />
</p>

# xeno-mcp

An MCP server that lets AI agents interact with Roblox game clients through the [Xeno](https://xeno.now) executor. Execute Lua scripts, capture game output, and manage client connections — all from your favorite AI tool.

> **What is Xeno?** — A free, keyless Roblox script executor with multi-attach support. Grab it at [xeno.now](https://xeno.now).

## How it works

```
AI Agent ←—stdio—→ MCP Bridge (TypeScript) ←—http—→ HTTP Server (Rust) ←—http—→ Xeno ←→ Roblox
```

Two components:

1. **HTTP server** (Rust/actix-web, port 3111) — wraps Xeno's local API, receives logs from injected Lua scripts, manages client state
2. **MCP bridge** (TypeScript, stdio) — translates MCP tool calls into HTTP requests against the server above

The bridge auto-starts the HTTP server if it isn't already running.

## Setup

### Prerequisites

- [Xeno](https://xeno.now) — download and install the executor. It must be running before your AI agent can connect.
- [Rust](https://rustup.rs) toolchain (for building the HTTP server)
- [Node.js](https://nodejs.org) 18+ (for the MCP bridge)

### Build

```bash
# rust server
cargo build --release

# mcp bridge
cd mcp-bridge
npm install
npm run build
cd ..
```

### Connect your AI agent

Add this to your agent's MCP config. The path should point to wherever you cloned this repo.

**Claude Desktop** — `%APPDATA%\Claude\claude_desktop_config.json`
```json
{
  "mcpServers": {
    "xeno-mcp": {
      "command": "npx",
      "args": ["-y", "/path/to/xeno-mcp/mcp-bridge"]
    }
  }
}
```

**VS Code / GitHub Copilot** — `.vscode/mcp.json` or `settings.json`
```json
{
  "mcp": {
    "servers": {
      "xeno-mcp": {
        "command": "npx",
        "args": ["-y", "/path/to/xeno-mcp/mcp-bridge"]
      }
    }
  }
}
```

**Cursor** — `~/.cursor/mcp.json`
```json
{
  "mcpServers": {
    "xeno-mcp": {
      "command": "npx",
      "args": ["-y", "/path/to/xeno-mcp/mcp-bridge"]
    }
  }
}
```

If you're using `--secret` on the HTTP server, pass it through:
```json
{
  "mcpServers": {
    "xeno-mcp": {
      "command": "npx",
      "args": ["-y", "/path/to/xeno-mcp/mcp-bridge"],
      "env": { "XENO_MCP_SECRET": "your-secret" }
    }
  }
}
```

### Run

1. Open Xeno and inject into a Roblox client
2. Start your AI agent — the MCP bridge handles the rest

That's it. The bridge spawns the HTTP server automatically. If you want to run the server manually (e.g. to see console output), you can:

```bash
./target/release/xeno-mcp --console
```

## Tools

The MCP server exposes these tools to the AI agent:

| Tool | What it does |
|------|-------------|
| `get_health` | Server status, Xeno connectivity, which clients have the logger |
| `get_clients` | List connected Roblox clients with their PID, username, and state |
| `execute_lua` | Run a Lua script on one or more clients |
| `attach_logger` | Inject the log-forwarding script into clients |
| `get_logs` | Query captured output with filters (level, search, time range, etc.) |
| `clear_logs` | Wipe all stored logs |

The agent can also read `xeno://clients` and `xeno://logs` as MCP resources.

## HTTP API

If you want to hit the server directly (without MCP):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server + Xeno status |
| `GET` | `/clients` | List Roblox clients |
| `POST` | `/execute` | Execute Lua (`{ "script": "...", "pids": ["123"] }`) |
| `POST` | `/attach-logger` | Attach log script (`{ "pids": ["123"] }`) |
| `POST` | `/internal` | Client → server event channel (used by the Lua script) |
| `GET` | `/logs` | Query logs (supports `level`, `search`, `source`, `pid`, `limit`, `offset`, `after`, `before`, `tag`, `order`) |
| `DELETE` | `/logs` | Clear logs |

All mutating endpoints respect the `X-Xeno-Secret` header when `--secret` is set.

## How the logger works

When you call `attach_logger`, a Lua script gets injected into the Roblox client that:
- Hooks into `LogService.MessageOut` to capture all `print`/`warn`/`error` output
- Forwards everything to the HTTP server via `POST /internal`
- Shows an in-game notification confirming the connection
- Notifies the server when the player leaves a game
- Uses `getgenv().__XENO_MCP_LOGGER` to prevent double-injection

## Server flags

```
xeno-mcp [OPTIONS]

Options:
  -p, --port <PORT>              Port to listen on [default: 3111]
  -b, --bind <ADDR>              Bind address [default: 127.0.0.1]
      --console                  Print incoming logs to stdout
      --log-file <PATH>          Append logs to a file
      --secret <SECRET>          Require X-Xeno-Secret header on POST/DELETE
      --max-entries <N>          Max log entries in memory [default: 10000]
      --xeno-url <URL>           Xeno API URL [default: http://localhost:3110]
```

## Testing the MCP server

```bash
npx @modelcontextprotocol/inspector npx -y ./mcp-bridge
```

Opens a web UI where you can invoke tools and read resources interactively.

## Environment variables (MCP bridge)

| Variable | Default | Description |
|----------|---------|-------------|
| `XENO_MCP_URL` | `http://localhost:3111` | Where the HTTP server is |
| `XENO_MCP_SECRET` | — | Shared secret (if the server uses `--secret`) |
