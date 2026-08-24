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

/**
 * External storage schema.
 *
 * The storage API validates three required arrays:
 * - nodes
 * - edges
 * - drawings
 *
 * Unity Map Studio internally keeps every canvas item in one `objects`
 * array, so we also keep that canonical array in the payload. This gives
 * us a lossless round-trip even though the external API wants the items
 * split into categories for validation/storage purposes.
 */
interface ExternalCanvasPayload {
  objects: CanvasState["objects"];
  nodes: CanvasState["objects"];
  edges: CanvasState["objects"];
  drawings: CanvasState["objects"];
  viewport: CanvasState["viewport"];
  settings: CanvasState["settings"];
}

function toExternalPayload(state: CanvasState): ExternalCanvasPayload {
  const nodes: CanvasState["objects"] = [];
  const edges: CanvasState["objects"] = [];
  const drawings: CanvasState["objects"] = [];

  for (const object of state.objects) {
    if (object.type === "drawing") {
      drawings.push(object);
      continue;
    }

    if (object.type === "line" || object.type === "connector") {
      edges.push(object);
      continue;
    }

    nodes.push(object);
  }

  return {
    // Canonical, lossless Unity Map Studio representation.
    objects: state.objects,

    // Required external API categories.
    nodes,
    edges,
    drawings,

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

function mergeExternalArrays(stored: {
  nodes?: unknown;
  edges?: unknown;
  drawings?: unknown;
}): CanvasState["objects"] | null {
  if (!Array.isArray(stored.nodes)) {
    return null;
  }

  const nodes = stored.nodes as CanvasState["objects"];

  const edges = Array.isArray(stored.edges)
    ? (stored.edges as CanvasState["objects"])
    : [];

  const drawings = Array.isArray(stored.drawings)
    ? (stored.drawings as CanvasState["objects"])
    : [];

  // Deduplicate defensively by id.
  //
  // This also protects transitional payloads where an object may
  // accidentally exist both in nodes and in its dedicated array.
  const byId = new Map<string, CanvasState["objects"][number]>();

  for (const object of [...nodes, ...edges, ...drawings]) {
    if (
      object &&
      typeof object === "object" &&
      "id" in object &&
      typeof object.id === "string"
    ) {
      byId.set(object.id, object);
    }
  }

  return Array.from(byId.values()).sort((a, b) => {
    const az = typeof a.zIndex === "number" ? a.zIndex : 0;
    const bz = typeof b.zIndex === "number" ? b.zIndex : 0;

    return az - bz;
  });
}

function toCanvasState(
  data: unknown,
  payloadRef: string,
): CanvasState {
  // The storage API may return either:
  //
  // {
  //   payload: {...}
  // }
  //
  // or the stored payload directly.
  //
  // Support both forms.

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
    objects?: unknown;
    nodes?: unknown;
    edges?: unknown;
    drawings?: unknown;
    viewport?: unknown;
    settings?: unknown;
  };

  // Preferred path:
  //
  // If our canonical Unity Map Studio `objects` array is still present,
  // use it directly. This is the exact representation that was saved and
  // therefore preserves all canvas object types and their original order.
  if (Array.isArray(stored.objects)) {
    return {
      objects: stored.objects as CanvasState["objects"],

      viewport: isViewport(stored.viewport)
        ? stored.viewport
        : {
            x: 0,
            y: 0,
            zoom: 1,
          },

      settings: isSettings(stored.settings)
        ? stored.settings
        : {},
    };
  }

  // Fallback:
  //
  // If the external storage server returns only its split schema,
  // reconstruct Unity Map Studio's single objects array from
  // nodes + edges + drawings.
  const mergedObjects = mergeExternalArrays(stored);

  if (mergedObjects) {
    return {
      objects: mergedObjects,

      viewport: isViewport(stored.viewport)
        ? stored.viewport
        : {
            x: 0,
            y: 0,
            zoom: 1,
          },

      settings: isSettings(stored.settings)
        ? stored.settings
        : {},
    };
  }

  throw new Error(
    `Μη έγκυρα δεδομένα (λείπουν objects ή έγκυρα nodes/edges/drawings) από το storage API για ${payloadRef}`,
  );
}

/**
 * Uploads the full board JSON via our own proxy.
 *
 * External request shape:
 *
 * {
 *   payload: {
 *     objects: [...],
 *     nodes: [...],
 *     edges: [...],
 *     drawings: [...],
 *     viewport: {...},
 *     settings: {...}
 *   }
 * }
 *
 * Firestore metadata must NEVER be written unless this external upload
 * has already been confirmed successful.
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
 * Fetches the board JSON back through our proxy and converts the
 * external representation into Unity Map Studio's CanvasState.
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
 * A 404 means that it is already gone, therefore it is considered a
 * successful delete.
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
 * Simple connectivity check for the external storage service.
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
