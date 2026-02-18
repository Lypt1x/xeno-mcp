local HttpService = game:GetService("HttpService")
local LogService  = game:GetService("LogService")
local StarterGui  = game:GetService("StarterGui")
local Players     = game:GetService("Players")
local localPlayer = Players.LocalPlayer

local SERVER_URL    = "http://localhost:{{PORT}}"
local INTERNAL_URL  = SERVER_URL .. "/internal"
local HEALTH_URL    = SERVER_URL .. "/health"
local SECRET        = "{{SECRET}}"
local EXCHANGE_DIR  = "{{EXCHANGE_DIR}}"
local PENDING_DIR   = EXCHANGE_DIR .. "/pending"
local DONE_DIR      = EXCHANGE_DIR .. "/done"
local USERNAME      = localPlayer.Name
local POLL_INTERVAL = 0.2
local HEARTBEAT_INTERVAL = 5

local function makeHeaders()
    local h = { ["Content-Type"] = "application/json" }
    if SECRET ~= "" then h["X-Xeno-Secret"] = SECRET end
    return h
end

local function notify(text, duration)
    pcall(function()
        StarterGui:SetCore("SendNotification", {
            Title = "xeno-mcp",
            Text = text,
            Duration = duration or 5,
        })
    end)
end

local function send(payload)
    payload.username = USERNAME
    pcall(function()
        request({
            Url     = INTERNAL_URL,
            Method  = "POST",
            Headers = makeHeaders(),
            Body    = HttpService:JSONEncode(payload)
        })
    end)
end

local function sendEvent(event)
    send({ event = event })
end

local function sendLog(level, message, source)
    send({
        event   = "log",
        level   = level,
        message = message,
        source  = source or "roblox",
        tags    = {"auto"}
    })
end

-- guard: already injected
if getgenv and getgenv().__XENO_MCP_GENERIC_LOADER then
    sendEvent("already_attached")
    notify("Loader is already running.", 4)
    return
end
if getgenv then getgenv().__XENO_MCP_GENERIC_LOADER = true end

-- check server connectivity
local serverOk = false
pcall(function()
    local resp = request({
        Url = HEALTH_URL, Method = "GET",
        Headers = { ["Content-Type"] = "application/json" }
    })
    if resp and resp.StatusCode == 200 then serverOk = true end
end)

if not serverOk then
    notify("Failed to connect to xeno-mcp server.", 8)
    warn("[xeno-mcp] Server unreachable at " .. HEALTH_URL)
    if getgenv then getgenv().__XENO_MCP_GENERIC_LOADER = nil end
    return
end

-- check required UNC functions
local missing = {}
for _, fn in ipairs({"readfile", "listfiles", "isfile", "delfile"}) do
    if not getgenv()[fn] then
        table.insert(missing, fn)
    end
end
if #missing > 0 then
    local msg = "Missing UNC functions: " .. table.concat(missing, ", ")
    notify(msg, 8)
    warn("[xeno-mcp] " .. msg)
    if getgenv then getgenv().__XENO_MCP_GENERIC_LOADER = nil end
    return
end

-- hook log output
LogService.MessageOut:Connect(function(message, messageType)
    local level = "output"
    if messageType == Enum.MessageType.MessageWarning then
        level = "warn"
    elseif messageType == Enum.MessageType.MessageError then
        level = "error"
    elseif messageType == Enum.MessageType.MessageInfo then
        level = "info"
    end
    sendLog(level, message)
end)

-- tell server we're attached
sendEvent("attached")
sendLog("info", "xeno-mcp generic loader active", "xeno-mcp")
notify("Loader connected — polling for scripts.", 5)
print("[xeno-mcp] Generic loader active — polling " .. PENDING_DIR)

-- detect player leaving
Players.PlayerRemoving:Connect(function(leavingPlayer)
    if leavingPlayer == localPlayer then
        sendEvent("disconnected")
    end
end)

-- heartbeat loop
task.spawn(function()
    while getgenv().__XENO_MCP_GENERIC_LOADER do
        sendEvent("heartbeat")
        task.wait(HEARTBEAT_INTERVAL)
    end
end)

-- script polling loop
while getgenv().__XENO_MCP_GENERIC_LOADER do
    local ok, files = pcall(listfiles, PENDING_DIR)
    if ok and files then
        for _, filePath in ipairs(files) do
            if string.sub(filePath, -4) == ".lua" then
                local readOk, script = pcall(readfile, filePath)
                if readOk and script then
                    -- delete before executing to avoid re-execution
                    pcall(delfile, filePath)

                    -- log the script execution
                    sendLog("info", "Executing script: " .. filePath, "loader")

                    -- execute
                    local fn, compileErr = loadstring(script)
                    if fn then
                        local execOk, execErr = pcall(fn)
                        if not execOk then
                            sendLog("error", "Script error: " .. tostring(execErr), "loader")
                        end
                    else
                        sendLog("error", "Compile error: " .. tostring(compileErr), "loader")
                    end
                end
            end
        end
    end
    task.wait(POLL_INTERVAL)
end
