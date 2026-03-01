local HttpService = game:GetService("HttpService")
local Players     = game:GetService("Players")
local StarterGui  = game:GetService("StarterGui")
local localPlayer = Players.LocalPlayer

local BASE_URL = "{{BASE_URL}}"
local SECRET   = "{{SECRET}}"
local SCOPES   = HttpService:JSONDecode('{{SCOPES}}')
local USERNAME = localPlayer.Name

local function makeHeaders()
    local h = { ["Content-Type"] = "application/json" }
    if SECRET ~= "" then h["X-Xeno-Secret"] = SECRET end
    return h
end

local function notify(text, duration)
    pcall(function()
        StarterGui:SetCore("SendNotification", {
            Title = "xeno-mcp scanner",
            Text = text,
            Duration = duration or 5,
        })
    end)
end

local function post(endpoint, body)
    local ok, err = pcall(function()
        request({
            Url     = BASE_URL .. endpoint,
            Method  = "POST",
            Headers = makeHeaders(),
            Body    = HttpService:JSONEncode(body)
        })
    end)
    if not ok then
        warn("[xeno-mcp scanner] POST " .. endpoint .. " failed: " .. tostring(err))
    end
    return ok
end

local function hasScope(name)
    for _, s in ipairs(SCOPES) do
        if s == name then return true end
    end
    return false
end

-- guard: prevent duplicate scanners
if getgenv and getgenv().__XENO_MCP_SCANNER then
    notify("Scanner is already running.", 4)
    return
end
if getgenv then getgenv().__XENO_MCP_SCANNER = true end

local startTime = tick()
notify("Scanning game...")

-- resolve game name
local gameName = "Unknown"
pcall(function()
    local MarketplaceService = game:GetService("MarketplaceService")
    local info = MarketplaceService:GetProductInfo(game.PlaceId)
    if info and info.Name then
        gameName = info.Name
    end
end)

local placeId = game.PlaceId
local creatorType = "Unknown"
pcall(function()
    creatorType = tostring(game.CreatorType)
    -- CreatorType is an enum, convert to readable string
    if creatorType == "Enum.CreatorType.User" then
        creatorType = "User"
    elseif creatorType == "Enum.CreatorType.Group" then
        creatorType = "Group"
    end
end)

-- scannable services (client-replicated only)
local scannableServices = {
    "Workspace", "ReplicatedStorage", "ReplicatedFirst",
    "StarterGui", "StarterPack", "StarterPlayer",
    "Lighting", "SoundService", "Chat", "Teams"
}

-- LocalPlayer containers worth scanning (PlayerGui has runtime GUIs, scripts, etc.)
local playerContainers = {}
pcall(function()
    local lp = game:GetService("Players").LocalPlayer
    if lp then
        for _, child in ipairs(lp:GetChildren()) do
            table.insert(playerContainers, child)
        end
    end
end)

local instanceCount = 0
local scriptCount = 0
local remoteCount = 0

-- helpers
local function getService(name)
    local ok, svc = pcall(function() return game:GetService(name) end)
    if ok then return svc end
    return nil
end

local function buildTree(instance)
    local node = {
        name = instance.Name,
        class_name = instance.ClassName,
        path = instance:GetFullName(),
        children = {}
    }
    instanceCount = instanceCount + 1
    for _, child in ipairs(instance:GetChildren()) do
        local ok, childNode = pcall(buildTree, child)
        if ok then
            table.insert(node.children, childNode)
        end
    end
    return node
end

-- phase: services
if hasScope("services") then
    pcall(function()
        local services = {}
        for _, child in ipairs(game:GetChildren()) do
            local childList = {}
            local childCount = 0
            pcall(function()
                for _, c in ipairs(child:GetChildren()) do
                    if childCount < 20 then
                        table.insert(childList, {
                            name = c.Name,
                            class_name = c.ClassName
                        })
                    end
                    childCount = childCount + 1
                end
            end)
            table.insert(services, {
                name = child.Name,
                class_name = child.ClassName,
                child_count = childCount,
                children = childList
            })
        end
        post("/scan/data", {
            place_id = placeId,
            chunk_type = "services",
            data = services
        })
    end)
end

-- phase: tree (one chunk per service)
if hasScope("tree") then
    for _, serviceName in ipairs(scannableServices) do
        pcall(function()
            local svc = getService(serviceName)
            if svc then
                local tree = buildTree(svc)
                post("/scan/data", {
                    place_id = placeId,
                    chunk_type = "tree",
                    service_name = serviceName,
                    data = { tree }
                })
            end
        end)
        task.wait(0.1) -- yield between services
    end

    -- LocalPlayer children (PlayerGui, PlayerScripts, Backpack, etc.)
    for _, container in ipairs(playerContainers) do
        pcall(function()
            local tree = buildTree(container)
            post("/scan/data", {
                place_id = placeId,
                chunk_type = "tree",
                service_name = "LocalPlayer." .. container.Name,
                data = { tree }
            })
        end)
        task.wait(0.1)
    end
end

