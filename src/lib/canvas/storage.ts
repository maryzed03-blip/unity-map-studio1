// Storage seam. Component code only talks to the MapStore interface.
// FirestoreMapStore persists permanent snapshots; LocalDraftStore caches
// locally so the editor still works offline / before the first cloud save.
//
// Quota: every Firestore call goes through the cGetDoc/cSetDoc wrappers
// (src/lib/quota-guard.ts) — 1 read per load, 1 write per save.
//
// ── Stage 4 scope split ─────────────────────────────────────────────
// Only SOLO/DRAFT project boards (Project.mode === "solo", this file's
// FirestoreMapStore) offload their full JSON payload to the external
// storage API (src/lib/canvas/payload-api.ts). Firestore keeps only
// lightweight metadata ({ payloadRef, payloadUrl, payloadSize, ... }).
//
// LIVE session boards (mode "live" / "collaborativeFinal", handled via
// the polling sync in CanvasStage's `liveSync` path and live-sessions.ts)
// KEEP using a single inline Firestore snapshot document unchanged. Those
// boards are short-lived (cleared as sessions end) and already optimized
// for their own reasons; moving them to the external API would add
// unnecessary complexity for this stage.
// ────────────────────────────────────────────────────────────────────

import { doc, serverTimestamp } from "firebase/firestore";
import { toast } from "sonner";
import { db } from "../firebase";
import { cGetDoc, cSetDoc } from "../quota-guard";
import { emptyCanvasState, type CanvasState } from "./types";
import { deletePayload, loadPayload, savePayload } from "./payload-api";

export interface MapStore {
  load(mapId: string, opts?: { inline?: boolean }): Promise<CanvasState | null>;
  save(mapId: string, state: CanvasState, opts?: { inline?: boolean }): Promise<void>;
  /** Returns the remote snapshot together with its serverTimestamp savedAt
   *  (in ms) for version comparisons during live polling. Falls back to 0
   *  when offline / not present. */
  loadWithMeta(mapId: string): Promise<{ state: CanvasState | null; savedAt: number }>;
  /** Best-effort cleanup of the externally-stored payload for a map.
   *  Safe to call even if the map never had a remote payload. */
  deleteRemotePayload?(mapId: string): Promise<void>;
}

const KEY = (mapId: string) => `ums:draft:v1:${mapId}`;

export class LocalDraftStore {
  async load(mapId: string): Promise<CanvasState | null> {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(KEY(mapId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CanvasState;
      return parsed?.objects ? parsed : emptyCanvasState();
    } catch {
      return null;
    }
  }
  async save(mapId: string, state: CanvasState): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(KEY(mapId), JSON.stringify(state));
    } catch {
      /* quota etc */
    }
  }
}

// Per-session "already warned" flag — same pattern as the quota-guard
// WARN-once approach: don't spam a toast on every debounced save attempt.
let cloudWarnedThisSession = false;

export class FirestoreMapStore implements MapStore {
  private local = new LocalDraftStore();

  private snapRef(mapId: string) {
    return doc(db(), "projects", mapId, "snapshots", "current");
  }

  async load(mapId: string): Promise<CanvasState | null> {
    const { state } = await this.loadWithMeta(mapId);
    return state;
  }

  async loadWithMeta(mapId: string): Promise<{ state: CanvasState | null; savedAt: number }> {
    try {
      const snap = await cGetDoc(this.snapRef(mapId));
      if (snap.exists()) {
        const data = snap.data() as {
          payload?: CanvasState;
          payloadRef?: string;
          payloadUrl?: string;
          savedAt?: { toMillis?: () => number };
        };
        const savedAt = data.savedAt?.toMillis?.() ?? 0;

        // External payload API format — solo/draft boards only (see save()).
        if (data.payloadRef && data.payloadUrl) {
          const state = await loadPayload(data.payloadRef, data.payloadUrl);
          await this.local.save(mapId, state);
          return { state, savedAt };
        }

        // Inline format — used for live sessions, workspace rooms, and group
        // boards (saved with { inline: true }), and for legacy boards saved
        // before the external payload API existed.
        if (data?.payload?.objects) {
          await this.local.save(mapId, data.payload);
          return { state: data.payload, savedAt };
        }
      }
    } catch (e) {
      console.warn("Remote load failed, falling back to local cache", e);
    }
    const local = await this.local.load(mapId);
    return { state: local, savedAt: 0 };
  }

