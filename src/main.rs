mod errors;
mod loader;
mod logger;
mod models;
mod routes;
#[allow(dead_code)]
mod scanner;
mod spy;
mod xeno;

use actix_web::{web, web::JsonConfig, App, HttpResponse, HttpServer};
use chrono::Local;
use clap::Parser;
use parking_lot::RwLock;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use errors::*;
use models::{AppState, Args, LogEntry, ServerMode};
use routes::{health, internal, logs, scanner as scanner_routes, spy as spy_routes, xeno as xeno_routes};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();
    let bind_addr = format!("{}:{}", args.bind, args.port);

    let mode_str = match args.mode {
        ServerMode::Xeno => "xeno",
        ServerMode::Generic => "generic",
    };

    println!("xeno-mcp listening on {}", bind_addr);
    println!("  mode: {}, console: {}, secret: {}", mode_str, args.console, args.secret.is_some());
    match args.mode {
        ServerMode::Xeno => println!("  xeno: {}", args.xeno_url),
        ServerMode::Generic => {
            println!("  exchange-dir: {}", args.exchange_dir);
            let pending = format!("{}/pending", args.exchange_dir);
            let done = format!("{}/done", args.exchange_dir);
            std::fs::create_dir_all(&pending).expect("failed to create exchange/pending directory");
            std::fs::create_dir_all(&done).expect("failed to create exchange/done directory");
            println!("  exchange dirs ready: pending/, done/");
        }
    }
    println!();
    // Ensure storage directory exists
    let storage_path = std::path::Path::new(&args.storage_dir);
    std::fs::create_dir_all(storage_path.join("places"))
        .expect("failed to create storage/places directory");
    println!("  storage: {}", args.storage_dir);

    println!();
    println!("  GET  /health         POST /internal");
    println!("  GET  /clients        POST /execute");
    println!("  POST /attach-logger  GET  /loader-script");
    println!("  GET  /logs           DEL  /logs");
    println!("  POST /spy/attach     POST /spy/detach");
    println!("  POST /spy/subscribe  POST /spy/unsubscribe");
    println!("  GET  /spy/status");
    println!("  POST /scan/data      POST /scan/complete");
    println!("  GET  /scan/status    POST /scan/cancel");
    println!("  GET  /games          GET  /games/{{id}}");
    println!("  GET  /games/{{id}}/{{scope}}  DEL  /games/{{id}}");
    println!();

    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .expect("failed to build HTTP client");

    let state = Arc::new(AppState {
        logs: RwLock::new(Vec::with_capacity(args.max_entries)),
        logger_pids: RwLock::new(HashSet::new()),
        generic_clients: RwLock::new(HashMap::new()),
        spy_clients: RwLock::new(HashSet::new()),
        spy_subscriptions: RwLock::new(HashMap::new()),
        active_scans: RwLock::new(HashMap::new()),
        http_client,
        args: args.clone(),
    });

    // Background task: reap stale generic clients (no heartbeat for 15s)
    if matches!(args.mode, ServerMode::Generic) {
        let reaper_state = state.clone();
        tokio::spawn(async move {
            let timeout_secs = 15;
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                let now = Local::now();
                let mut clients = reaper_state.generic_clients.write();
                for client in clients.values_mut() {
                    if client.connected {
                        let elapsed = now.signed_duration_since(client.last_heartbeat).num_seconds();
                        if elapsed > timeout_secs {
                            client.connected = false;
                            println!("[xeno-mcp] \u{2717} Client '{}' timed out (no heartbeat for {}s)", client.username, elapsed);
                            let entry = LogEntry {
                                id: uuid::Uuid::new_v4().to_string(),
                                timestamp: now,
                                level: "info".to_string(),
                                message: format!("Client '{}' disconnected (heartbeat timeout after {}s)", client.username, elapsed),
                                source: Some("xeno-mcp".to_string()),
                                pid: None,
                                username: Some(client.username.clone()),
                                tags: vec!["internal".to_string(), "disconnected".to_string(), "timeout".to_string(), "generic".to_string()],
                            };
                            let mut logs = reaper_state.logs.write();
                            if logs.len() >= reaper_state.args.max_entries {
                                logs.remove(0);
                            }
                            logs.push(entry);
                        }
                    }
                }
            }
        });
    }

    HttpServer::new(move || {
        let json_cfg = JsonConfig::default()
            .limit(16 * 1024 * 1024) // 16 MB — scan chunks can be large
            .error_handler(|err, req| {
                let detail = err.to_string();
                let (status, msg) = if detail.contains("Content type error") {
                    (
                        actix_web::http::StatusCode::UNSUPPORTED_MEDIA_TYPE,
                        format!(
                            "Invalid Content-Type for {} {}. Expected: application/json",
                            req.method(), req.path()
                        ),
                    )
                } else if detail.contains("Payload reached size limit") {
                    (
                        actix_web::http::StatusCode::PAYLOAD_TOO_LARGE,
                        "Request body exceeds the 16 MB limit".to_string(),
                    )
                } else {
                    (
                        actix_web::http::StatusCode::BAD_REQUEST,
                        format!("Invalid JSON body: {}", detail),
                    )
                };
                let resp = HttpResponse::build(status).json(serde_json::json!({
                    "ok": false,
                    "error": msg,
                    "status": status.as_u16(),
                }));
                actix_web::error::InternalError::from_response(err, resp).into()
            });

        App::new()
            .app_data(web::Data::new(state.clone()))
            .app_data(json_cfg)
            .service(
                web::resource("/health")
                    .route(web::get().to(health::health))
                    .default_service(web::to(health_method_not_allowed)),
            )
            .service(
                web::resource("/clients")
                    .route(web::get().to(xeno_routes::get_clients))
                    .default_service(web::to(clients_method_not_allowed)),
            )
            .service(
                web::resource("/execute")
                    .route(web::post().to(xeno_routes::post_execute))
                    .default_service(web::to(execute_method_not_allowed)),
            )
            .service(
                web::resource("/attach-logger")
                    .route(web::post().to(xeno_routes::post_attach_logger))
                    .default_service(web::to(attach_logger_method_not_allowed)),
            )
            .service(
                web::resource("/loader-script")
                    .route(web::get().to(xeno_routes::get_loader_script))
                    .default_service(web::to(loader_script_method_not_allowed)),
            )
            .service(
                web::resource("/verify-script")
                    .route(web::post().to(xeno_routes::post_verify_script))
            )
            .service(
                web::resource("/internal")
                    .route(web::post().to(internal::post_internal))
                    .default_service(web::to(internal_method_not_allowed)),
            )
            .service(
                web::resource("/logs")
                    .route(web::get().to(logs::get_logs))
                    .route(web::delete().to(logs::delete_logs))
                    .default_service(web::to(logs_method_not_allowed)),
            )
            .service(
                web::resource("/spy/attach")
                    .route(web::post().to(spy_routes::post_attach_spy))
            )
            .service(
                web::resource("/spy/detach")
                    .route(web::post().to(spy_routes::post_detach_spy))
            )
            .service(
                web::resource("/spy/subscribe")
                    .route(web::post().to(spy_routes::post_spy_subscribe))
            )
            .service(
                web::resource("/spy/unsubscribe")
                    .route(web::post().to(spy_routes::post_spy_unsubscribe))
            )
            .service(
                web::resource("/spy/status")
                    .route(web::get().to(spy_routes::get_spy_status))
            )
            .service(
                web::resource("/scan/data")
                    .route(web::post().to(scanner_routes::post_scan_data))
            )
            .service(
                web::resource("/scan/complete")
                    .route(web::post().to(scanner_routes::post_scan_complete))
            )
            .service(
                web::resource("/scan/status")
                    .route(web::get().to(scanner_routes::get_scan_status))
            )
            .service(
                web::resource("/scan/cancel")
                    .route(web::post().to(scanner_routes::post_scan_cancel))
            )
            .service(
                web::resource("/scanner-script")
                    .route(web::get().to(scanner_routes::get_scanner_script))
            )
            .service(
                web::resource("/games")
                    .route(web::get().to(scanner_routes::get_games))
            )
            .service(
                web::resource("/games/{placeId}")
                    .route(web::get().to(scanner_routes::get_game))
                    .route(web::delete().to(scanner_routes::delete_game))
            )
            .service(
                web::resource("/games/{placeId}/{scope}")
                    .route(web::get().to(scanner_routes::get_game_scope))
            )
            .default_service(web::to(not_found_handler))
    })
    .bind(&bind_addr)?
    .run()
    .await
}
