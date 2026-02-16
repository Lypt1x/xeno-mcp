const SCRIPTBLOX_BASE = "https://scriptblox.com/api/script";
const RAW_BASE = "https://rawscripts.net/raw";

// ── Types ──────────────────────────────────────────────────────────────

export interface ScriptBloxScript {
  _id: string;
  title: string;
  slug: string;
  game?: { gameId: number; name: string; imageUrl?: string };
  owner?: { username: string; _id?: string };
  script?: string;
  verified: boolean;
  key: boolean;
  keyLink?: string;
  universal: boolean;
  isPatched: boolean;
  views: number;
  likeCount: number;
  dislikeCount: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
  rawLink?: string;
}

export interface ScriptBloxListResponse {
  result: {
    totalPages: number;
    nextPage?: number;
    max: number;
    scripts: ScriptBloxScript[];
  };
}

export interface ScriptBloxDetailResponse {
  script: ScriptBloxScript;
}

export interface ScriptSearchParams {
  query: string;
  page?: number;
  max?: number;
  mode?: string;
  verified?: boolean;
  key?: boolean;
  universal?: boolean;
  sortBy?: string;
  order?: string;
}

export interface ScriptBrowseParams {
  page?: number;
  max?: number;
  mode?: string;
  verified?: boolean;
  key?: boolean;
  universal?: boolean;
  sortBy?: string;
  order?: string;
  placeId?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

function boolToParam(val: boolean | undefined): string | undefined {
  if (val === undefined) return undefined;
  return val ? "1" : "0";
}

function buildParams(obj: Record<string, string | number | boolean | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  return params;
}

async function sbFetch<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { "Accept": "application/json", "User-Agent": "xeno-mcp-bridge/1.0" },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ScriptBlox API error ${res.status}: ${body || res.statusText}`);
  }
  return res.json() as Promise<T>;
}

// ── API Functions ──────────────────────────────────────────────────────

export async function searchScripts(params: ScriptSearchParams): Promise<ScriptBloxListResponse> {
  const qs = buildParams({
    q: params.query,
    page: params.page ?? 1,
    max: params.max ?? 10,
    mode: params.mode,
    verified: boolToParam(params.verified),
    key: boolToParam(params.key),
    universal: boolToParam(params.universal),
    sortBy: params.sortBy,
    order: params.order,
  });
  return sbFetch<ScriptBloxListResponse>(`${SCRIPTBLOX_BASE}/search?${qs}`);
}

export async function fetchScripts(params: ScriptBrowseParams): Promise<ScriptBloxListResponse> {
  const qs = buildParams({
    page: params.page ?? 1,
    max: params.max ?? 10,
    mode: params.mode,
    verified: boolToParam(params.verified),
    key: boolToParam(params.key),
    universal: boolToParam(params.universal),
    sortBy: params.sortBy,
    order: params.order,
    placeId: params.placeId,
  });
  return sbFetch<ScriptBloxListResponse>(`${SCRIPTBLOX_BASE}/fetch?${qs}`);
}

export async function getScriptDetails(scriptId: string): Promise<{ meta: ScriptBloxScript; rawScript: string | null }> {
  const detail = await sbFetch<ScriptBloxDetailResponse>(`${SCRIPTBLOX_BASE}/${encodeURIComponent(scriptId)}`);
  const meta = detail.script;

  let rawScript: string | null = null;
  try {
    const rawRes = await fetch(`${RAW_BASE}/${encodeURIComponent(scriptId)}`, {
      headers: { "User-Agent": "xeno-mcp-bridge/1.0" },
    });
    if (rawRes.ok) {
      rawScript = await rawRes.text();
    }
  } catch { /* raw endpoint may fail — fall back to embedded script field */ }

  if (!rawScript && meta.script) {
    rawScript = meta.script;
  }

  return { meta, rawScript };
}

// ── Display Helpers ────────────────────────────────────────────────────

export function formatScriptList(scripts: ScriptBloxScript[]): string {
  if (scripts.length === 0) return "No scripts found.";

  return scripts.map((s, i) => {
    const badges: string[] = [];
    if (s.verified) badges.push("✅ Verified");
    else badges.push("⚠️ Unverified");
    if (s.key) badges.push("🔑 Key System");
    if (s.universal) badges.push("🌐 Universal");
    if (s.isPatched) badges.push("❌ Patched");

    const game = s.game?.name ?? (s.universal ? "Universal" : "Unknown");
    const author = s.owner?.username ?? "Unknown";

    return [
      `${i + 1}. **${s.title}**`,
      `   ID: ${s._id}`,
      `   Game: ${game} | Author: ${author}`,
      `   ${badges.join(" | ")}`,
      `   👁 ${s.views} views | 👍 ${s.likeCount} likes | 👎 ${s.dislikeCount} dislikes`,
    ].join("\n");
  }).join("\n\n");
}

export function detectObfuscation(script: string): boolean {
  if (!script) return false;
  const indicators = [
    // common obfuscation patterns
    /\bstring\.char\s*\(/i,
    /\bloadstring\s*\(/i,
    /\\x[0-9a-f]{2}/i,
    /\\u\{[0-9a-f]+\}/i,
    // extremely long single lines (>2000 chars with no newlines)
    script.split("\n").some(line => line.length > 2000),
    // high ratio of non-alphanumeric chars
    (script.replace(/[a-zA-Z0-9\s]/g, "").length / script.length) > 0.6,
  ];
  return indicators.filter(Boolean).length >= 2;
}
