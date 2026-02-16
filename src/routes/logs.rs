use actix_web::{web, HttpRequest, HttpResponse};
use chrono::{DateTime, Local};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;

use crate::errors::json_error;
use crate::models::{AppState, LogEntry, LogQuery};

pub fn check_secret(req: &HttpRequest, state: &AppState) -> Result<(), HttpResponse> {
    if let Some(ref secret) = state.args.secret {
        let provided = req
            .headers()
            .get("X-Xeno-Secret")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if provided != secret {
            return Err(json_error(
                actix_web::http::StatusCode::UNAUTHORIZED,
                "invalid or missing X-Xeno-Secret header",
            ));
        }
    }
    Ok(())
}

pub fn store_entry(state: &AppState, entry: &LogEntry) {
    if state.args.console {
        let origin = match (&entry.username, &entry.pid) {
            (Some(u), Some(p)) => format!("{}({})", u, p),
            (Some(u), None) => u.clone(),
            (None, Some(p)) => format!("PID:{}", p),
            (None, None) => "-".to_string(),
        };
        println!(
            "[{}] [{}] [{}] {} | {}",
            entry.timestamp.format("%H:%M:%S%.3f"),
            entry.level.to_uppercase(),
            origin,
            entry.source.as_deref().unwrap_or("-"),
            entry.message
        );
    }
    if let Some(ref path) = state.args.log_file {
        if let Ok(line) = serde_json::to_string(entry) {
            if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
                let _ = writeln!(f, "{}", line);
            }
        }
    }
    let mut logs = state.logs.write();
    if logs.len() >= state.args.max_entries {
        logs.remove(0);
    }
    logs.push(entry.clone());
}

pub async fn get_logs(
    query: web::Query<LogQuery>,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    let logs = state.logs.read();

    let after_dt = query.after.as_ref().and_then(|s| s.parse::<DateTime<Local>>().ok());
    let before_dt = query.before.as_ref().and_then(|s| s.parse::<DateTime<Local>>().ok());
    let tags: Vec<String> = query
        .tag
        .as_ref()
        .map(|t| t.split(',').map(|s| s.trim().to_lowercase()).collect())
        .unwrap_or_default();

    let mut filtered: Vec<&LogEntry> = logs
        .iter()
        .filter(|e| {
            if let Some(ref lvl) = query.level {
                if !e.level.eq_ignore_ascii_case(lvl) {
                    return false;
                }
            }
            if let Some(ref src) = query.source {
                if !e
                    .source
                    .as_ref()
                    .map(|s| s.to_lowercase().contains(&src.to_lowercase()))
                    .unwrap_or(false)
                {
                    return false;
                }
            }
            if let Some(ref search) = query.search {
                if !e.message.to_lowercase().contains(&search.to_lowercase()) {
                    return false;
                }
            }
            if let Some(pid) = query.pid {
                if e.pid != Some(pid) {
                    return false;
                }
            }
            if let Some(ref dt) = after_dt {
                if e.timestamp < *dt {
                    return false;
                }
            }
            if let Some(ref dt) = before_dt {
                if e.timestamp > *dt {
                    return false;
                }
            }
            if !tags.is_empty() {
                let entry_tags: Vec<String> =
                    e.tags.iter().map(|t| t.to_lowercase()).collect();
                if !tags.iter().any(|t| entry_tags.contains(t)) {
                    return false;
                }
            }
            true
        })
        .collect();

    let descending = query.order.as_ref().map(|o| o != "asc").unwrap_or(true);
    if descending {
        filtered.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    } else {
        filtered.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));
    }

    let total = filtered.len();
    let limit = query.limit.unwrap_or(50).min(1000);
    let offset = if let Some(p) = query.page {
        let p = if p == 0 { 1 } else { p };
        (p - 1) * limit
    } else {
        query.offset.unwrap_or(0)
    };
    let current_page = if limit > 0 { (offset / limit) + 1 } else { 1 };
    let total_pages = if limit > 0 { (total + limit - 1) / limit } else { 1 };
    let page: Vec<&LogEntry> = filtered.into_iter().skip(offset).take(limit).collect();
    let has_more = offset + page.len() < total;

    HttpResponse::Ok().json(serde_json::json!({
        "total": total,
        "page": current_page,
        "per_page": limit,
        "total_pages": total_pages,
        "has_more": has_more,
        "logs": page
    }))
}

pub async fn delete_logs(
    req: HttpRequest,
    state: web::Data<Arc<AppState>>,
) -> HttpResponse {
    if let Err(resp) = check_secret(&req, &state) {
        return resp;
    }
    let mut logs = state.logs.write();
    let count = logs.len();
    logs.clear();
    HttpResponse::Ok().json(serde_json::json!({ "ok": true, "cleared": count }))
}
