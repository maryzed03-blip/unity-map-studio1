// External board payload storage client.
//
// Goal (Stage 4): keep bulky CanvasState JSON OUT of Firestore documents to
// reduce Firestore STORAGE usage (Spark plan caps total storage at 1GB).
// Firestore continues to hold only lightweight metadata pointing at the
// payload stored here.
//
// SECURITY TRADEOFF — read carefully:
// The Bearer token below is embedded in the client bundle via
// VITE_BOARD_STORAGE_TOKEN and is therefore VISIBLE to anyone inspecting
// network requests in their own browser. This was a deliberate choice to
// avoid requiring Firebase Blaze (Cloud Functions) for a server-side proxy.
// The token is SHARED across all users of the app (not per-user), so anyone
// with it can save/load/delete ANY board's payload on the external server.
// This is a KNOWN, ACCEPTED limitation, not an oversight. It does NOT grant
// access to Firestore, Firebase Auth, or any teacher's OpenAI key — those
// remain on separate, properly-scoped credentials.
//
// We never log the token, and we scrub Authorization headers from any error
// surfaced via toast/console.

import type { CanvasState } from "./types";

const BASE_URL = "https://demo.unityenergetics.org/unity-map-api";

function token(): string {
  const t = import.meta.env.VITE_BOARD_STORAGE_TOKEN as string | undefined;
  if (!t) {
    throw new Error(
      "VITE_BOARD_STORAGE_TOKEN is not configured — external board storage is unavailable.",
    );
  }
  return t;
}

function authHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token()}`,
  };
}

/** Strip anything that looks like an Authorization header / bearer token
 *  from an error message before it reaches a toast or console. */
function scrub(msg: string): string {
  return msg
    .replace(/Bearer\s+[A-Za-z0-9._\-=]+/gi, "Bearer ***")
    .replace(/Authorization:\s*[^\s,;]+/gi, "Authorization: ***");
}

export interface SavePayloadResult {
  payloadRef: string;
  payloadUrl: string;
  size: number;
}

interface SavePayloadResponse {
  success?: boolean;
  payloadRef?: string;
  payloadUrl?: string;
  size?: number;
  error?: string;
}

export async function healthcheck(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/health`, { headers: authHeaders() });
    return res.ok;
  } catch {
    return false;
  }
}

export async function savePayload(state: CanvasState): Promise<SavePayloadResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}/payloads`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(state),
    });
  } catch (e) {
    throw new Error(scrub(`Network error saving payload: ${(e as Error).message}`));
  }
  let data: SavePayloadResponse = {};
  try {
    data = (await res.json()) as SavePayloadResponse;
  } catch {
    // fall through — handled below
  }
  if (!res.ok || data.success === false || !data.payloadRef || !data.payloadUrl) {
    throw new Error(scrub(data.error || `Payload save failed (HTTP ${res.status})`));
  }
  return {
    payloadRef: data.payloadRef,
    payloadUrl: data.payloadUrl,
    size: typeof data.size === "number" ? data.size : 0,
  };
}

export async function loadPayload(payloadRef: string, payloadUrl?: string): Promise<CanvasState> {
  // Prefer the full payloadUrl returned by save to avoid assuming URL structure.
  const url = payloadUrl || `${BASE_URL}/payloads/${encodeURIComponent(payloadRef)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    throw new Error(scrub(`Network error loading payload: ${(e as Error).message}`));
  }
  if (!res.ok) {
    throw new Error(scrub(`Payload load failed (HTTP ${res.status})`));
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new Error("Payload load failed: response is not JSON.");
  }
  const state = data as Partial<CanvasState> | null;
  if (!state || !Array.isArray((state as CanvasState).objects)) {
    throw new Error("Payload load failed: malformed canvas state (missing `objects`).");
  }
  return state as CanvasState;
}

/** Best-effort: never throws. A failed remote delete must not block the
 *  user's local delete-project flow. */
export async function deletePayload(payloadRef: string): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/payloads/${encodeURIComponent(payloadRef)}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (!res.ok) {
      console.warn(scrub(`deletePayload: remote delete failed (HTTP ${res.status})`));
    }
  } catch (e) {
    console.warn(scrub(`deletePayload: ${(e as Error).message}`));
  }
}
