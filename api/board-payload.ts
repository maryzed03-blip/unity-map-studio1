// /api/board-payload.ts — Vercel serverless function.
//
// Proxies save/load/delete requests to the external "Unity Map API"
// payload storage server (demo.unityenergetics.org/unity-map-api).
//
// Why this exists: the browser can't call that external server directly
// — its CORS policy doesn't send an Access-Control-Allow-Origin header,
// so the browser blocks the request before it's even sent (the preflight
// fails). CORS is a BROWSER-ONLY restriction; it does not apply to
// server-to-server requests. This function runs on Vercel's servers, so
// it can freely call the external API — the browser only ever talks to
// this same-origin endpoint, which has no CORS issue at all.
//
// Bonus: the storage token now lives only in a server-side environment
// variable, never shipped to the browser at all (previously it was a
// VITE_-prefixed variable, which Vite bundles directly into the client
// JavaScript — visible to anyone who opened DevTools).
//
// IMPORTANT — this file must live at the PROJECT ROOT under /api/, i.e.
// exactly "api/board-payload.ts" next to package.json — NOT inside src/.
// Vercel auto-detects any file under a root-level /api/ folder as a
// serverless function, regardless of which frontend framework the rest
// of the app uses.

export const config = { runtime: "nodejs" };

const API_BASE = "https://demo.unityenergetics.org/unity-map-api";

// Reuses the same token already configured as VITE_BOARD_STORAGE_TOKEN in
// Vercel — server-side code can read any environment variable regardless
// of the VITE_ prefix (that prefix only controls whether Vite bundles a
// variable into the CLIENT build). No new Vercel env var needed to get
// this working right now.
function getToken(): string | null {
  return process.env.VITE_BOARD_STORAGE_TOKEN || process.env.BOARD_STORAGE_TOKEN || null;
}

interface VercelRequest {
  method?: string;
  query: Record<string, string | string[] | undefined>;
  body: unknown;
}
interface VercelResponse {
  status(code: number): VercelResponse;
  json(body: unknown): void;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = getToken();
  if (!token) {
    res.status(500).json({
      error: "Server misconfigured: VITE_BOARD_STORAGE_TOKEN is not set for this Vercel environment.",
    });
    return;
  }

  try {
    if (req.method === "POST") {
      // Save — forward the full board JSON.
      const upstream = await fetch(`${API_BASE}/payloads`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(req.body),
      });
      const text = await upstream.text();
      res.status(upstream.status).json(safeParseJson(text));
      return;
    }

    if (req.method === "GET") {
      const ref = firstString(req.query.ref);
      if (!ref) {
        res.status(400).json({ error: "Missing required query parameter: ref" });
        return;
      }
      const upstream = await fetch(`${API_BASE}/payloads/${encodeURIComponent(ref)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await upstream.text();
      res.status(upstream.status).json(safeParseJson(text));
      return;
    }

    if (req.method === "DELETE") {
      const ref = firstString(req.query.ref);
      if (!ref) {
        res.status(400).json({ error: "Missing required query parameter: ref" });
        return;
      }
      const upstream = await fetch(`${API_BASE}/payloads/${encodeURIComponent(ref)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      res.status(upstream.status).json({ ok: upstream.ok || upstream.status === 404 });
      return;
    }

    res.status(405).json({ error: `Method not allowed: ${req.method}` });
  } catch (e) {
    res.status(502).json({
      error: `Αδυναμία σύνδεσης με το εξωτερικό storage API: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
}

function firstString(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
