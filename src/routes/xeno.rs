use actix_web::{web, HttpRequest, HttpResponse};
use chrono::Local;
use std::collections::HashSet;
use std::sync::Arc;
use uuid::Uuid;

use crate::loader::build_loader_lua;
use crate::logger::build_logger_lua;
use crate::models::{AppState, AttachLoggerRequest, ExecuteRequest, LogEntry, ServerMode};
use crate::routes::logs::{check_secret, store_entry};
use crate::xeno::{xeno_execute, xeno_fetch_clients};

pub async fn get_clients(state: web::Data<Arc<AppState>>) -> HttpResponse {
    match state.args.mode {
        ServerMode::Xeno => {
            match xeno_fetch_clients(&state).await {
                Ok(clients) => HttpResponse::Ok().json(serde_json::json!({
                    "ok": true,
                    "clients": clients
                })),
                Err(err) => HttpResponse::ServiceUnavailable().json(serde_json::json!({
                    "ok": false,
                    "error": err,
                    "status": 503
                })),
            }
        }
        ServerMode::Generic => {
            let clients = state.generic_clients.read();
            let connected: Vec<_> = clients.values()
                .filter(|c| c.connected)
                .map(|c| serde_json::json!({
                    "username": c.username,
                    "connected": c.connected,
                    "connected_at": c.connected_at.to_rfc3339(),
                    "last_heartbeat": c.last_heartbeat.to_rfc3339(),
                }))
                .collect();
            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "mode": "generic",
                "clients": connected,
            }))
        }
    }
}

pub async fn post_execute(
    req: HttpRequest,
    body: web::Json<ExecuteRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }

    let req_body = body.into_inner();

    if req_body.script.trim().is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": "script must not be empty",
            "status": 400
        }));
    }

    match state.args.mode {
        ServerMode::Generic => post_execute_generic(&req_body, &state),
        ServerMode::Xeno => post_execute_xeno(req_body, &state).await,
    }
}

fn post_execute_generic(
    req_body: &ExecuteRequest,
    state: &web::Data<Arc<AppState>>,
) -> HttpResponse {
    let file_id = Uuid::new_v4().to_string();
    let file_path = format!("{}/pending/{}.lua", state.args.exchange_dir, file_id);

    // Sign the script if a secret is configured
    let file_content = if let Some(ref secret) = state.args.secret {
        let sig = hex::encode(hmac_sha256::HMAC::mac(req_body.script.as_bytes(), secret.as_bytes()));
        format!("-- SIG:{}\n{}", sig, req_body.script)
    } else {
        req_body.script.clone()
    };

    match std::fs::write(&file_path, &file_content) {
        Ok(()) => {
            // Log the script execution
            let entry = LogEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Local::now(),
                level: "script".to_string(),
                message: req_body.script.clone(),
                source: Some("execute_lua".to_string()),
                pid: None,
                username: None,
                tags: vec!["script".to_string(), "executed".to_string(), "generic".to_string()],
            };
            store_entry(state, &entry);

            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "mode": "generic",
                "file_id": file_id,
                "message": "Script written to exchange directory. Loader will pick it up.",
            }))
        }
        Err(err) => HttpResponse::InternalServerError().json(serde_json::json!({
            "ok": false,
            "error": format!("Failed to write script file: {}", err),
            "status": 500
        })),
    }
}

async fn post_execute_xeno(
    req_body: ExecuteRequest,
    state: &web::Data<Arc<AppState>>,
) -> HttpResponse {
    if req_body.pids.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": "pids array must not be empty",
            "status": 400
        }));
    }

    let clients = match xeno_fetch_clients(state).await {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::ServiceUnavailable().json(serde_json::json!({
                "ok": false,
                "error": err,
                "status": 503
            }));
        }
    };

    let known_pids: HashSet<String> = clients.iter().map(|c| c.pid.to_string()).collect();
    let mut not_found = Vec::new();
    let mut not_attached = Vec::new();

    for pid in &req_body.pids {
        if !known_pids.contains(pid) {
            not_found.push(pid.clone());
        } else if let Some(client) = clients.iter().find(|c| c.pid.to_string() == *pid) {
            if client.status != 3 {
                not_attached.push(serde_json::json!({
                    "pid": pid,
                    "status": client.status_text,
                }));
            }
        }
    }

    if !not_found.is_empty() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "ok": false,
            "error": "Some PIDs were not found in Xeno",
            "not_found": not_found,
            "status": 404
        }));
    }
    if !not_attached.is_empty() {
        return HttpResponse::Conflict().json(serde_json::json!({
            "ok": false,
            "error": "Some PIDs are not in 'Attached' state",
            "not_attached": not_attached,
            "status": 409
        }));
    }

    match xeno_execute(state, &req_body.script, &req_body.pids).await {
        Ok(()) => {
            let target_names: Vec<String> = req_body.pids.iter().map(|pid| {
                clients.iter()
                    .find(|c| c.pid.to_string() == *pid)
                    .map(|c| format!("{}({})", c.username, c.pid))
                    .unwrap_or_else(|| pid.clone())
            }).collect();
            let entry = LogEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Local::now(),
                level: "script".to_string(),
                message: req_body.script.clone(),
                source: Some("execute_lua".to_string()),
                pid: if req_body.pids.len() == 1 { req_body.pids[0].parse::<u64>().ok() } else { None },
                username: if req_body.pids.len() == 1 {
                    clients.iter().find(|c| c.pid.to_string() == req_body.pids[0]).map(|c| c.username.clone())
                } else { None },
                tags: {
                    let mut t = vec!["script".to_string(), "executed".to_string()];
                    for name in &target_names { t.push(name.clone()); }
                    t
                },
            };
            store_entry(state, &entry);

            let logger_pids = state.logger_pids.read();
            let mut logger_status: Vec<serde_json::Value> = Vec::new();
            for pid in &req_body.pids {
                logger_status.push(serde_json::json!({
                    "pid": pid,
                    "logger_attached": logger_pids.contains(pid),
                }));
            }
            let pids_without_logger: Vec<&String> = req_body.pids.iter()
                .filter(|p| !logger_pids.contains(*p))
                .collect();

            let mut result = serde_json::json!({
                "ok": true,
                "executed_on": req_body.pids,
                "logger_status": logger_status,
            });
            if !pids_without_logger.is_empty() {
                result["warning"] = serde_json::json!(
                    format!("Logger is not attached on PIDs: {}. Script output will not be captured. Use POST /attach-logger first.",
                        pids_without_logger.iter().map(|p| p.as_str()).collect::<Vec<_>>().join(", "))
                );
            }
            HttpResponse::Ok().json(result)
        }
        Err(err) => HttpResponse::BadGateway().json(serde_json::json!({
            "ok": false,
            "error": err,
            "status": 502
        })),
    }
}

