use actix_web::{web, HttpRequest, HttpResponse};
use std::sync::Arc;

use crate::models::{AppState, ServerMode};
use crate::routes::logs::check_secret;
use crate::spy::build_spy_lua;
use crate::xeno::xeno_execute;

fn require_generic(state: &AppState) -> Result<(), HttpResponse> {
    if matches!(state.args.mode, ServerMode::Xeno) {
        return Err(HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": "Remote spy requires UNC hook functions (hookfunction, hookmetamethod, newcclosure) which are not available in Xeno mode. Use generic mode with an executor that supports UNC.",
            "status": 400
        })));
    }
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
pub struct SpyRequest {
    pub pids: Option<Vec<String>>,
}

#[derive(Debug, serde::Deserialize)]
pub struct SpySubscribeRequest {
    pub path: String,
    pub pids: Option<Vec<String>>,
}

pub async fn post_attach_spy(
    req: HttpRequest,
    body: web::Json<SpyRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }
    if let Err(resp) = require_generic(&state) {
        return resp;
    }

    let lua = build_spy_lua(state.args.port, &state.args.secret);
    let req_body = body.into_inner();

    match state.args.mode {
        ServerMode::Generic => {
            // Write spy script to exchange directory
            let file_id = uuid::Uuid::new_v4().to_string();
            let file_content = if let Some(ref secret) = state.args.secret {
                let sig = hex::encode(hmac_sha256::HMAC::mac(lua.as_bytes(), secret.as_bytes()));
                format!("-- SIG:{}\n{}", sig, lua)
            } else {
                lua
            };
            let file_path = format!("{}/pending/{}.lua", state.args.exchange_dir, file_id);

            match std::fs::write(&file_path, &file_content) {
                Ok(()) => HttpResponse::Ok().json(serde_json::json!({
                    "ok": true,
                    "message": "Remote spy script sent. Waiting for client to pick it up.",
                    "file_id": file_id,
                })),
                Err(err) => HttpResponse::InternalServerError().json(serde_json::json!({
                    "ok": false,
                    "error": format!("Failed to write spy script: {}", err),
                    "status": 500
                })),
            }
        }
        ServerMode::Xeno => {
            // This shouldn't be reached due to require_generic, but handle gracefully
            let pids = req_body.pids.unwrap_or_default();
            if pids.is_empty() {
                return HttpResponse::BadRequest().json(serde_json::json!({
                    "ok": false,
                    "error": "pids array required in xeno mode",
                    "status": 400
                }));
            }
            match xeno_execute(&state, &lua, &pids).await {
                Ok(()) => HttpResponse::Ok().json(serde_json::json!({
                    "ok": true,
                    "message": "Remote spy script sent",
                    "sent_to": pids,
                })),
                Err(err) => HttpResponse::BadGateway().json(serde_json::json!({
                    "ok": false,
                    "error": err,
                    "status": 502
                })),
            }
        }
    }
}

pub async fn post_detach_spy(
    req: HttpRequest,
    body: web::Json<SpyRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }
    if let Err(resp) = require_generic(&state) {
        return resp;
    }

    let disconnect_lua = r#"if getgenv().__XENO_SPY then getgenv().__XENO_SPY.Disconnect() end"#;
    let req_body = body.into_inner();

    match state.args.mode {
        ServerMode::Generic => {
            let file_id = uuid::Uuid::new_v4().to_string();
            let file_content = if let Some(ref secret) = state.args.secret {
                let sig = hex::encode(hmac_sha256::HMAC::mac(disconnect_lua.as_bytes(), secret.as_bytes()));
                format!("-- SIG:{}\n{}", sig, disconnect_lua)
            } else {
                disconnect_lua.to_string()
            };
            let file_path = format!("{}/pending/{}.lua", state.args.exchange_dir, file_id);

            match std::fs::write(&file_path, &file_content) {
                Ok(()) => {
                    // Clear server-side spy state
                    state.spy_clients.write().clear();
                    state.spy_subscriptions.write().clear();

                    HttpResponse::Ok().json(serde_json::json!({
                        "ok": true,
                        "message": "Spy disconnect script sent.",
                    }))
                }
                Err(err) => HttpResponse::InternalServerError().json(serde_json::json!({
                    "ok": false,
                    "error": format!("Failed to write disconnect script: {}", err),
                    "status": 500
                })),
            }
        }
        ServerMode::Xeno => {
            let pids = req_body.pids.unwrap_or_default();
            match xeno_execute(&state, disconnect_lua, &pids).await {
                Ok(()) => {
                    let mut spy = state.spy_clients.write();
                    for pid in &pids { spy.remove(pid); }
                    let mut subs = state.spy_subscriptions.write();
                    for pid in &pids { subs.remove(pid); }

                    HttpResponse::Ok().json(serde_json::json!({
                        "ok": true,
                        "message": "Spy disconnect sent",
                        "sent_to": pids,
                    }))
                }
                Err(err) => HttpResponse::BadGateway().json(serde_json::json!({
                    "ok": false,
                    "error": err,
                    "status": 502
                })),
            }
        }
    }
}

