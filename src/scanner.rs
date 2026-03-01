use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

// ── Data models ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GameManifest {
    pub place_id: u64,
    pub game_id: u64,
    pub place_version: u64,
    pub place_name: String,
    pub creator_id: u64,
    pub creator_type: String,
    pub job_id: String,
    pub tree_hash: String,
    pub scanned_at: DateTime<Utc>,
    pub scan_duration_secs: f64,
    pub scopes: Vec<String>,
    pub instance_count: u64,
    pub script_count: u64,
    pub remote_count: u64,
    pub executor_supports_decompile: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstanceNode {
    pub name: String,
    pub class_name: String,
    pub path: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<InstanceNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptOutline {
    pub functions: Vec<String>,
    pub requires: Vec<String>,
    pub services: Vec<String>,
    pub remote_accesses: Vec<String>,
    pub instance_refs: Vec<String>,
    pub string_constants: Vec<String>,
    pub top_level_vars: Vec<String>,
    pub line_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptEntry {
    pub path: String,
    pub class_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outline: Option<ScriptOutline>,
    pub decompiled: bool,
    pub line_count: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScriptFull {
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteEntry {
    pub path: String,
    pub class_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceEntry {
    pub name: String,
    pub class_name: String,
    pub child_count: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<ServiceChild>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceChild {
    pub name: String,
    pub class_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyEntry {
    pub path: String,
    pub class_name: String,
    pub properties: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
pub struct ScanChunk {
    pub place_id: u64,
    pub chunk_type: String,
    #[serde(default)]
    pub chunk_index: Option<u32>,
    #[serde(default)]
    pub service_name: Option<String>,
    pub data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct ScanCompleteRequest {
    pub place_id: u64,
    pub game_id: u64,
    pub place_version: u64,
    pub place_name: String,
    pub creator_id: u64,
    pub creator_type: String,
    pub job_id: String,
    pub scopes: Vec<String>,
    pub scan_duration_secs: f64,
    pub instance_count: u64,
    pub script_count: u64,
    pub remote_count: u64,
    pub executor_supports_decompile: bool,
}

#[derive(Debug, Deserialize)]
pub struct GameQuery {
    pub path: Option<String>,
    pub search: Option<String>,
    pub class: Option<String>,
    pub include_source: Option<bool>,
    pub max_depth: Option<u32>,
}

// ── File I/O helpers ─────────────────────────────────────────────────────

fn place_dir(storage_dir: &Path, place_id: u64) -> PathBuf {
    storage_dir.join("places").join(place_id.to_string())
}

pub fn save_chunk(storage_dir: &Path, place_id: u64, filename: &str, data: &serde_json::Value) -> Result<(), String> {
    let dir = place_dir(storage_dir, place_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create storage directory: {}", e))?;
    let path = dir.join(filename);
    let json = serde_json::to_string_pretty(data).map_err(|e| format!("Failed to serialize: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

pub fn append_to_array(storage_dir: &Path, place_id: u64, filename: &str, items: &serde_json::Value) -> Result<(), String> {
    let dir = place_dir(storage_dir, place_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create storage directory: {}", e))?;
    let path = dir.join(filename);

    let mut existing: Vec<serde_json::Value> = if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        Vec::new()
    };

    match items {
        serde_json::Value::Array(arr) => existing.extend(arr.iter().cloned()),
        other => existing.push(other.clone()),
    }

    let json = serde_json::to_string_pretty(&existing).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(&path, json).map_err(|e| format!("Failed to write {}: {}", path.display(), e))
}

pub fn load_file(storage_dir: &Path, place_id: u64, filename: &str) -> Result<serde_json::Value, String> {
    let path = place_dir(storage_dir, place_id).join(filename);
    if !path.exists() {
        return Err(format!("{} not found for place {}", filename, place_id));
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    serde_json::from_str(&content).map_err(|e| format!("Failed to parse {}: {}", path.display(), e))
}

pub fn list_games(storage_dir: &Path) -> Result<Vec<GameManifest>, String> {
    let places_dir = storage_dir.join("places");
    if !places_dir.exists() {
        return Ok(Vec::new());
    }

    let mut manifests = Vec::new();
    let entries = fs::read_dir(&places_dir).map_err(|e| format!("Failed to read storage directory: {}", e))?;

    for entry in entries.flatten() {
        let manifest_path = entry.path().join("manifest.json");
        if manifest_path.exists() {
            if let Ok(content) = fs::read_to_string(&manifest_path) {
                if let Ok(manifest) = serde_json::from_str::<GameManifest>(&content) {
                    manifests.push(manifest);
                }
            }
        }
    }

    manifests.sort_by(|a, b| b.scanned_at.cmp(&a.scanned_at));
    Ok(manifests)
}

pub fn game_exists(storage_dir: &Path, place_id: u64) -> bool {
    place_dir(storage_dir, place_id).join("manifest.json").exists()
}

pub fn delete_game(storage_dir: &Path, place_id: u64) -> Result<(), String> {
    let dir = place_dir(storage_dir, place_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Failed to delete game data: {}", e))
    } else {
        Ok(())
    }
}

pub fn clear_place_scope(storage_dir: &Path, place_id: u64, filename: &str) -> Result<(), String> {
    let path = place_dir(storage_dir, place_id).join(filename);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to remove {}: {}", path.display(), e))?;
    }
    Ok(())
}

// ── Tree hash ────────────────────────────────────────────────────────────

pub fn compute_tree_hash(tree: &serde_json::Value) -> String {
    let mut entries: Vec<String> = Vec::new();
    collect_hash_entries(tree, &mut entries);
    entries.sort();

    let mut hasher = Sha256::new();
    for entry in &entries {
        hasher.update(entry.as_bytes());
        hasher.update(b"\n");
    }
    format!("{:x}", hasher.finalize())
}

fn collect_hash_entries(node: &serde_json::Value, out: &mut Vec<String>) {
    match node {
        serde_json::Value::Array(arr) => {
            for item in arr {
                collect_hash_entries(item, out);
            }
        }
        serde_json::Value::Object(obj) => {
            let class = obj.get("class_name").and_then(|v| v.as_str()).unwrap_or("");
            let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let path = obj.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if !path.is_empty() {
                out.push(format!("{}:{}:{}", class, name, path));
            }
            if let Some(children) = obj.get("children") {
                collect_hash_entries(children, out);
            }
        }
        _ => {}
    }
}

// ── Write manifest ──────────────────────────────────────────────────────

pub fn write_manifest(storage_dir: &Path, req: &ScanCompleteRequest) -> Result<GameManifest, String> {
    let tree_data = load_file(storage_dir, req.place_id, "tree.json").unwrap_or(serde_json::json!([]));
    let tree_hash = compute_tree_hash(&tree_data);

    let manifest = GameManifest {
        place_id: req.place_id,
        game_id: req.game_id,
        place_version: req.place_version,
        place_name: req.place_name.clone(),
        creator_id: req.creator_id,
        creator_type: req.creator_type.clone(),
        job_id: req.job_id.clone(),
        tree_hash,
        scanned_at: Utc::now(),
        scan_duration_secs: req.scan_duration_secs,
        scopes: req.scopes.clone(),
        instance_count: req.instance_count,
        script_count: req.script_count,
        remote_count: req.remote_count,
        executor_supports_decompile: req.executor_supports_decompile,
    };

    let dir = place_dir(storage_dir, req.place_id);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create directory: {}", e))?;
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| format!("Serialize error: {}", e))?;
    fs::write(dir.join("manifest.json"), json).map_err(|e| format!("Failed to write manifest: {}", e))?;

    Ok(manifest)
}

// ── Outline generation ──────────────────────────────────────────────────

pub fn generate_outline(source: &str) -> ScriptOutline {
    let lines: Vec<&str> = source.lines().collect();
    let line_count = lines.len() as u64;

    let fn_re = Regex::new(r"(?m)(?:local\s+)?function\s+([\w.:]+)\s*\(([^)]*)\)").unwrap();
    let require_re = Regex::new(r#"require\(([^)]+)\)"#).unwrap();
    let service_re = Regex::new(r#"game:GetService\(\s*["']([^"']+)["']\s*\)"#).unwrap();
    let remote_re = Regex::new(r#"[:.](FireServer|InvokeServer|OnClientEvent|OnServerEvent|FireClient|OnClientInvoke)\s*\("#).unwrap();
    let instance_ref_re = Regex::new(r#"(?:FindFirstChild|WaitForChild|FindFirstChildOfClass|FindFirstChildWhichIsA)\(\s*["']([^"']+)["']"#).unwrap();
    let string_re = Regex::new(r#"["']([^"']{2,60})["']"#).unwrap();
    let var_re = Regex::new(r"(?m)^local\s+(\w+)\s*=").unwrap();

    let mut functions = Vec::new();
    for cap in fn_re.captures_iter(source) {
        let name = cap.get(1).map_or("", |m| m.as_str());
        let params = cap.get(2).map_or("", |m| m.as_str()).trim();
        functions.push(format!("{}({})", name, params));
    }

    let mut requires: Vec<String> = Vec::new();
    for cap in require_re.captures_iter(source) {
        let arg = cap.get(1).map_or("", |m| m.as_str()).trim().to_string();
        if !requires.contains(&arg) {
            requires.push(arg);
        }
    }

    let mut services: Vec<String> = Vec::new();
    for cap in service_re.captures_iter(source) {
        let svc = cap.get(1).map_or("", |m| m.as_str()).to_string();
        if !services.contains(&svc) {
            services.push(svc);
        }
    }

    let mut remote_accesses: Vec<String> = Vec::new();
    for cap in remote_re.captures_iter(source) {
        let method = cap.get(1).map_or("", |m| m.as_str());
        // grab some path context before the match
        let start = cap.get(0).unwrap().start();
        let line = lines.iter().find(|l| {
            let offset = source.as_ptr() as usize;
            let line_start = l.as_ptr() as usize - offset;
            let line_end = line_start + l.len();
            start >= line_start && start < line_end
        }).unwrap_or(&"");
        let trimmed = line.trim();
        if trimmed.len() <= 120 {
            if !remote_accesses.contains(&trimmed.to_string()) {
                remote_accesses.push(trimmed.to_string());
            }
        } else if !remote_accesses.contains(&method.to_string()) {
            remote_accesses.push(method.to_string());
        }
    }

    let mut instance_refs: Vec<String> = Vec::new();
    for cap in instance_ref_re.captures_iter(source) {
        let name = cap.get(1).map_or("", |m| m.as_str()).to_string();
        if !instance_refs.contains(&name) {
            instance_refs.push(name);
        }
    }

    // collect string constants, skip common noise
    let mut string_constants: Vec<String> = Vec::new();
    let noise: HashSet<&str> = [
        "Frame", "TextLabel", "TextButton", "ImageLabel", "ImageButton",
        "ScreenGui", "ScrollingFrame", "UIListLayout", "UICorner",
        "UIPadding", "UIStroke", "UIGridLayout", "UIAspectRatioConstraint",
        "Color3", "Vector3", "CFrame", "UDim2", "UDim",
        "rbxassetid://", "Content-Type", "application/json",
    ].iter().copied().collect();
    for cap in string_re.captures_iter(source) {
        let val = cap.get(1).map_or("", |m| m.as_str()).to_string();
        if !noise.contains(val.as_str())
            && !services.contains(&val)
            && !string_constants.contains(&val)
            && string_constants.len() < 50
        {
            string_constants.push(val);
        }
    }

    let mut top_level_vars: Vec<String> = Vec::new();
    for cap in var_re.captures_iter(source) {
        let var = cap.get(1).map_or("", |m| m.as_str()).to_string();
        // skip common noise
        if var.len() > 1 && var != "v" && var != "i" && var != "k" {
            if !top_level_vars.contains(&var) && top_level_vars.len() < 20 {
                top_level_vars.push(var);
            }
        }
    }

    ScriptOutline {
        functions,
        requires,
        services,
        remote_accesses,
        instance_refs,
        string_constants,
        top_level_vars,
        line_count,
    }
}

// ── Process incoming script chunks ──────────────────────────────────────

/// Process a scripts chunk: split into outlines (scripts.json) and full sources (scripts_full.json)
pub fn process_script_chunk(storage_dir: &Path, place_id: u64, data: &serde_json::Value) -> Result<(), String> {
    let scripts = data.as_array().ok_or("scripts data must be an array")?;

    let mut outlines: Vec<serde_json::Value> = Vec::new();
    let mut full_sources: Vec<serde_json::Value> = Vec::new();

    for script in scripts {
        let path = script.get("path").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let class_name = script.get("class_name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let enabled = script.get("enabled").and_then(|v| v.as_bool());
        let source = script.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let decompiled = script.get("decompiled").and_then(|v| v.as_bool()).unwrap_or(false);

        let line_count = source.lines().count() as u64;
        let size = source.len() as u64;

        let outline = if !source.is_empty() {
            Some(generate_outline(source))
        } else {
            None
        };

        let entry = ScriptEntry {
            path: path.clone(),
            class_name: class_name.clone(),
            enabled,
            outline,
            decompiled,
            line_count,
            size,
        };

        outlines.push(serde_json::to_value(&entry).map_err(|e| e.to_string())?);

        if !source.is_empty() {
            let full = ScriptFull {
                path,
                source: source.to_string(),
            };
            full_sources.push(serde_json::to_value(&full).map_err(|e| e.to_string())?);
        }
    }

    let outlines_val = serde_json::Value::Array(outlines);
    let full_val = serde_json::Value::Array(full_sources);

    append_to_array(storage_dir, place_id, "scripts.json", &outlines_val)?;
    append_to_array(storage_dir, place_id, "scripts_full.json", &full_val)?;

    Ok(())
}

// ── Query helpers ────────────────────────────────────────────────────────

pub fn filter_tree(tree: &serde_json::Value, query: &GameQuery) -> serde_json::Value {
    let items = match tree {
        serde_json::Value::Array(arr) => arr.clone(),
        _ => return tree.clone(),
    };

    let filtered: Vec<serde_json::Value> = items.into_iter().filter(|node| {
        let path = node.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let class = node.get("class_name").and_then(|v| v.as_str()).unwrap_or("");
        let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("");

        if let Some(ref prefix) = query.path {
            if !path.to_lowercase().starts_with(&prefix.to_lowercase()) {
                return false;
            }
        }
        if let Some(ref cls) = query.class {
            if !class.eq_ignore_ascii_case(cls) {
                return false;
            }
        }
        if let Some(ref search) = query.search {
            let lower = search.to_lowercase();
            if !name.to_lowercase().contains(&lower) && !path.to_lowercase().contains(&lower) {
                return false;
            }
        }
        true
    }).map(|mut node| {
        // Optionally limit tree depth
        if let Some(max) = query.max_depth {
            trim_depth(&mut node, 0, max);
        }
        node
    }).collect();

    serde_json::Value::Array(filtered)
}

fn trim_depth(node: &mut serde_json::Value, current: u32, max: u32) {
    if current >= max {
        if let Some(obj) = node.as_object_mut() {
            obj.remove("children");
        }
    } else if let Some(children) = node.get_mut("children") {
        if let Some(arr) = children.as_array_mut() {
            for child in arr.iter_mut() {
                trim_depth(child, current + 1, max);
            }
        }
    }
}

pub fn filter_scripts(data: &serde_json::Value, query: &GameQuery) -> serde_json::Value {
    let items = match data.as_array() {
        Some(arr) => arr,
        None => return data.clone(),
    };

    let filtered: Vec<&serde_json::Value> = items.iter().filter(|entry| {
        let path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let class = entry.get("class_name").and_then(|v| v.as_str()).unwrap_or("");

        if let Some(ref prefix) = query.path {
            if !path.to_lowercase().starts_with(&prefix.to_lowercase()) {
                return false;
            }
        }
        if let Some(ref cls) = query.class {
            if !class.eq_ignore_ascii_case(cls) {
                return false;
            }
        }
        if let Some(ref search) = query.search {
            let lower = search.to_lowercase();
            // search in path + outline data
            if !path.to_lowercase().contains(&lower) {
                if let Some(outline) = entry.get("outline") {
                    let outline_str = serde_json::to_string(outline).unwrap_or_default().to_lowercase();
                    if !outline_str.contains(&lower) {
                        return false;
                    }
                } else {
                    return false;
                }
            }
        }
        true
    }).collect();

    serde_json::json!(filtered)
}

pub fn filter_entries(data: &serde_json::Value, query: &GameQuery) -> serde_json::Value {
    let items = match data.as_array() {
        Some(arr) => arr,
        None => return data.clone(),
    };

    let filtered: Vec<&serde_json::Value> = items.iter().filter(|entry| {
        let path = entry.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let class = entry.get("class_name").and_then(|v| v.as_str()).unwrap_or("");
        let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");

        if let Some(ref prefix) = query.path {
            if !path.to_lowercase().starts_with(&prefix.to_lowercase()) && !name.to_lowercase().starts_with(&prefix.to_lowercase()) {
                return false;
            }
        }
        if let Some(ref cls) = query.class {
            if !class.eq_ignore_ascii_case(cls) {
                return false;
            }
        }
        if let Some(ref search) = query.search {
            let lower = search.to_lowercase();
            if !path.to_lowercase().contains(&lower) && !name.to_lowercase().contains(&lower) {
                return false;
            }
        }
        true
    }).collect();

    serde_json::json!(filtered)
}

/// Merge full source from scripts_full.json into filtered script entries
pub fn merge_source_into_scripts(scripts: &mut serde_json::Value, full_data: &serde_json::Value) {
    let scripts_arr = match scripts.as_array_mut() {
        Some(arr) => arr,
        None => return,
    };
    let full_arr = match full_data.as_array() {
        Some(arr) => arr,
        None => return,
    };

    for script in scripts_arr.iter_mut() {
        let path = script.get("path").and_then(|v| v.as_str()).unwrap_or("");
        if path.is_empty() { continue; }

        if let Some(full) = full_arr.iter().find(|f| {
            f.get("path").and_then(|v| v.as_str()).unwrap_or("") == path
        }) {
            if let Some(source) = full.get("source") {
                if let Some(obj) = script.as_object_mut() {
                    obj.insert("source".to_string(), source.clone());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tree_hash_deterministic() {
        let tree = serde_json::json!([
            {"name": "Part", "class_name": "Part", "path": "Workspace.Part"},
            {"name": "Model", "class_name": "Model", "path": "Workspace.Model"},
        ]);
        let hash1 = compute_tree_hash(&tree);
        let hash2 = compute_tree_hash(&tree);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_tree_hash_order_independent() {
        let tree1 = serde_json::json!([
            {"name": "A", "class_name": "Part", "path": "Workspace.A"},
            {"name": "B", "class_name": "Model", "path": "Workspace.B"},
        ]);
        let tree2 = serde_json::json!([
            {"name": "B", "class_name": "Model", "path": "Workspace.B"},
            {"name": "A", "class_name": "Part", "path": "Workspace.A"},
        ]);
        assert_eq!(compute_tree_hash(&tree1), compute_tree_hash(&tree2));
    }

    #[test]
    fn test_generate_outline() {
        let source = r#"
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")
local DataManager = require(ReplicatedStorage.Modules.DataManager)

local ShopHandler = {}
local MAX_ITEMS = 50

function ShopHandler.Init(player)
    print("init")
end

function ShopHandler.PurchaseItem(itemId, quantity)
    ReplicatedStorage.Remotes.PurchaseItem:FireServer(itemId, quantity)
end

local remote = ReplicatedStorage:FindFirstChild("01_server")
local gui = Players.LocalPlayer.PlayerGui:WaitForChild("MainGui")

return ShopHandler
"#;
        let outline = generate_outline(source);
        assert_eq!(outline.functions.len(), 2);
        assert!(outline.functions[0].contains("ShopHandler.Init"));
        assert!(outline.functions[1].contains("ShopHandler.PurchaseItem"));
        assert_eq!(outline.services.len(), 2);
        assert!(outline.services.contains(&"ReplicatedStorage".to_string()));
        assert!(outline.services.contains(&"Players".to_string()));
        assert_eq!(outline.requires.len(), 1);
        assert!(outline.remote_accesses.len() >= 1);
        assert!(outline.top_level_vars.contains(&"ShopHandler".to_string()));
        assert!(outline.top_level_vars.contains(&"MAX_ITEMS".to_string()));
        // instance_refs
        assert!(outline.instance_refs.contains(&"01_server".to_string()));
        assert!(outline.instance_refs.contains(&"MainGui".to_string()));
        // string_constants should include notable strings but not services
        assert!(outline.string_constants.contains(&"init".to_string()));
        assert!(!outline.string_constants.contains(&"ReplicatedStorage".to_string()));
    }

    #[test]
    fn test_save_load_roundtrip() {
        let dir = std::env::temp_dir().join("xeno_mcp_test_scanner");
        let _ = fs::remove_dir_all(&dir);

        let data = serde_json::json!({"test": true});
        save_chunk(&dir, 12345, "test.json", &data).unwrap();
        let loaded = load_file(&dir, 12345, "test.json").unwrap();
        assert_eq!(loaded, data);

        delete_game(&dir, 12345).unwrap();
        assert!(!game_exists(&dir, 12345));
        let _ = fs::remove_dir_all(&dir);
    }
}
