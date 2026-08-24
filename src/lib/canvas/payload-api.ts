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

interface ExternalCanvasPayload {
  nodes: CanvasState["objects"];
  edges: unknown[];
  viewport: CanvasState["viewport"];
  settings: CanvasState["settings"];
}

function toExternalPayload(state: CanvasState): ExternalCanvasPayload {
  return {
    // The storage API requires a "nodes" array.
    //
    // Unity Map Studio keeps ALL canvas objects in state.objects,
    // including shapes, text, drawings, lines and connectors.
    // We therefore preserve the complete canvas here.
    nodes: state.objects,

    // The storage API also requires an "edges" array.
    //
    // CanvasState does NOT have a separate edges collection.
    // Lines and connectors already live inside state.objects.
    // Sending them again as edges would duplicate them when loading
    // the canvas, so this array intentionally remains empty.
    edges: [],

    viewport: state.viewport,
    settings: state.settings,
  };
}

function isViewport(value: unknown): value is CanvasState["viewport"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
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

function isSettings(value: unknown): value is CanvasState["settings"] {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toCanvasState(
  data: unknown,
  payloadRef: string,
): CanvasState {
  // The storage API may return either:
  //
  // {
  //   payload: {
  //     nodes: [...],
  //     edges: [...],
  //     viewport: {...},
  //     settings: {...}
  //   }
  // }
  //
  // or the stored payload directly.
  //
  // Support both forms so loading remains backward-compatible.

  const raw =
    data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    "payload" in data
      ? (data as { payload?: unknown }).payload
      : data;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `Μη έγκυρα δεδομένα από το storage API για ${payloadRef}`,
    );
  }

  const stored = raw as {
    nodes?: unknown;
    edges?: unknown;
    objects?: unknown;
    viewport?: unknown;
    settings?: unknown;
  };

  // Current external storage format.
  //
  // All Unity Map Studio canvas objects are deliberately stored in
  // "nodes", including line/connector CanvasObjects.
  if (Array.isArray(stored.nodes)) {
    return {
      objects: stored.nodes as CanvasState["objects"],
      viewport: isViewport(stored.viewport)
        ? stored.viewport
        : { x: 0, y: 0, zoom: 1 },
      settings: isSettings(stored.settings)
        ? stored.settings
        : {},
    };
  }

  // Backward compatibility with older payloads that were saved using
  // the app's internal CanvasState property name "objects".
  if (Array.isArray(stored.objects)) {
    return {
      objects: stored.objects as CanvasState["objects"],
      viewport: isViewport(stored.viewport)
        ? stored.viewport
        : { x: 0, y: 0, zoom: 1 },
      settings: isSettings(stored.settings)
        ? stored.settings
        : {},
    };
  }

  throw new Error(
    `Μη έγκυρα δεδομένα (λείπει πίνακας nodes/objects) από το storage API για ${payloadRef}`,
  );
}

/**
 * Uploads the full board JSON via our own Vercel proxy.
 *
 * External API schema:
 *
 * {
 *   payload: {
 *     nodes: [...],
 *     edges: [...],
 *     viewport: {...},
 *     settings: {...}
 *   }
 * }
 *
 * Throws on every failure. A failed external upload must never be
 * treated as a successful Firestore save.
 */
export async function savePayload(
  state: CanvasState,
): Promise<SavedPayload> {
  const body = JSON.stringify({
    payload: toExternalPayload(state),
  });

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
 * Loads a board payload through our Vercel proxy and converts the
 * external storage representation back to CanvasState.
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
 * Deletes an externally stored payload.
 *
 * A 404 means that the payload is already gone, so it is considered
 * successful. All other failures are surfaced.
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
 * Simple storage-server connectivity check.
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
