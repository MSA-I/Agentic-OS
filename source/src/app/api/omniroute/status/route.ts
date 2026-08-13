import { NextResponse } from "next/server";
import { OMNIROUTE_BASE, omnirouteRequestHeaders } from "@/lib/omniroute";
import { ROUTER9_BASE, ROUTER9_KEY } from "@/lib/router9";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/omniroute/status?backend=omniroute|ninerouter — is the selected
// Free-AI-Coder backend running locally? Both serve a dashboard on their port
// and an OpenAI-compatible API at /v1.

const BACKENDS: Record<string, { base: string; headers: Record<string, string> }> = {
  omniroute: { base: OMNIROUTE_BASE, headers: omnirouteRequestHeaders() },
  ninerouter: {
    base: ROUTER9_BASE,
    headers: { Authorization: `Bearer ${ROUTER9_KEY}`, "x-api-key": ROUTER9_KEY },
  },
};

async function ping(base: string, path: string, headers: Record<string, string>, ms = 4000): Promise<number | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(base + path, { signal: ctrl.signal, cache: "no-store", headers });
    return r.status;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

export async function GET(req: Request) {
  const backend = new URL(req.url).searchParams.get("backend") === "ninerouter" ? "ninerouter" : "omniroute";
  const { base, headers } = BACKENDS[backend];
  // Try the API first, then the dashboard.
  const api = await ping(base, "/v1/models", headers);
  const dash = api === 200 ? 200 : await ping(base, "/", headers);

  let models: number | null = null;
  if (api === 200) {
    try {
      const r = await fetch(base + "/v1/models", {
        cache: "no-store",
        headers,
        signal: AbortSignal.timeout(4000),
      });
      const j = await r.json().catch(() => null);
      const arr = j?.data ?? j?.models ?? [];
      if (Array.isArray(arr)) models = arr.length;
    } catch {
      /* ignore */
    }
  }
  const running = api === 200 && models !== null && models > 0;

  return NextResponse.json({
    backend,
    running,
    base,
    api: `${base}/v1`,
    dashboard: base,
    apiStatus: api,
    dashboardStatus: dash,
    models,
  });
}
