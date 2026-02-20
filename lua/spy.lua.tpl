local HttpService = game:GetService("HttpService")
local Players     = game:GetService("Players")
local StarterGui  = game:GetService("StarterGui")
local localPlayer = Players.LocalPlayer

local SERVER_URL = "http://localhost:{{PORT}}/internal"
local SECRET     = "{{SECRET}}"
local USERNAME   = localPlayer.Name

local function makeHeaders()
    local h = { ["Content-Type"] = "application/json" }
    if SECRET ~= "" then h["X-Xeno-Secret"] = SECRET end
    return h
end

local function send(payload)
    payload.username = USERNAME
    pcall(function()
        request({
            Url     = SERVER_URL,
            Method  = "POST",
            Headers = makeHeaders(),
            Body    = HttpService:JSONEncode(payload)
        })
    end)
end

local function notify(text, duration)
    pcall(function()
        StarterGui:SetCore("SendNotification", {
            Title = "xeno-mcp spy",
            Text = text,
            Duration = duration or 5,
        })
    end)
end

-- format args to a readable string, capped at 200 chars
local function formatArgs(args)
    local parts = {}
    for i, v in ipairs(args) do
        local t = typeof(v)
        if t == "string" then
            local s = string.sub(v, 1, 40)
            if #v > 40 then s = s .. "..." end
            table.insert(parts, '"' .. s .. '"')
        elseif t == "number" or t == "boolean" then
            table.insert(parts, tostring(v))
        elseif t == "Instance" then
            table.insert(parts, t .. "<" .. v.ClassName .. ">")
        elseif t == "EnumItem" then
            table.insert(parts, tostring(v))
        elseif t == "Vector3" or t == "CFrame" or t == "Color3" or t == "UDim2" then
            table.insert(parts, tostring(v))
        elseif t == "table" then
            table.insert(parts, "table")
        else
            table.insert(parts, t)
        end
    end
    local result = table.concat(parts, ", ")
    if #result > 200 then result = string.sub(result, 1, 197) .. "..." end
    return result
end

-- safeClosure: match closure type of original to avoid engine checks
local function isc(f)
    return (iscclosure and iscclosure(f)) and debug.info(f, "s") == "[C]"
end
local function newc(cl)
    return newcclosure and newcclosure(cl) or function(...) return cl(...) end
end
local function newl(cl)
    local c2 = clonefunction and clonefunction(function(...) return cl(...) end)
        or function(...) return cl(...) end
    return function(...) return c2(...) end
end
local function safeClosure(orig, hooked)
    if isc(orig) then return newc(newl(hooked)) else return newl(newc(hooked)) end
end

-- cleanup previous spy if running
if getgenv().__XENO_SPY then
    pcall(function() getgenv().__XENO_SPY.Disconnect() end)
end

-- state
local seen = {}
local subscriptions = {}
local connections = {}
local active = true

local function isSubscribed(path)
    if subscriptions[path] then return true end
    -- partial match: subscribing to "Remotes" matches "Remotes.SetAFK"
    for sub in pairs(subscriptions) do
        if string.find(path, sub, 1, true) then return true end
    end
    return false
end

local function sendSpy(direction, method, remotePath, args)
    local key = direction .. ":" .. method .. ":" .. remotePath
    local subscribed = isSubscribed(remotePath)

    if not subscribed and seen[key] then return end
    seen[key] = true

    local argStr = ""
    pcall(function() argStr = formatArgs(args) end)

    local tag = string.lower(direction)
    send({
        event   = "spy",
        level   = "info",
        message = string.format("[%s] [%s] %s(%s)", direction, method, remotePath, argStr),
        source  = "remote_spy",
        tags    = {"spy", tag}
    })
end

-- OUT hooks using dual-hook redirect pattern
local oldFire, oldInvoke, oldNamecall

