// payload-api.ts — client for the external "Unity Map API" payload storage
// server (demo.unityenergetics.org/unity-map-api). Used to keep Firestore
// usage minimal: the (potentially large) canvas JSON for a saved board
// lives here, and only a small pointer (payloadRef/payloadUrl/size) is
// kept in Firestore. This matters at scale (many students) — Firestore
// document size and storage/read costs stay low regardless of how big
// individual boards get.
//
// CRITICAL SAFETY RULE: every function here either resolves with a
// genuinely confirmed result, or throws. Nothing is ever silently
// swallowed. storage.ts relies on this — it must NEVER write Firestore
// metadata claiming a save succeeded unless this module's savePayload()
// actually, synchronously confirmed success with the server. That
// mismatch (metadata says "saved", no real payload behind it) is what
// caused boards to come back empty in an earlier version of this app.

import type { CanvasState } from "./types";

const API_BASE = "https://demo.unityenergetics.org/unity-map-api";

function authHeader(): Record<string, string> {
  const token = import.meta.env.VITE_BOARD_STORAGE_TOKEN as string | undefined;
  if (!token) {
    throw new Error(
      "VITE_BOARD_STORAGE_TOKEN δεν είναι ρυθμισμένο σε αυτό το περιβάλλον — η αποθήκευση δεν μπορεί να προχωρήσει.",
    );
  }
  return { Authorization: `Bearer ${token}` };
}

export interface SavedPayload {
  payloadRef: string;
  payloadUrl: string;
  size: number;
}

/** POST /payloads — uploads the full board JSON, returns a pointer to it.
 *  Throws on any failure (network, non-2xx, or a malformed response) —
 *  callers must never treat a thrown error as a partial success. */
export async function savePayload(state: CanvasState): Promise<SavedPayload> {
  const body = JSON.stringify(state);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/payloads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(),
      },
      body,
    });
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Το storage API απέρριψε την αποθήκευση (HTTP ${res.status}): ${text || res.statusText}`);
  }
  const data = await res.json().catch(() => null);
  if (!data || data.success !== true || !data.payloadRef || !data.payloadUrl) {
    throw new Error("Το storage API επέστρεψε μη έγκυρη ή ημιτελή απάντηση κατά την αποθήκευση.");
  }
  return {
    payloadRef: String(data.payloadRef),
    payloadUrl: String(data.payloadUrl),
    size: typeof data.size === "number" ? data.size : body.length,
  };
}

/** GET /payloads/{payloadRef} (via the full payloadUrl returned by
 *  savePayload) — fetches the actual board JSON back. Throws if the
 *  request fails or the response doesn't look like a valid CanvasState. */
export async function loadPayload(payloadRef: string, payloadUrl: string): Promise<CanvasState> {
  const url = payloadUrl || `${API_BASE}/payloads/${encodeURIComponent(payloadRef)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: authHeader() });
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

/** DELETE /payloads/{payloadRef}. A 404 (already gone) is treated as
 *  success — everything else throws. */
export async function deletePayload(payloadRef: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/payloads/${encodeURIComponent(payloadRef)}`, {
      method: "DELETE",
      headers: authHeader(),
    });
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API κατά τη διαγραφή: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
    );
  }
  if (!res.ok && res.status !== 404) {
    throw new Error(`Αποτυχία διαγραφής από το storage API (HTTP ${res.status})`);
  }
}

/** GET /health — simple connectivity/config check, e.g. for a settings
 *  page or startup diagnostic. Never throws; returns false on any problem. */
export async function checkStorageHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
