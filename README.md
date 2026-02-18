<p align="center">
  <img src="assets/banner.jpg" alt="xeno-mcp banner" width="100%" />
</p>

# xeno-mcp

An MCP server that lets AI agents interact with Roblox game clients through the [Xeno](https://xeno.now) executor — or any other executor using the generic file-based adapter. Execute Lua scripts, capture game output, and manage client connections — all from your favorite AI tool.

> **What is Xeno?** — A free, keyless Roblox script executor with multi-attach support. Grab it at [xeno.now](https://xeno.now).

## How it works

Two modes:

**Xeno mode** (default) — direct API integration with the Xeno executor:
```
AI Agent ←—stdio—→ MCP Bridge (TypeScript) ←—http—→ HTTP Server (Rust) ←—http—→ Xeno ←→ Roblox
```

**Generic mode** — file-based adapter that works with any executor:
```
AI Agent ←—stdio—→ MCP Bridge (TypeScript) ←—http—→ HTTP Server (Rust) ←—file—→ Exchange Dir ←—poll—→ Loader Script (in executor) ←→ Roblox
```

Two components:

1. **HTTP server** (Rust/actix-web, port 3111) — wraps Xeno's local API, receives logs from injected Lua scripts, manages client state
2. **MCP bridge** (TypeScript, stdio) — translates MCP tool calls into HTTP requests against the server above

The bridge auto-starts the HTTP server if it isn't already running.

## Setup

### Prerequisites

- **Windows** — this project is built for Windows (the Rust server compiles to `.exe` and Xeno is Windows-only)
- [Xeno](https://xeno.now) — the Roblox executor. Download, install, and have it running before you connect.
- [Rust](https://rustup.rs) — install via `rustup`. This builds the HTTP server.
- [Node.js](https://nodejs.org) 18+ — needed for the MCP bridge. Comes with `npm`.
- [Git](https://git-scm.com) — to clone the repo.

### Build

Clone the repo and build both components:

```bash
git clone https://github.com/Lypt1x/xeno-mcp.git
cd xeno-mcp
```

**1. Build the Rust HTTP server**

This compiles the server binary to `target/release/xeno-mcp.exe`:

```bash
cargo build --release
```

> First build pulls dependencies and takes a few minutes. Subsequent builds are fast.

**2. Build the MCP bridge**

Install Node dependencies and compile the TypeScript:

```bash
cd mcp-bridge
npm install
npm run build
cd ..
```

This produces the compiled bridge in `mcp-bridge/dist/`. You don't run it directly — your MCP client (Claude, Copilot, Cursor, etc.) launches it via the config below.

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
| `get_health` | Server status, executor connectivity, which clients have the logger |
| `get_clients` | List connected Roblox clients with their PID, username, and state |
| `execute_lua` | Run a Lua script on one or more clients |
| `attach_logger` | Inject the log-forwarding script into clients (Xeno mode only) |
| `get_logs` | Query captured output with filters (level, search, time range, etc.) |
| `clear_logs` | Wipe all stored logs |
| `get_loader_script` | Get the generic loader script for non-Xeno executors (generic mode) |
| `search_scripts` | Search community scripts on ScriptBlox by keyword |
| `browse_scripts` | Browse trending, popular, or recent scripts on ScriptBlox |
| `get_script_details` | Fetch full metadata and raw source code for a ScriptBlox script |
| `execute_scriptblox_script` | Fetch a ScriptBlox script and execute it on connected clients |

The agent can also read `xeno://clients` and `xeno://logs` as MCP resources.

## HTTP API

If you want to hit the server directly (without MCP):

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server + executor status |
| `GET` | `/clients` | List Roblox clients |
| `POST` | `/execute` | Execute Lua (`{ "script": "...", "pids": ["123"] }`) |
| `POST` | `/attach-logger` | Attach log script (`{ "pids": ["123"] }`) |
| `GET` | `/loader-script` | Get the generic loader Lua script (generic mode) |
| `POST` | `/internal` | Client → server event channel (used by the Lua script) |
| `GET` | `/logs` | Query logs (supports `level`, `search`, `source`, `pid`, `page`, `limit`, `offset`, `after`, `before`, `tag`, `order`) |
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
      --mode <MODE>              Server mode: xeno or generic [default: xeno]
      --exchange-dir <DIR>       Directory for script exchange files [default: ./exchange]
```

## Generic mode

Generic mode lets you use xeno-mcp with **any executor** that supports basic file system UNC functions (`readfile`, `listfiles`, `isfile`, `delfile`, `request`, `getgenv`).

### How it works

1. Start the server in generic mode:
   ```bash
   ./target/release/xeno-mcp --mode generic --exchange-dir C:\path\to\exchange --console
   ```

2. The server creates `exchange/pending/` and `exchange/done/` subdirectories

3. Get the loader script — either via the API (`GET /loader-script`) or ask the AI agent to use the `get_loader_script` tool

4. Paste the loader script into your executor and run it. The loader:
   - Registers itself with the server
   - Polls `exchange/pending/` for new `.lua` files every 200ms
   - Executes scripts via `loadstring()` and deletes the file
   - Captures all `print`/`warn`/`error` output and sends it to the server
   - Sends heartbeats every 5 seconds
   - Automatically disconnects when the player leaves the game

5. From here, the AI agent uses `execute_lua` and `get_logs` as normal. Scripts are delivered through the exchange directory instead of direct API calls.

### Requirements for generic mode

Your executor must support these UNC functions:
- `readfile(path)` — read file contents
- `listfiles(path)` — list files in a directory
- `isfile(path)` — check if a path is a file
- `delfile(path)` — delete a file
- `request({...})` — make HTTP requests
- `getgenv()` — global environment table

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