pub async fn post_attach_logger(
    req: HttpRequest,
    body: web::Json<AttachLoggerRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }

    match state.args.mode {
        ServerMode::Generic => {
            return HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "mode": "generic",
                "message": "In generic mode, the logger is embedded in the loader script. No separate attach step needed. Use GET /loader-script to obtain the loader.",
            }));
        }
        ServerMode::Xeno => {}
    }

    let req_body = body.into_inner();

    if req_body.pids.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": "pids array must not be empty",
            "status": 400
        }));
    }

    let clients = match xeno_fetch_clients(&state).await {
        Ok(c) => c,
        Err(err) => {
            return HttpResponse::ServiceUnavailable().json(serde_json::json!({
                "ok": false,
                "error": err,
                "status": 503
            }));
        }
    };

    let known_pids: HashSet<String> = clients.iter().map(|c| c.pid.to_string()).collect();
    let mut not_found = Vec::new();
    let mut not_attached = Vec::new();
    let mut already_attached = Vec::new();
    let mut to_attach = Vec::new();

    {
        let logger_pids = state.logger_pids.read();
        for pid in &req_body.pids {
            if !known_pids.contains(pid) {
                not_found.push(pid.clone());
            } else if let Some(client) = clients.iter().find(|c| c.pid.to_string() == *pid) {
                if client.status != 3 {
                    not_attached.push(serde_json::json!({
                        "pid": pid,
                        "status": client.status_text,
                    }));
                } else if logger_pids.contains(pid) {
                    already_attached.push(pid.clone());
                } else {
                    to_attach.push(pid.clone());
                }
            }
        }
    }

    if !not_found.is_empty() {
        return HttpResponse::NotFound().json(serde_json::json!({
            "ok": false,
            "error": "Some PIDs were not found in Xeno",
            "not_found": not_found,
            "status": 404
        }));
    }
    if !not_attached.is_empty() {
        return HttpResponse::Conflict().json(serde_json::json!({
            "ok": false,
            "error": "Some PIDs are not in 'Attached' state",
            "not_attached": not_attached,
            "status": 409
        }));
    }

    if to_attach.is_empty() {
        return HttpResponse::Ok().json(serde_json::json!({
            "ok": true,
            "message": "Logger already attached on all requested PIDs",
            "already_attached": already_attached
        }));
    }

    let lua = build_logger_lua(state.args.port, &state.args.secret);

    match xeno_execute(&state, &lua, &to_attach).await {
        Ok(()) => {
            let mut result = serde_json::json!({
                "ok": true,
                "message": "Logger script sent. Awaiting client confirmation via /internal.",
                "sent_to": to_attach
            });
            if !already_attached.is_empty() {
                result["already_attached"] = serde_json::json!(already_attached);
            }
            HttpResponse::Ok().json(result)
        }
        Err(err) => HttpResponse::BadGateway().json(serde_json::json!({
            "ok": false,
            "error": format!("Failed to execute logger script via Xeno: {}", err),
            "status": 502
        })),
    }
}

pub async fn get_loader_script(state: web::Data<Arc<AppState>>) -> HttpResponse {
    let lua = build_loader_lua(state.args.port, &state.args.secret, &state.args.exchange_dir, &state.args.executor_exchange_dir);
    HttpResponse::Ok()
        .content_type("text/plain; charset=utf-8")
        .body(lua)
}

#[derive(Debug, serde::Deserialize)]
pub struct VerifyScriptRequest {
    pub signature: String,
    pub script: String,
}

pub async fn post_verify_script(
    body: web::Json<VerifyScriptRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let secret = match &state.args.secret {
        Some(s) => s,
        None => {
            // No secret configured — signing is disabled, always valid
            return HttpResponse::Ok().json(serde_json::json!({ "ok": true, "valid": true }));
        }
    };

    let expected = hex::encode(hmac_sha256::HMAC::mac(body.script.as_bytes(), secret.as_bytes()));
    let valid = body.signature == expected;

    HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "valid": valid,
    }))
}
