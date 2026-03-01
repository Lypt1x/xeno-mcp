use actix_web::{web, HttpRequest, HttpResponse};
use chrono::Utc;
use std::sync::Arc;

use crate::models::{AppState, ScanStatus};
use crate::routes::logs::check_secret;
use crate::scanner::{
    self, GameQuery, ScanChunk, ScanCompleteRequest,
};

const SCANNER_TEMPLATE: &str = include_str!("../../lua/scanner.lua.tpl");

#[derive(serde::Deserialize)]
pub struct ScannerScriptQuery {
    pub scopes: Option<String>,
}

// GET /scanner-script — returns the scanner Lua with template vars filled
pub async fn get_scanner_script(
    query: web::Query<ScannerScriptQuery>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let secret_val = state.args.secret.as_deref().unwrap_or("");
    let base_url = format!("http://localhost:{}", state.args.port);

    let scopes = query.scopes.as_deref().unwrap_or(
        r#"["services","tree","scripts","remotes","properties"]"#,
    );

    let script = SCANNER_TEMPLATE
        .replace("{{BASE_URL}}", &base_url)
        .replace("{{SECRET}}", secret_val)
        .replace("{{SCOPES}}", scopes);

    HttpResponse::Ok()
        .content_type("text/plain; charset=utf-8")
        .body(script)
}

// POST /scan/data — receive a chunk from the Lua scanner
pub async fn post_scan_data(
    req: HttpRequest,
    body: web::Json<ScanChunk>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }

    let chunk = body.into_inner();
    let place_id = chunk.place_id;
    let storage_dir = &state.args.storage_dir;
    let storage = std::path::Path::new(storage_dir);

    // Track scan status
    {
        let mut scans = state.active_scans.write();
        scans.entry(place_id).or_insert_with(|| ScanStatus {
            place_id,
            status: "scanning".to_string(),
            progress: "receiving data".to_string(),
            started_at: Utc::now(),
        });
        if let Some(s) = scans.get_mut(&place_id) {
            s.progress = format!("receiving {}", chunk.chunk_type);
        }
    }

    let result = match chunk.chunk_type.as_str() {
        "tree" => {
            // Tree chunks are arrays of InstanceNode — append per service
            scanner::append_to_array(storage, place_id, "tree.json", &chunk.data)
        }
        "scripts" => {
            scanner::process_script_chunk(storage, place_id, &chunk.data)
        }
        "remotes" => {
            scanner::append_to_array(storage, place_id, "remotes.json", &chunk.data)
        }
        "properties" => {
            scanner::append_to_array(storage, place_id, "properties.json", &chunk.data)
        }
        "services" => {
            scanner::save_chunk(storage, place_id, "services.json", &chunk.data)
        }
        other => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "ok": false,
                "error": format!("Unknown chunk type: {}", other),
                "status": 400
            }));
        }
    };

    match result {
        Ok(()) => HttpResponse::Ok().json(serde_json::json!({
            "ok": true,
            "chunk_type": chunk.chunk_type,
            "place_id": place_id
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "ok": false,
            "error": e,
            "status": 500
        })),
    }
}

// POST /scan/complete — finalize a scan, write manifest
pub async fn post_scan_complete(
    req: HttpRequest,
    body: web::Json<ScanCompleteRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }

    let complete_req = body.into_inner();
    let place_id = complete_req.place_id;
    let storage = std::path::Path::new(&state.args.storage_dir);

    match scanner::write_manifest(storage, &complete_req) {
        Ok(manifest) => {
            // Remove from active scans
            state.active_scans.write().remove(&place_id);

            println!("[scanner] scan complete for {} ({}) — {} instances, {} scripts, {} remotes",
                manifest.place_name, place_id,
                manifest.instance_count, manifest.script_count, manifest.remote_count);

            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "manifest": manifest
            }))
        }
        Err(e) => {
            state.active_scans.write().remove(&place_id);
            HttpResponse::InternalServerError().json(serde_json::json!({
                "ok": false,
                "error": e,
                "status": 500
            }))
        }
    }
}

// GET /scan/status — check active scans
pub async fn get_scan_status(state: web::Data<Arc<AppState>>) -> HttpResponse {
    let scans = state.active_scans.read();
    let active: Vec<&ScanStatus> = scans.values().collect();
    HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "scans": active
    }))
}