-- phase: scripts (batched)
if hasScope("scripts") then
    pcall(function()
        local hasDecompile = type(decompile) == "function"
        local batch = {}
        local batchSize = 50

        local function flushBatch()
            if #batch > 0 then
                post("/scan/data", {
                    place_id = placeId,
                    chunk_type = "scripts",
                    data = batch
                })
                batch = {}
                task.wait(0.1)
            end
        end

        local function scanDescendants(root)
            for _, inst in ipairs(root:GetDescendants()) do
                if inst:IsA("LocalScript") or inst:IsA("ModuleScript") or inst:IsA("Script") then
                    local entry = {
                        path = inst:GetFullName(),
                        class_name = inst.ClassName,
                        decompiled = false,
                        source = ""
                    }

                    pcall(function()
                        if inst:IsA("LocalScript") then
                            entry.enabled = not inst.Disabled
                        end
                    end)

                    if hasDecompile then
                        local ok, src = pcall(decompile, inst)
                        if ok and type(src) == "string" then
                            entry.source = src
                            entry.decompiled = true
                        end
                    end

                    if entry.source == "" then
                        pcall(function()
                            local src = inst.Source
                            if src and #src > 0 then
                                entry.source = src
                            end
                        end)
                    end

                    table.insert(batch, entry)
                    scriptCount = scriptCount + 1

                    if #batch >= batchSize then
                        flushBatch()
                    end
                end
            end
        end

        for _, serviceName in ipairs(scannableServices) do
            local svc = getService(serviceName)
            if svc then scanDescendants(svc) end
        end
        for _, container in ipairs(playerContainers) do
            pcall(scanDescendants, container)
        end
        flushBatch()
    end)
end

-- phase: remotes
if hasScope("remotes") then
    pcall(function()
        local remotes = {}
        local remoteClasses = {
            "RemoteEvent", "RemoteFunction",
            "BindableEvent", "BindableFunction",
            "UnreliableRemoteEvent"
        }

        for _, serviceName in ipairs(scannableServices) do
            local svc = getService(serviceName)
            if svc then
                for _, inst in ipairs(svc:GetDescendants()) do
                    for _, cls in ipairs(remoteClasses) do
                        if inst:IsA(cls) then
                            table.insert(remotes, {
                                path = inst:GetFullName(),
                                class_name = inst.ClassName
                            })
                            remoteCount = remoteCount + 1
                            break
                        end
                    end
                end
            end
        end

        for _, container in ipairs(playerContainers) do
            pcall(function()
                for _, inst in ipairs(container:GetDescendants()) do
                    for _, cls in ipairs(remoteClasses) do
                        if inst:IsA(cls) then
                            table.insert(remotes, {
                                path = inst:GetFullName(),
                                class_name = inst.ClassName
                            })
                            remoteCount = remoteCount + 1
                            break
                        end
                    end
                end
            end)
        end

        post("/scan/data", {
            place_id = placeId,
            chunk_type = "remotes",
            data = remotes
        })
    end)
end

-- phase: properties (key properties from common instance types)
if hasScope("properties") then
    local propDefs = {
        BasePart = {"Position", "Size", "CFrame", "Material", "BrickColor", "Color", "Transparency", "Anchored", "CanCollide", "Shape"},
        Model = {"PrimaryPart"},
        Humanoid = {"Health", "MaxHealth", "WalkSpeed", "JumpPower", "JumpHeight", "HipHeight", "DisplayName"},
        Camera = {"CFrame", "FieldOfView", "CameraType"},
        Light = {"Brightness", "Color", "Range", "Shadows"},
        Sound = {"SoundId", "Volume", "Looped", "Playing", "PlaybackSpeed"},
        ParticleEmitter = {"Rate", "Lifetime", "Speed", "Texture"},
        UIComponent = {"Size", "Position", "AnchorPoint", "BackgroundColor3", "BackgroundTransparency", "Visible"},
    }

    for _, serviceName in ipairs(scannableServices) do
        pcall(function()
            local svc = getService(serviceName)
            if not svc then return end

            local batch = {}
            for _, inst in ipairs(svc:GetDescendants()) do
                for baseClass, props in pairs(propDefs) do
                    if inst:IsA(baseClass) then
                        local propValues = {}
                        for _, prop in ipairs(props) do
                            pcall(function()
                                propValues[prop] = tostring(inst[prop])
                            end)
                        end
                        if next(propValues) then
                            table.insert(batch, {
                                path = inst:GetFullName(),
                                class_name = inst.ClassName,
                                properties = propValues
                            })
                        end
                        break
                    end
                end
            end

            if #batch > 0 then
                post("/scan/data", {
                    place_id = placeId,
                    chunk_type = "properties",
                    service_name = serviceName,
                    data = batch
                })
            end
        end)
        task.wait(0.1)
    end

    -- LocalPlayer containers
    for _, container in ipairs(playerContainers) do
        pcall(function()
            local batch = {}
            for _, inst in ipairs(container:GetDescendants()) do
                for baseClass, props in pairs(propDefs) do
                    if inst:IsA(baseClass) then
                        local propValues = {}
                        for _, prop in ipairs(props) do
                            pcall(function()
                                propValues[prop] = tostring(inst[prop])
                            end)
                        end
                        if next(propValues) then
                            table.insert(batch, {
                                path = inst:GetFullName(),
                                class_name = inst.ClassName,
                                properties = propValues
                            })
                        end
                        break
                    end
                end
            end
            if #batch > 0 then
                post("/scan/data", {
                    place_id = placeId,
                    chunk_type = "properties",
                    service_name = "LocalPlayer." .. container.Name,
                    data = batch
                })
            end
        end)
    end
end

-- completion
local duration = tick() - startTime
local hasDecompile = type(decompile) == "function"

post("/scan/complete", {
    place_id = placeId,
    game_id = game.GameId,
    place_version = game.PlaceVersion,
    place_name = gameName,
    creator_id = game.CreatorId,
    creator_type = creatorType,
    job_id = game.JobId,
    scopes = SCOPES,
    scan_duration_secs = duration,
    instance_count = instanceCount,
    script_count = scriptCount,
    remote_count = remoteCount,
    executor_supports_decompile = hasDecompile,
})

notify(string.format("Scan complete! %d instances, %d scripts in %.1fs", instanceCount, scriptCount, duration), 6)

-- cleanup
if getgenv then getgenv().__XENO_MCP_SCANNER = nil end
