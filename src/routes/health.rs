use actix_web::{web, HttpResponse};
use std::collections::HashSet;
use std::sync::Arc;

use crate::models::AppState;
use crate::xeno::xeno_fetch_clients;

pub async fn health(state: web::Data<Arc<AppState>>) -> HttpResponse {
    let log_count = state.logs.read().len();
    let logger_pids_snapshot: Vec<String> =
        state.logger_pids.read().iter().cloned().collect();

    let xeno_status = match xeno_fetch_clients(&state).await {
        Ok(clients) => {
            // Prune logger_pids for clients that are no longer present
            {
                let active_pids: HashSet<String> =
                    clients.iter().map(|c| c.pid.to_string()).collect();
                let mut lp = state.logger_pids.write();
                lp.retain(|pid| active_pids.contains(pid));
            }

            serde_json::json!({
                "connected": true,
                "url": state.args.xeno_url,
                "client_count": clients.len(),
                "clients": clients,
            })
        }
        Err(err) => serde_json::json!({
            "connected": false,
            "url": state.args.xeno_url,
            "error": err,
        }),
    };

    HttpResponse::Ok().json(serde_json::json!({
        "status": "ok",
        "server": "xeno-mcp",
        "log_count": log_count,
        "logger_pids": logger_pids_snapshot,
        "xeno": xeno_status,
    }))
}
