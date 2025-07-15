mod errors;
mod logger;
mod models;
mod routes;
mod xeno;

use actix_web::{web, web::JsonConfig, App, HttpResponse, HttpServer};
use clap::Parser;
use parking_lot::RwLock;
use std::collections::HashSet;
use std::sync::Arc;

use errors::*;
use models::{AppState, Args};
use routes::{health, internal, logs, xeno as xeno_routes};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let args = Args::parse();
    let bind_addr = format!("{}:{}", args.bind, args.port);

    println!("xeno-mcp listening on {}", bind_addr);
    println!("  xeno: {}, console: {}, secret: {}", args.xeno_url, args.console, args.secret.is_some());
    println!();
    println!("  GET  /health         POST /internal");
    println!("  GET  /clients        POST /execute");
    println!("  POST /attach-logger");
    println!("  GET  /logs           DEL  /logs");
    println!();

    let state = Arc::new(AppState {
        logs: RwLock::new(Vec::with_capacity(args.max_entries)),
        logger_pids: RwLock::new(HashSet::new()),
        http_client: reqwest::Client::new(),
        args: args.clone(),
    });

    HttpServer::new(move || {
        let json_cfg = JsonConfig::default()
            .limit(1024 * 1024)
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
                        "Request body exceeds the 1 MB limit".to_string(),
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
            .default_service(web::to(not_found_handler))
    })
    .bind(&bind_addr)?
    .run()
    .await
}
