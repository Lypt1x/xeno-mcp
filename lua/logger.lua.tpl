local HttpService = game:GetService("HttpService")
local LogService  = game:GetService("LogService")
local StarterGui  = game:GetService("StarterGui")
local Players     = game:GetService("Players")
local localPlayer = Players.LocalPlayer

local INTERNAL_URL = "http://localhost:{{PORT}}/internal"
local HEALTH_URL   = "http://localhost:{{PORT}}/health"
local SECRET       = "{{SECRET}}"
local USERNAME     = localPlayer.Name

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
if getgenv and getgenv().__XENO_MCP_LOGGER then
    sendEvent("already_attached")
    notify("Logger is already attached.", 4)
    return
end
if getgenv then getgenv().__XENO_MCP_LOGGER = true end

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
    notify("Failed to connect to log server. Logs will NOT be forwarded.", 8)
    warn("[xeno-mcp] Server unreachable at " .. HEALTH_URL)
    if getgenv then getgenv().__XENO_MCP_LOGGER = nil end
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
sendLog("info", "xeno-mcp logger attached", "xeno-mcp")
notify("Logger connected and forwarding output.", 5)

-- detect player leaving
Players.PlayerRemoving:Connect(function(leavingPlayer)
    if leavingPlayer == localPlayer then
        sendEvent("disconnected")
    end
end)

print("[xeno-mcp] Logger hooked — forwarding output to " .. INTERNAL_URL)
