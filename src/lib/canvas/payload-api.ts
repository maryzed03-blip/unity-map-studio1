// payload-api.ts — client for board payload storage.
//
// Calls OUR OWN "/api/board-payload" proxy (a Vercel serverless function,
// see /api/board-payload.ts) instead of the external
// demo.unityenergetics.org server directly — the browser can't call that
// server directly because it doesn't send CORS headers allowing this
// site's origin, so the browser blocks the request before it's even
// sent. The proxy runs server-side, where CORS doesn't apply, and
// forwards the request on our behalf.
//
// CRITICAL SAFETY RULE: every function here either resolves with a
// genuinely confirmed result, or throws. Nothing is ever silently
// swallowed. storage.ts relies on this — it must NEVER write Firestore
// metadata claiming a save succeeded unless this module's savePayload()
// actually, synchronously confirmed success. That mismatch (metadata
// says "saved", no real payload behind it) is what caused boards to
// come back empty in an earlier version of this app.

import type { CanvasState } from "./types";

const PROXY_BASE = "/api/board-payload";

export interface SavedPayload {
  payloadRef: string;
  payloadUrl: string;
  size: number;
}

/** Uploads the full board JSON via our own proxy. Throws on any failure
 *  (network, non-2xx, or a malformed response) — callers must never
 *  treat a thrown error as a partial success. */
export async function savePayload(state: CanvasState): Promise<SavedPayload> {
  const body = JSON.stringify(state);
  let res: Response;
  try {
    res = await fetch(PROXY_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
    );
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `Το storage API απέρριψε την αποθήκευση (HTTP ${res.status}): ${data?.error || res.statusText}`,
    );
  }
  if (!data || data.success !== true || !data.payloadRef || !data.payloadUrl) {
    throw new Error("Το storage API επέστρεψε μη έγκυρη ή ημιτελή απάντηση κατά την αποθήκευση.");
  }
  return {
    payloadRef: String(data.payloadRef),
    payloadUrl: String(data.payloadUrl),
    size: typeof data.size === "number" ? data.size : body.length,
  };
}

/** Fetches the actual board JSON back via our own proxy. Throws if the
 *  request fails or the response doesn't look like a valid CanvasState. */
export async function loadPayload(payloadRef: string, _payloadUrl: string): Promise<CanvasState> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE}?ref=${encodeURIComponent(payloadRef)}`);
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API κατά τη φόρτωση: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
    );
  }
  if (!res.ok) {
    throw new Error(`Αποτυχία φόρτωσης από το storage API (HTTP ${res.status}) για ${payloadRef}`);
  }
  const data = await res.json().catch(() => null);
  if (!data || !Array.isArray(data.objects)) {
    throw new Error(`Μη έγκυρα δεδομένα (λείπει το πεδίο objects) από το storage API για ${payloadRef}`);
  }
  return data as CanvasState;
}

/** A 404 (already gone) is treated as success — everything else throws. */
export async function deletePayload(payloadRef: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${PROXY_BASE}?ref=${encodeURIComponent(payloadRef)}`, { method: "DELETE" });
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API κατά τη διαγραφή: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`Αποτυχία διαγραφής από το storage API (HTTP ${res.status})`);
  }
}

/** Simple connectivity check via the proxy's own health passthrough. If
 *  you want a real health check, hit the external /health endpoint
 *  directly (it's a plain unauthenticated GET, no CORS-sensitive
 *  headers) — this stub just avoids an unused export. */
export async function checkStorageHealth(): Promise<boolean> {
  try {
    const res = await fetch("https://demo.unityenergetics.org/unity-map-api/health");
    return res.ok;
  } catch {
    return false;
  }
}