local function fireServerHook(old, self, ...)
    if typeof(self) ~= "Instance" or self.ClassName ~= "RemoteEvent" then
        return old(self, ...)
    end
    local args = {...}
    pcall(function()
        sendSpy("OUT", "FireServer", self:GetFullName(), args)
    end)
    return old(self, unpack(args))
end

local function invokeServerHook(old, self, ...)
    if typeof(self) ~= "Instance" or self.ClassName ~= "RemoteFunction" then
        return old(self, ...)
    end
    local args = {...}
    pcall(function()
        sendSpy("OUT", "InvokeServer", self:GetFullName(), args)
    end)
    return old(self, unpack(args))
end

-- hookfunction on FireServer
do
    local target = Instance.new("RemoteEvent").FireServer
    local function hooked(...) return fireServerHook(oldFire, ...) end
    oldFire = hookfunction(target, safeClosure(target, hooked))
end

-- hookfunction on InvokeServer
do
    local target = Instance.new("RemoteFunction").InvokeServer
    local function hooked(...) return invokeServerHook(oldInvoke, ...) end
    oldInvoke = hookfunction(target, safeClosure(target, hooked))
end

-- __namecall redirect: routes remote calls to hookfunction'd versions
local function ncHook(...)
    local self = select(1, ...)
    if typeof(self) ~= "Instance" then
        return oldNamecall(...)
    end
    local method = getnamecallmethod()
    if method == "FireServer" and self.ClassName == "RemoteEvent" then
        return fireServerHook(oldFire, self, select(2, ...))
    elseif method == "InvokeServer" and self.ClassName == "RemoteFunction" then
        return invokeServerHook(oldInvoke, self, select(2, ...))
    end
    return oldNamecall(...)
end
oldNamecall = hookmetamethod(game, "__namecall", safeClosure(pcall, ncHook))

-- IN hooks: passive OnClientEvent listeners
local function hookRemote(remote)
    if not remote:IsA("RemoteEvent") then return end
    local path = remote:GetFullName()
    local conn = remote.OnClientEvent:Connect(function(...)
        if not active then return end
        local args = {...}
        pcall(function()
            sendSpy("IN", "OnClientEvent", path, args)
        end)
    end)
    table.insert(connections, conn)
end

for _, v in ipairs(game:GetDescendants()) do
    if v:IsA("RemoteEvent") then pcall(hookRemote, v) end
end
table.insert(connections, game.DescendantAdded:Connect(function(v)
    if v:IsA("RemoteEvent") then pcall(hookRemote, v) end
end))

-- detect player leaving
table.insert(connections, Players.PlayerRemoving:Connect(function(p)
    if p == localPlayer then
        send({ event = "spy_detached" })
        active = false
    end
end))

-- public API on getgenv()
getgenv().__XENO_SPY = {
    active = true,
    subscriptions = subscriptions,
    Subscribe = function(path)
        subscriptions[path] = true
        -- clear seen entries for this path so they start logging again
        for key in pairs(seen) do
            if string.find(key, path, 1, true) then
                seen[key] = nil
            end
        end
        print("[SPY] Subscribed: " .. path)
    end,
    Unsubscribe = function(path)
        subscriptions[path] = nil
        print("[SPY] Unsubscribed: " .. path)
    end,
    Reset = function()
        seen = {}
        print("[SPY] Reset dedup cache")
    end,
    Count = function()
        local c = 0
        for _ in pairs(seen) do c = c + 1 end
        print("[SPY] " .. c .. " unique remotes seen")
        return c
    end,
    Disconnect = function()
        active = false
        pcall(function() hookmetamethod(game, "__namecall", oldNamecall) end)
        for _, c in ipairs(connections) do
            pcall(function() c:Disconnect() end)
        end
        connections = {}
        getgenv().__XENO_SPY = nil
        print("[SPY] Disconnected")
    end
}

send({ event = "spy_attached" })
notify("Remote spy active", 4)
print("[SPY] Remote spy attached — dual-hook redirect pattern")
