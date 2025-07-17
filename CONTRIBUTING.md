# Contributing to xeno-mcp

Thanks for your interest in contributing! Here's how to get started.

## Building

### Rust HTTP Server

```bash
cargo build --release
```

The binary lands in `target/release/xeno-mcp.exe`.

### MCP Bridge (TypeScript)

```bash
cd mcp-bridge
npm install
npm run build
```

## Project Layout

- `src/` — Rust HTTP server (actix-web)
- `lua/` — Lua template injected into Roblox clients
- `mcp-bridge/` — TypeScript MCP server (stdio transport)

## Making Changes

1. Fork the repo and create a branch from `master`
2. Make your changes — keep diffs small and focused
3. Test against a live Xeno + Roblox setup if touching API logic
4. Make sure both projects build without errors
5. Open a PR with a clear description of what changed and why

## Code Style

- **Rust**: Follow standard `rustfmt` conventions. No `clippy` warnings.
- **TypeScript**: Keep it simple. No unnecessary abstractions.
- **Lua**: Match the existing style in `logger.lua.tpl`.

## Reporting Bugs

Open an issue with:
- What you expected vs. what happened
- Steps to reproduce
- Your OS + Xeno version if relevant

## Adding MCP Tools

If you want to add a new tool to the MCP bridge:

1. Add the HTTP endpoint in Rust (`src/routes/`)
2. Register the route in `src/main.rs`
3. Add the MCP tool in `mcp-bridge/src/tools.ts`
4. Update the README's tool table

## Questions?

Open an issue — there's no mailing list or Discord for this project.
