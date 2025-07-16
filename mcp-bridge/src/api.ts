const BASE_URL = process.env.XENO_MCP_URL || "http://localhost:3111";
const SECRET = process.env.XENO_MCP_SECRET || undefined;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["X-Xeno-Secret"] = SECRET;
  return h;
}

export async function apiGet(path: string, params?: Record<string, string>): Promise<any> {
  const url = new URL(path, BASE_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url.toString(), { headers: headers() });
  return res.json();
}

export async function apiPost(path: string, body: any): Promise<any> {
  const res = await fetch(new URL(path, BASE_URL).toString(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function apiDelete(path: string): Promise<any> {
  const res = await fetch(new URL(path, BASE_URL).toString(), {
    method: "DELETE",
    headers: headers(),
  });
  return res.json();
}