  async save(mapId: string, state: CanvasState, opts?: { inline?: boolean }): Promise<void> {
    // Always update the local fallback first so offline editing never loses data.
    await this.local.save(mapId, state);

    if (opts?.inline) {
      // Live sessions, workspace rooms, and group boards: store the full
      // state directly in the Firestore doc. These boards are short-lived
      // and read/written every couple of seconds by every participant —
      // routing them through the external payload API (extra network hop,
      // a shared bearer token, a third-party server) is unnecessary and,
      // if that token/service isn't configured, makes multi-user sync
      // silently do nothing (this was the actual bug: nobody ever saw
      // anyone else's changes, in rooms OR live sessions, because THIS
      // save path used to be identical to the solo/draft one below and
      // would bail out before ever touching Firestore whenever the
      // external API call failed).
      try {
        // Firestore's setDoc() throws on ANY undefined field value,
        // anywhere in the object graph — one shape with an optional prop
        // left as `undefined` (instead of omitted or null) is enough to
        // make every single save silently fail from then on, which looks
        // exactly like "live sync stopped working". JSON round-tripping
        // is the simplest reliable way to strip undefined at every depth
        // (JSON.stringify omits undefined-valued keys entirely).
        const sanitized = JSON.parse(JSON.stringify(state)) as CanvasState;
        await cSetDoc(
          this.snapRef(mapId),
          {
            payload: sanitized,
            // Clear any stale external-payload pointer so load() doesn't
            // prefer an old external copy over this fresher inline one.
            payloadRef: null,
            payloadUrl: null,
            schemaVersion: 1,
            isCurrent: true,
            savedAt: serverTimestamp(),
          },
          { merge: true },
        );
      } catch (e) {
        console.warn("Inline live-board save failed", e);
      }
      return;
    }

    // Step 1: upload full JSON to the external API.
    let result: Awaited<ReturnType<typeof savePayload>>;
    try {
      result = await savePayload(state);
    } catch (e) {
      // Do NOT write a partial/broken metadata doc — leave Firestore alone
      // and surface the failure. Local copy is still safe.
      console.warn("External payload save failed (kept local copy)", e);
      if (!cloudWarnedThisSession) {
        cloudWarnedThisSession = true;
        toast.error(
          "Η αποθήκευση στο cloud δεν είναι διαθέσιμη. Οι αλλαγές αποθηκεύονται μόνο σε αυτή τη συσκευή.",
        );
      }
      return;
    }

    // Step 2: write the lightweight metadata pointer in Firestore.
    try {
      await cSetDoc(
        this.snapRef(mapId),
        {
          payloadRef: result.payloadRef,
          payloadUrl: result.payloadUrl,
          payloadSize: result.size,
          schemaVersion: 1,
          isCurrent: true,
          savedAt: serverTimestamp(),
        },
        { merge: true },
      );
      if (cloudWarnedThisSession) {
        cloudWarnedThisSession = false;
        toast.success("Η αποθήκευση στο cloud αποκαταστάθηκε.");
      }
    } catch (e) {
      console.warn("Firestore metadata save failed (kept local copy)", e);
      if (!cloudWarnedThisSession) {
        cloudWarnedThisSession = true;
        toast.error("Η αποθήκευση στο cloud δεν είναι διαθέσιμη αυτή τη στιγμή.");
      }
    }
  }

  /** Read the current metadata doc and ask the external API to delete its
   *  payload. Best-effort — never throws. Call from project-delete flows.
   *  NOTE: there is currently no delete-project flow in projects.ts; this
   *  method exists so it can be wired in as a follow-up without revisiting
   *  the storage layer. */
  async deleteRemotePayload(mapId: string): Promise<void> {
    try {
      const snap = await cGetDoc(this.snapRef(mapId));
      if (!snap.exists()) return;
      const data = snap.data() as { payloadRef?: string };
      if (data.payloadRef) {
        await deletePayload(data.payloadRef);
      }
    } catch (e) {
      console.warn("deleteRemotePayload failed", e);
    }
  }
}

export const mapStore: MapStore = new FirestoreMapStore();
