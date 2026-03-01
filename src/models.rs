use chrono::{DateTime, Local, Utc};
use clap::{Parser, ValueEnum};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};


#[derive(Debug, Clone, ValueEnum)]
pub enum ServerMode {
    Xeno,
    Generic,
}

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

    /// Xeno local API base URL (only used in xeno mode)
    #[arg(long, default_value = "http://localhost:3110")]
    pub xeno_url: String,

    /// Server mode: "xeno" for Xeno WebSocket API, "generic" for file-based adapter
    #[arg(long, value_enum, default_value_t = ServerMode::Xeno)]
    pub mode: ServerMode,

    /// Directory for script exchange files — real OS path where the server writes scripts (used in generic mode)
    #[arg(long, default_value = "./exchange")]
    pub exchange_dir: String,

    /// Exchange directory path as seen by the executor's filesystem (used in the loader script).
    /// If not set, defaults to the same value as --exchange-dir.
    #[arg(long)]
    pub executor_exchange_dir: Option<String>,

    /// Directory for persistent game scanner storage
    #[arg(long, default_value = "./storage")]
    pub storage_dir: String,
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

#[derive(Debug, Clone, Serialize)]
pub struct GenericClient {
    pub username: String,
    pub last_heartbeat: DateTime<Local>,
    pub connected_at: DateTime<Local>,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ScanStatus {
    pub place_id: u64,
    pub status: String,
    pub progress: String,
    pub started_at: DateTime<Utc>,
}

pub struct AppState {
    pub logs: RwLock<Vec<LogEntry>>,
    pub logger_pids: RwLock<HashSet<String>>,
    pub generic_clients: RwLock<HashMap<String, GenericClient>>,
    pub spy_clients: RwLock<HashSet<String>>,
    pub spy_subscriptions: RwLock<HashMap<String, HashSet<String>>>,
    pub active_scans: RwLock<HashMap<u64, ScanStatus>>,
    pub http_client: reqwest::Client,
    pub args: Args,
}