// GET /games — list all scanned games
pub async fn get_games(state: web::Data<Arc<AppState>>) -> HttpResponse {
    let storage = std::path::Path::new(&state.args.storage_dir);
    match scanner::list_games(storage) {
        Ok(games) => HttpResponse::Ok().json(serde_json::json!({
            "ok": true,
            "games": games
        })),
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "ok": false,
            "error": e,
            "status": 500
        })),
    }
}

// GET /games/{placeId} — get manifest for a specific game
pub async fn get_game(
    path: web::Path<u64>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let place_id = path.into_inner();
    let storage = std::path::Path::new(&state.args.storage_dir);

    match scanner::load_file(storage, place_id, "manifest.json") {
        Ok(manifest) => HttpResponse::Ok().json(serde_json::json!({
            "ok": true,
            "manifest": manifest
        })),
        Err(_) => HttpResponse::NotFound().json(serde_json::json!({
            "ok": false,
            "error": format!("No scan data found for place {}", place_id),
            "status": 404
        })),
    }
}

// GET /games/{placeId}/{scope} — get specific scan data
pub async fn get_game_scope(
    path: web::Path<(u64, String)>,
    query: web::Query<GameQuery>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let (place_id, scope) = path.into_inner();
    let storage = std::path::Path::new(&state.args.storage_dir);
    let q = query.into_inner();

    let filename = match scope.as_str() {
        "tree" => "tree.json",
        "scripts" => {
            if q.include_source.unwrap_or(false) {
                "scripts_full.json"
            } else {
                "scripts.json"
            }
        }
        "remotes" => "remotes.json",
        "properties" => "properties.json",
        "services" => "services.json",
        _ => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "ok": false,
                "error": format!("Unknown scope '{}'. Valid: tree, scripts, remotes, properties, services", scope),
                "status": 400
            }));
        }
    };

    match scanner::load_file(storage, place_id, filename) {
        Ok(data) => {
            // If include_source is true and we have full sources, merge them with outlines
            let filtered = if scope == "scripts" && q.include_source.unwrap_or(false) {
                // When requesting source, we loaded scripts_full.json.
                // The caller wants full source for scripts matching their filters.
                // If there's a path filter, only include matching scripts' source.
                if q.path.is_some() || q.search.is_some() || q.class.is_some() {
                    scanner::filter_scripts(&data, &q)
                } else {
                    data
                }
            } else if scope == "tree" {
                scanner::filter_tree(&data, &q)
            } else if scope == "scripts" {
                scanner::filter_scripts(&data, &q)
            } else {
                scanner::filter_entries(&data, &q)
            };

            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "place_id": place_id,
                "scope": scope,
                "data": filtered
            }))
        }
        Err(_) => HttpResponse::NotFound().json(serde_json::json!({
            "ok": false,
            "error": format!("No {} data found for place {}", scope, place_id),
            "status": 404
        })),
    }
}

// DELETE /games/{placeId} — delete stored game data
pub async fn delete_game(
    req: HttpRequest,
    path: web::Path<u64>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }

    let place_id = path.into_inner();
    let storage = std::path::Path::new(&state.args.storage_dir);

    if !scanner::game_exists(storage, place_id) {
        return HttpResponse::NotFound().json(serde_json::json!({
            "ok": false,
            "error": format!("No scan data found for place {}", place_id),
            "status": 404
        }));
    }

    match scanner::delete_game(storage, place_id) {
        Ok(()) => {
            println!("[scanner] deleted stored data for place {}", place_id);
            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "message": format!("Deleted scan data for place {}", place_id)
            }))
        }
        Err(e) => HttpResponse::InternalServerError().json(serde_json::json!({
            "ok": false,
            "error": e,
            "status": 500
        })),
    }
}

// POST /scan/cancel — cancel an in-progress scan
pub async fn post_scan_cancel(
    req: HttpRequest,
    body: web::Json<serde_json::Value>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }

    let place_id = match body.get("place_id").and_then(|v| v.as_u64()) {
        Some(id) => id,
        None => {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "ok": false,
                "error": "Missing required field: place_id",
                "status": 400
            }));
        }
    };

    let removed = state.active_scans.write().remove(&place_id).is_some();

    if removed {
        HttpResponse::Ok().json(serde_json::json!({
            "ok": true,
            "message": format!("Cancelled scan for place {}", place_id)
        }))
    } else {
        HttpResponse::NotFound().json(serde_json::json!({
            "ok": false,
            "error": format!("No active scan found for place {}", place_id),
            "status": 404
        }))
    }
}