pub async fn post_spy_subscribe(
    req: HttpRequest,
    body: web::Json<SpySubscribeRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }
    if let Err(resp) = require_generic(&state) {
        return resp;
    }

    let req_body = body.into_inner();
    let path = req_body.path.trim().to_string();
    if path.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": "path must not be empty",
            "status": 400
        }));
    }

    let subscribe_lua = format!(
        r#"if getgenv().__XENO_SPY then getgenv().__XENO_SPY.Subscribe("{}") end"#,
        path.replace('\\', "\\\\").replace('"', "\\\"")
    );

    match state.args.mode {
        ServerMode::Generic => {
            let file_id = uuid::Uuid::new_v4().to_string();
            let file_content = if let Some(ref secret) = state.args.secret {
                let sig = hex::encode(hmac_sha256::HMAC::mac(subscribe_lua.as_bytes(), secret.as_bytes()));
                format!("-- SIG:{}\n{}", sig, subscribe_lua)
            } else {
                subscribe_lua
            };
            let file_path = format!("{}/pending/{}.lua", state.args.exchange_dir, file_id);

            match std::fs::write(&file_path, &file_content) {
                Ok(()) => {
                    // Track subscription server-side (keyed by "generic" since no PID)
                    state.spy_subscriptions.write()
                        .entry("generic".to_string())
                        .or_default()
                        .insert(path.clone());

                    HttpResponse::Ok().json(serde_json::json!({
                        "ok": true,
                        "message": format!("Subscribed to '{}' — all calls will now be logged", path),
                        "path": path,
                    }))
                }
                Err(err) => HttpResponse::InternalServerError().json(serde_json::json!({
                    "ok": false,
                    "error": format!("Failed to write subscribe script: {}", err),
                    "status": 500
                })),
            }
        }
        ServerMode::Xeno => {
            let pids = req_body.pids.unwrap_or_default();
            match xeno_execute(&state, &subscribe_lua, &pids).await {
                Ok(()) => {
                    for pid in &pids {
                        state.spy_subscriptions.write()
                            .entry(pid.clone())
                            .or_default()
                            .insert(path.clone());
                    }
                    HttpResponse::Ok().json(serde_json::json!({
                        "ok": true,
                        "message": format!("Subscribed to '{}'", path),
                        "path": path,
                        "sent_to": pids,
                    }))
                }
                Err(err) => HttpResponse::BadGateway().json(serde_json::json!({
                    "ok": false,
                    "error": err,
                    "status": 502
                })),
            }
        }
    }
}

pub async fn post_spy_unsubscribe(
    req: HttpRequest,
    body: web::Json<SpySubscribeRequest>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }
    if let Err(resp) = require_generic(&state) {
        return resp;
    }

    let req_body = body.into_inner();
    let path = req_body.path.trim().to_string();
    if path.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({
            "ok": false,
            "error": "path must not be empty",
            "status": 400
        }));
    }

    let unsubscribe_lua = format!(
        r#"if getgenv().__XENO_SPY then getgenv().__XENO_SPY.Unsubscribe("{}") end"#,
        path.replace('\\', "\\\\").replace('"', "\\\"")
    );

    match state.args.mode {
        ServerMode::Generic => {
            let file_id = uuid::Uuid::new_v4().to_string();
            let file_content = if let Some(ref secret) = state.args.secret {
                let sig = hex::encode(hmac_sha256::HMAC::mac(unsubscribe_lua.as_bytes(), secret.as_bytes()));
                format!("-- SIG:{}\n{}", sig, unsubscribe_lua)
            } else {
                unsubscribe_lua
            };
            let file_path = format!("{}/pending/{}.lua", state.args.exchange_dir, file_id);

            match std::fs::write(&file_path, &file_content) {
                Ok(()) => {
                    if let Some(subs) = state.spy_subscriptions.write().get_mut("generic") {
                        subs.remove(&path);
                    }
                    HttpResponse::Ok().json(serde_json::json!({
                        "ok": true,
                        "message": format!("Unsubscribed from '{}' — back to dedup-only", path),
                        "path": path,
                    }))
                }
                Err(err) => HttpResponse::InternalServerError().json(serde_json::json!({
                    "ok": false,
                    "error": format!("Failed to write unsubscribe script: {}", err),
                    "status": 500
                })),
            }
        }
        ServerMode::Xeno => {
            let pids = req_body.pids.unwrap_or_default();
            match xeno_execute(&state, &unsubscribe_lua, &pids).await {
                Ok(()) => {
                    for pid in &pids {
                        if let Some(subs) = state.spy_subscriptions.write().get_mut(pid) {
                            subs.remove(&path);
                        }
                    }
                    HttpResponse::Ok().json(serde_json::json!({
                        "ok": true,
                        "message": format!("Unsubscribed from '{}'", path),
                        "path": path,
                        "sent_to": pids,
                    }))
                }
                Err(err) => HttpResponse::BadGateway().json(serde_json::json!({
                    "ok": false,
                    "error": err,
                    "status": 502
                })),
            }
        }
    }
}

pub async fn get_spy_status(
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let clients: Vec<String> = state.spy_clients.read().iter().cloned().collect();
    let subs = state.spy_subscriptions.read();
    let subscriptions: serde_json::Value = subs.iter()
        .map(|(k, v)| {
            let paths: Vec<&String> = v.iter().collect();
            (k.clone(), serde_json::json!(paths))
        })
        .collect::<serde_json::Map<String, serde_json::Value>>()
        .into();

    HttpResponse::Ok().json(serde_json::json!({
        "ok": true,
        "active": !clients.is_empty(),
        "clients": clients,
        "subscriptions": subscriptions,
    }))
}
