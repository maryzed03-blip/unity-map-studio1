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

import { doc, serverTimestamp, getDocFromServer } from "firebase/firestore";
import { toast } from "sonner";
import { db } from "../firebase";
import { cGetDoc, cSetDoc } from "../quota-guard";
import { emptyCanvasState, type CanvasState } from "./types";
import { deletePayload, loadPayload } from "./payload-api";

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

  async save(mapId: string, state: CanvasState, _opts?: { inline?: boolean }): Promise<void> {
    // Always update the local fallback first so offline editing never loses data.
    await this.local.save(mapId, state);

    // Always save directly into the Firestore doc (the old "inline" path,
    // now used unconditionally). Previously, solo/draft boards went
    // through an external payload API first — but if that service or its
    // token wasn't configured, the save would silently only reach this
    // device's localStorage, never Firestore. That's what caused boards
    // to open completely empty for anyone else (a collaborator, or
    // someone the project was sent to) even though the sender saw no
    // error. Firestore's 1MB/doc limit is comfortably more than this
    // app's typical canvas size, so there's no real downside to just
    // always writing here directly.
    try {
      // Firestore's setDoc() throws on ANY undefined field value,
      // anywhere in the object graph — one shape with an optional prop
      // left as `undefined` (instead of omitted or null) is enough to
      // make every single save silently fail from then on, which looks
      // exactly like "sync stopped working". JSON round-tripping is the
      // simplest reliable way to strip undefined at every depth
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
      // setDoc() resolves as soon as the write lands in Firestore's LOCAL
      // cache — well before (and independent of) the actual server round
      // trip. If the security rules reject the write server-side, that
      // rejection happens silently in the background; this promise has
      // already resolved "successfully" by then. Force a server read
      // (bypassing the local cache entirely) and compare against what
      // was just sent — if they don't match, the write never actually
      // reached the server, and the person needs to know that NOW, not
      // days later when the "saved" content quietly reverts.
      let serverSnap;
      try {
        serverSnap = await getDocFromServer(this.snapRef(mapId));
      } catch (readErr) {
        const code = (readErr as { code?: string })?.code ?? "unknown";
        console.error("Save verification READ itself failed (not the write) — code:", code, readErr);
        toast.error(`Δεν ήταν δυνατή η επιβεβαίωση αποθήκευσης (${code}). Δοκιμάστε ξανά.`);
        const wrapped = new Error(`Verification read failed: ${code}`);
        (wrapped as Error & { isWriteVerificationFailure?: boolean }).isWriteVerificationFailure = true;
        throw wrapped;
      }
      const serverPayload = serverSnap.exists() ? (serverSnap.data() as { payload?: CanvasState }).payload : undefined;
      if (JSON.stringify(serverPayload) !== JSON.stringify(sanitized)) {
        console.error(
          "Save verification MISMATCH — the write reached the local cache but not the server.",
          { mapId, serverPayloadObjectCount: Array.isArray(serverPayload?.objects) ? serverPayload.objects.length : "n/a", sentObjectCount: sanitized.objects.length },
        );
        toast.error(
          "Η αποθήκευση δεν ολοκληρώθηκε στον server — δεν έχετε δικαίωμα εγγραφής εδώ. Οι αλλαγές σας ΔΕΝ αποθηκεύτηκαν.",
        );
        const mismatchErr = new Error("Server rejected the write (content mismatch after save)");
        (mismatchErr as Error & { isWriteVerificationFailure?: boolean }).isWriteVerificationFailure = true;
        throw mismatchErr;
      }
      if (cloudWarnedThisSession) {
        cloudWarnedThisSession = false;
        toast.success("Η αποθήκευση στο cloud αποκαταστάθηκε.");
      }
    } catch (e) {
      // A failed write-verification already showed its own specific toast
      // and MUST propagate to the caller (e.g. the Save button), so the
      // UI never shows "saved" for a write that never actually reached
      // the server. Only genuine offline/network failures fall through
      // to the generic "saved locally only" message below.
      if ((e as Error & { isWriteVerificationFailure?: boolean })?.isWriteVerificationFailure) {
        throw e;
      }
      console.warn("Cloud save failed (kept local copy)", e);
      if (!cloudWarnedThisSession) {
        cloudWarnedThisSession = true;
        toast.error(
          "Η αποθήκευση στο cloud δεν είναι διαθέσιμη. Οι αλλαγές αποθηκεύονται μόνο σε αυτή τη συσκευή.",
        );
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
