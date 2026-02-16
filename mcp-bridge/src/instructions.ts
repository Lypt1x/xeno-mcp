export const INSTRUCTIONS = `You are connected to a Roblox game client executor (Xeno) through this MCP server.
This bridge communicates with an HTTP API that wraps the Xeno executor's local API to manage Roblox client interactions.

PREREQUISITES:
- The xeno-mcp HTTP server must be running (default: localhost:3111)
- The Xeno executor must be open and injected into a Roblox client
- Clients must show status "Attached" (status 3) before you can execute scripts

EXECUTION MODEL:
- Scripts run CLIENT-SIDE ONLY inside the Roblox LocalPlayer context
- You have access to all client-side services: Players, Workspace, ReplicatedStorage, Lighting, UserInputService, etc.
- You do NOT have server-side access: ServerScriptService, ServerStorage, etc. will be nil or inaccessible
- The executor provides a custom request() function for HTTP calls — do NOT use HttpService:RequestAsync

MEMORY & STATE — THIS IS CRITICAL:
- Each script execution is FIRE-AND-FORGET. Once your script finishes, all local variables are gone
- To persist state between separate script executions, use getgenv():
    getgenv().__myTool_counter = 0           -- store a value
    local c = getgenv().__myTool_counter     -- retrieve it in a later execution
- getgenv() is a GLOBAL table shared across ALL script executions in the same client
- Use unique prefixed keys (e.g., getgenv().__agentName_variableName) to avoid collisions
- If you don't store something in getgenv(), it is PERMANENTLY LOST after that script execution ends

EVENT HANDLING — MEMORY LEAK PREVENTION:
- You CAN connect to Roblox events (e.g., game.Workspace.ChildAdded:Connect(function(child) ... end))
- WARNING: Event connections persist even after your script execution ends! They are NOT garbage collected
- You MUST store every connection in getgenv() so it can be disconnected later:
    -- Creating an event listener:
    if getgenv().__myListener then getgenv().__myListener:Disconnect() end
    getgenv().__myListener = game.Workspace.ChildAdded:Connect(function(child)
        -- handle event
    end)
    -- Cleaning up later:
    if getgenv().__myListener then getgenv().__myListener:Disconnect(); getgenv().__myListener = nil end
- NEVER create event connections without storing them — this causes memory leaks
- Leaking event connections = memory leak + unintended behavior accumulating over time

COMMON ANTI-PATTERNS (will cause problems):
- Creating event connections without storing a reference → memory leak, cannot clean up
- Running infinite loops (while true do ... end) without a break condition or stored reference to cancel
- Assuming you can read output from a previously executed script → you cannot, use getgenv()
- Calling server-side APIs (ServerScriptService, etc.) → will error or return nil
- Using HttpService:RequestAsync → use the executor's request() function instead
- Spawning threads (task.spawn/coroutine) without tracking them in getgenv()

SAFE PATTERNS:
- Always check if something exists in getgenv() before creating it (idempotent scripts)
- Store ALL persistent state in getgenv() with unique prefixed keys
- Store ALL event connections in getgenv() and always disconnect before reconnecting
- Use pcall() to wrap code that might error — you cannot catch errors any other way
- Always provide a cleanup path for anything persistent you create
- Use task.delay() or task.wait() instead of wait() for modern timing

AVAILABLE GLOBALS (Xeno executor):
- game — the DataModel root
- game.Players.LocalPlayer — the current player executing the script
- game:GetService("ServiceName") — access any client-visible service
- getgenv() — global environment table persisting across script executions
- getrenv() — Roblox's own environment (read-only, for inspection)
- request({Url=..., Method=..., Headers=..., Body=...}) — HTTP requests from the client
- setclipboard(text) — copy text to clipboard
- getconnections(signal) — inspect event connections
- hookfunction, hookmetamethod — advanced function hooking

LOGGER:
- You can attach a log-forwarding script to clients using attach_logger
- Once attached, all Roblox output (print, warn, error) is captured and forwarded to the server
- Use get_logs to query captured logs with filters (level, source, search, tags, pid, time range)
- The logger also sends in-game notifications to confirm attachment status

LOG LEVELS:
- "info" — internal events (logger attached/detached, system messages)
- "output" — standard Roblox print() output
- "warn" — Roblox warn() output
- "error" — Roblox error() output
- "script" — every executed script is automatically logged with this level; use level="script" to see executed scripts

SCRIPT LOGGING:
- Every script executed via execute_lua is automatically stored as a log entry with level "script"
- This lets you review what scripts were run, when, and on which clients
- Filter with level="script" in get_logs to see only executed scripts

PAGINATION:
- get_logs returns 50 logs per page by default (max 1000)
- Use the "page" parameter (1-indexed) for easy page navigation: page=1 is the first page, page=2 is the second, etc.
- The response includes: total (total matching logs), page (current page), per_page (items per page), total_pages, has_more (boolean)
- Always check "has_more" to know if more pages exist; use "total_pages" to know the last page
- You can also use "offset" for manual offset-based pagination instead of "page"

WORKFLOW TIPS:
1. Start by calling get_clients to see available Roblox clients and their status
2. Attach the logger if you want to capture output: attach_logger with the PID(s)
3. Execute Lua scripts with execute_lua — always validate results via get_logs or getgenv()
4. Use get_health for an overview of server state, Xeno connection, and logger tracking
`;
