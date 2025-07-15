use actix_web::{web, HttpRequest, HttpResponse};
use chrono::Local;
use std::sync::Arc;
use uuid::Uuid;

use crate::models::{AppState, InternalEvent, LogEntry};
use crate::routes::logs::{check_secret, store_entry};
use crate::xeno::xeno_fetch_clients;

pub async fn post_internal(
    req: HttpRequest,
    body: web::Json<InternalEvent>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }

    let evt = body.into_inner();
    let username = evt.username.trim().to_string();
    let event = evt.event.trim().to_lowercase();

    if username.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": "username must not be empty",
            "status": 400
        }));
    }

    let resolved_pid= match xeno_fetch_clients(&state).await {
        Ok(clients) => clients
            .iter()
            .find(|c| c.username.eq_ignore_ascii_case(&username))
            .map(|c| c.pid.to_string()),
        Err(_) => None,
    };

    match event.as_str() {
        "attached" => {
            if let Some(ref pid) = resolved_pid {
                state.logger_pids.write().insert(pid.clone());
            }
            let entry = LogEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Local::now(),
                level: "info".to_string(),
                message: format!("Logger attached for '{}'", username),
                source: Some("xeno-mcp".to_string()),
                pid: resolved_pid.as_ref().and_then(|p| p.parse::<u64>().ok()),
                username: Some(username.clone()),
                tags: vec!["internal".to_string(), "attached".to_string()],
            };
            store_entry(&state, &entry);
            println!(
                "[xeno-mcp] \u{2713} Logger attached: {} (PID {})",
                username,
                resolved_pid.as_deref().unwrap_or("?")
            );

            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "event": "attached",
                "username": username,
                "pid": resolved_pid,
            }))
        }

        "already_attached" => {
            if let Some(ref pid) = resolved_pid {
                state.logger_pids.write().insert(pid.clone());
            }
            let entry = LogEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Local::now(),
                level: "info".to_string(),
                message: format!("Logger already attached for '{}', re-tracked", username),
                source: Some("xeno-mcp".to_string()),
                pid: resolved_pid.as_ref().and_then(|p| p.parse::<u64>().ok()),
                username: Some(username.clone()),
                tags: vec!["internal".to_string(), "already_attached".to_string()],
            };
            store_entry(&state, &entry);

            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "event": "already_attached",
                "username": username,
                "pid": resolved_pid,
            }))
        }

        "disconnected" => {
            let was_tracked = if let Some(ref pid) = resolved_pid {
                state.logger_pids.write().remove(pid)
            } else {
                false
            };

            let entry = LogEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Local::now(),
                level: "info".to_string(),
                message: format!("Client '{}' disconnected (player left game)", username),
                source: Some("xeno-mcp".to_string()),
                pid: resolved_pid.as_ref().and_then(|p| p.parse::<u64>().ok()),
                username: Some(username.clone()),
                tags: vec!["internal".to_string(), "disconnected".to_string()],
            };
            store_entry(&state, &entry);

            if was_tracked {
                println!(
                    "[xeno-mcp] \u{2717} Logger detached: {} (PID {}, player left)",
                    username,
                    resolved_pid.as_deref().unwrap_or("?")
                );
            }

            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "event": "disconnected",
                "username": username,
                "pid": resolved_pid,
                "was_tracked": was_tracked,
            }))
        }

        "log" => {
            let message = match evt.message {
                Some(m) if !m.is_empty() => m,
                _ => {
                    return HttpResponse::BadRequest().json(serde_json::json!({
                        "ok": false,
                        "error": "log event requires a non-empty 'message' field",
                        "status": 400
                    }));
                }
            };

            if let Some(ref pid) = resolved_pid {
                let pid_str = pid.clone();
                if !state.logger_pids.read().contains(&pid_str) {
                    state.logger_pids.write().insert(pid_str);
                }
            }

            let entry = LogEntry {
                id: Uuid::new_v4().to_string(),
                timestamp: Local::now(),
                level: evt.level.unwrap_or_else(|| "output".into()),
                message,
                source: evt.source.or(Some("roblox".into())),
                pid: resolved_pid.as_ref().and_then(|p| p.parse::<u64>().ok()),
                username: Some(username.clone()),
                tags: if evt.tags.is_empty() { vec!["auto".into()] } else { evt.tags },
            };
            let id = entry.id.clone();
            store_entry(&state, &entry);

            HttpResponse::Ok().json(serde_json::json!({
                "ok": true,
                "event": "log",
                "id": id,
            }))
        }

        _ => HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": format!("Unknown event '{}'. Valid events: attached, already_attached, disconnected, log", event),
            "status": 400
        })),
    }
}
