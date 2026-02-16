use chrono::{DateTime, Local};
use clap::Parser;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Parser, Debug, Clone)]
#[command(name = "xeno-mcp", about = "Roblox log receiver + Xeno API wrapper")]
pub struct Args {
    /// Port to listen on
    #[arg(short, long, default_value_t = 3111)]
    pub port: u16,

    /// Bind address
    #[arg(short, long, default_value = "127.0.0.1")]
    pub bind: String,

    /// Print every incoming log to stdout
    #[arg(long, default_value_t = false)]
    pub console: bool,

    /// Append every incoming log to this file (disabled when omitted)
    #[arg(long)]
    pub log_file: Option<String>,

    /// Shared secret – if set, every POST/DELETE must send header
    /// `X-Xeno-Secret` matching this value. GET requests are not gated.
    #[arg(long)]
    pub secret: Option<String>,

    /// Maximum number of log entries kept in memory (oldest evicted first)
    #[arg(long, default_value_t = 10_000)]
    pub max_entries: usize,

    /// Xeno local API base URL
    #[arg(long, default_value = "http://localhost:3110")]
    pub xeno_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LogEntry {
    pub id: String,
    pub timestamp: DateTime<Local>,
    pub level: String,
    pub message: String,
    pub source: Option<String>,
    pub pid: Option<u64>,
    pub username: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct LogQuery {
    pub level: Option<String>,
    pub source: Option<String>,
    pub search: Option<String>,
    pub tag: Option<String>,
    pub pid: Option<u64>,
    pub after: Option<String>,
    pub before: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
    pub page: Option<usize>,
    pub order: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct XenoClient {
    pub pid: u64,
    pub username: String,
    pub player_name: String,
    pub status: u8,
    pub status_text: String,
    pub user_id: Option<u64>,
    pub logger_attached: bool,
}

#[derive(Debug, Deserialize)]
pub struct ExecuteRequest {
    pub script: String,
    pub pids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct AttachLoggerRequest {
    pub pids: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct InternalEvent {
    pub event: String,
    pub username: String,
    pub level: Option<String>,
    pub message: Option<String>,
    pub source: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

pub struct AppState {
    pub logs: RwLock<Vec<LogEntry>>,
    pub logger_pids: RwLock<HashSet<String>>,
    pub http_client: reqwest::Client,
    pub args: Args,
}
