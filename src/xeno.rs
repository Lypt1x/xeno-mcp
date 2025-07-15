use crate::models::{AppState, XenoClient};

pub fn status_text(code: u8) -> &'static str {
    match code {
        0 => "Failed",
        1 => "Attaching",
        2 => "Waiting for Roblox",
        3 => "Attached",
        _ => "Unknown",
    }
}

pub async fn xeno_fetch_clients(state: &AppState) -> Result<Vec<XenoClient>, String> {
    let url = format!("{}/o", state.args.xeno_url);
    let resp = state
        .http_client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Cannot reach Xeno at {}: {}", url, e))?;

    if !resp.status().is_success() {
        return Err(format!("Xeno returned HTTP {}", resp.status()));
    }

    let raw: Vec<Vec<serde_json::Value>> = resp
        .json()
        .await
        .map_err(|e| format!("Failed to parse Xeno response: {}", e))?;

    let logger_pids = state.logger_pids.read();

    let clients = raw
        .into_iter()
        .filter_map(|row| {
            if row.len() < 4 {
                return None;
            }
            let pid = row[0].as_u64()?;
            let username = row[1].as_str()?.to_string();
            let player_name = row[2].as_str()?.to_string();
            let status = row[3].as_u64()? as u8;
            let user_id = row.get(4).and_then(|v| v.as_u64());
            Some(XenoClient {
                pid,
                username,
                player_name,
                status,
                status_text: status_text(status).to_string(),
                user_id,
                logger_attached: logger_pids.contains(&pid.to_string()),
            })
        })
        .collect();

    Ok(clients)
}

pub async fn xeno_execute(
    state: &AppState,
    script: &str,
    pids: &[String],
) -> Result<(), String> {
    let url = format!("{}/o", state.args.xeno_url);
    let clients_header = serde_json::to_string(pids).unwrap_or_else(|_| "[]".to_string());

    let resp = state
        .http_client
        .post(&url)
        .header("Content-Type", "text/plain")
        .header("Clients", &clients_header)
        .body(script.to_string())
        .send()
        .await
        .map_err(|e| format!("Cannot reach Xeno at {}: {}", url, e))?;

    if resp.status().is_success() {
        Ok(())
    } else {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        Err(format!("Xeno returned HTTP {} — {}", status, body))
    }
}
