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

interface ExternalPayloadShape {
  nodes: CanvasState["objects"];
  viewport: CanvasState["viewport"];
  settings: CanvasState["settings"];
}

function toExternalPayload(state: CanvasState): ExternalPayloadShape {
  return {
    nodes: state.objects,
    viewport: state.viewport,
    settings: state.settings,
  };
}

function toCanvasState(data: unknown, payloadRef: string): CanvasState {
  const unwrapped =
    data && typeof data === "object" && "payload" in data
      ? (data as { payload?: unknown }).payload
      : data;

  if (!unwrapped || typeof unwrapped !== "object") {
    throw new Error(
      `Μη έγκυρα δεδομένα από το storage API για ${payloadRef}`,
    );
  }

  const candidate = unwrapped as {
    nodes?: unknown;
    objects?: unknown;
    viewport?: unknown;
    settings?: unknown;
  };

  // Current external storage schema:
  // the canvas object array is called "nodes".
  if (Array.isArray(candidate.nodes)) {
    return {
      objects: candidate.nodes as CanvasState["objects"],
      viewport: isViewport(candidate.viewport)
        ? candidate.viewport
        : { x: 0, y: 0, zoom: 1 },
      settings: isSettings(candidate.settings)
        ? candidate.settings
        : {},
    };
  }

  // Backward compatibility with any older payload already stored
  // using the application's internal CanvasState field name "objects".
  if (Array.isArray(candidate.objects)) {
    return {
      objects: candidate.objects as CanvasState["objects"],
      viewport: isViewport(candidate.viewport)
        ? candidate.viewport
        : { x: 0, y: 0, zoom: 1 },
      settings: isSettings(candidate.settings)
        ? candidate.settings
        : {},
    };
  }

  throw new Error(
    `Μη έγκυρα δεδομένα (λείπει πίνακας nodes/objects) από το storage API για ${payloadRef}`,
  );
}

function isViewport(
  value: unknown,
): value is CanvasState["viewport"] {
  if (!value || typeof value !== "object") {
    return false;
  }

  const viewport = value as {
    x?: unknown;
    y?: unknown;
    zoom?: unknown;
  };

  return (
    typeof viewport.x === "number" &&
    typeof viewport.y === "number" &&
    typeof viewport.zoom === "number"
  );
}

function isSettings(
  value: unknown,
): value is CanvasState["settings"] {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

/**
 * Uploads the full board JSON via our own proxy.
 *
 * Throws on any failure (network, non-2xx, or a malformed response).
 * Callers must never treat a thrown error as a partial success.
 */
export async function savePayload(
  state: CanvasState,
): Promise<SavedPayload> {
  // The external storage API requires a top-level array field
  // named "nodes".
  //
  // Internally the app calls this array "objects", so we translate
  // only at the external API boundary.
  const body = JSON.stringify(toExternalPayload(state));

  let res: Response;

  try {
    res = await fetch(PROXY_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body,
    });
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API: ${
        networkErr instanceof Error
          ? networkErr.message
          : String(networkErr)
      }`,
    );
  }

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(
      `Το storage API απέρριψε την αποθήκευση (HTTP ${res.status}): ${
        data?.error || res.statusText
      }`,
    );
  }

  if (
    !data ||
    data.success !== true ||
    !data.payloadRef ||
    !data.payloadUrl
  ) {
    throw new Error(
      "Το storage API επέστρεψε μη έγκυρη ή ημιτελή απάντηση κατά την αποθήκευση.",
    );
  }

  return {
    payloadRef: String(data.payloadRef),
    payloadUrl: String(data.payloadUrl),
    size:
      typeof data.size === "number"
        ? data.size
        : body.length,
  };
}

/**
 * Fetches the actual board JSON back via our own proxy.
 *
 * Throws if the request fails or if the response cannot be converted
 * into a valid CanvasState.
 */
export async function loadPayload(
  payloadRef: string,
  _payloadUrl: string,
): Promise<CanvasState> {
  let res: Response;

  try {
    res = await fetch(
      `${PROXY_BASE}?ref=${encodeURIComponent(payloadRef)}`,
    );
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API κατά τη φόρτωση: ${
        networkErr instanceof Error
          ? networkErr.message
          : String(networkErr)
      }`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Αποτυχία φόρτωσης από το storage API (HTTP ${res.status}) για ${payloadRef}`,
    );
  }

  const data = await res.json().catch(() => null);

  return toCanvasState(data, payloadRef);
}

/**
 * A 404 (already gone) is treated as success.
 * Everything else throws.
 */
export async function deletePayload(
  payloadRef: string,
): Promise<void> {
  let res: Response;

  try {
    res = await fetch(
      `${PROXY_BASE}?ref=${encodeURIComponent(payloadRef)}`,
      {
        method: "DELETE",
      },
    );
  } catch (networkErr) {
    throw new Error(
      `Αδυναμία σύνδεσης με το storage API κατά τη διαγραφή: ${
        networkErr instanceof Error
          ? networkErr.message
          : String(networkErr)
      }`,
    );
  }

  if (!res.ok && res.status !== 404) {
    throw new Error(
      `Αποτυχία διαγραφής από το storage API (HTTP ${res.status})`,
    );
  }
}

/**
 * Simple connectivity check.
 */
export async function checkStorageHealth(): Promise<boolean> {
  try {
    const res = await fetch(
      "https://demo.unityenergetics.org/unity-map-api/health",
    );

    return res.ok;
  } catch {
    return false;
  }
}
