// storage.ts — canvas board persistence.
//
// Two paths, chosen by the caller via opts.inline:
//
//  DEFAULT (personal/solo boards, opts.inline falsy): the full board JSON
//  is uploaded to the external "Unity Map API" payload server; Firestore
//  only ever stores a small pointer (payloadRef/payloadUrl/size) plus
//  metadata. This keeps Firestore document size and read/write costs low
//  regardless of individual board size — important at scale (many
//  students, cost-conscious architecture).
//
//  INLINE (opts.inline === true — live sessions, group boards): the full
//  payload is written directly into the Firestore doc. These boards are
//  short-lived, saved/read every couple of seconds by every participant,
//  and need lower latency than an extra network hop to the payload API
//  would allow.
//
// CRITICAL SAFETY RULES (both paths):
//  1. Never write Firestore metadata claiming a save succeeded unless the
//     underlying write is independently confirmed. For the default path
//     that means: never write Firestore at all if the external upload
//     failed. For the Firestore write itself (both paths), a fresh
//     server read afterwards must confirm the write actually landed —
//     Firestore's setDoc()/updateDoc() promises resolve as soon as a
//     write lands in the LOCAL cache, well before (and independent of)
//     the real server round trip, so a security-rule rejection can
//     happen silently in the background after the promise "succeeds".
//  2. Reads always prefer a fresh server read over Firestore's local
//     cache, for the same reason — a cached read can show stale content
//     that doesn't reflect a save which happened in another session.
//  3. Comparisons for verification are key-order-independent — Firestore
//     doesn't guarantee it returns fields in the exact order they were
//     sent, even for genuinely identical content, so a naive
//     JSON.stringify comparison can false-positive.

import { doc, serverTimestamp, getDocFromServer } from "firebase/firestore";
import { toast } from "sonner";
import { db } from "../firebase";
import { cGetDoc, cSetDoc } from "../quota-guard";
import type { CanvasState } from "./types";
import { deletePayload, loadPayload, savePayload } from "./payload-api";

const LOCAL_PREFIX = "ums:canvas:";
function KEY(mapId: string): string {
  return `${LOCAL_PREFIX}${mapId}`;
}

/** Emergency local fallback — never the source of truth, just keeps the
 *  most recent state reachable on this device if the network/server is
 *  unavailable. */
class LocalMapStore {
  async save(mapId: string, state: CanvasState): Promise<void> {
    try {
      window.localStorage.setItem(KEY(mapId), JSON.stringify(state));
    } catch (e) {
      console.warn("Local save failed", e);
    }
  }
  async load(mapId: string): Promise<CanvasState | null> {
    try {
      const raw = window.localStorage.getItem(KEY(mapId));
      return raw ? (JSON.parse(raw) as CanvasState) : null;
    } catch {
      return null;
    }
  }
  async delete(mapId: string): Promise<void> {
    try {
      window.localStorage.removeItem(KEY(mapId));
    } catch {
      /* */
    }
  }
}

/** JSON.stringify is sensitive to object key ORDER — two objects with
 *  identical content but differently-ordered keys produce different
 *  strings. Firestore doesn't guarantee it returns fields in the exact
 *  order they were sent, so a raw JSON.stringify comparison used for
 *  save-verification could false-positive on a perfectly successful
 *  write. This recursively sorts object keys at every depth before
 *  stringifying, so the comparison only fails on genuine content
 *  differences. (Array order is left untouched — it's meaningful, e.g.
 *  z-index/paint order of canvas objects.) */
function canonicalStringify(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) sorted[k] = sortKeys(obj[k]);
      return sorted;
    }
    return v;
  };
  return JSON.stringify(sortKeys(value));
}

// Per-session "already warned" flag — don't spam a toast on every
// debounced save attempt while a problem persists.
let cloudWarnedThisSession = false;

export class FirestoreMapStore {
  private local = new LocalMapStore();

  private snapRef(mapId: string) {
    return doc(db(), "projects", mapId, "snapshots", "current");
  }

  async save(mapId: string, state: CanvasState, opts?: { inline?: boolean }): Promise<void> {
    // Always update the local fallback first so offline editing never loses data.
    await this.local.save(mapId, state);

    // Firestore's setDoc() throws on ANY undefined field value anywhere in
    // the object graph. JSON round-tripping strips those (JSON.stringify
    // omits undefined-valued keys entirely) — the simplest reliable fix.
    const sanitized = JSON.parse(JSON.stringify(state)) as CanvasState;

    if (opts?.inline) {
      await this.saveInline(mapId, sanitized);
      return;
    }
    await this.saveExternal(mapId, sanitized);
  }

  /** Live sessions, group boards: full payload written directly into the
   *  Firestore doc. Short-lived, frequently saved — the extra network hop
   *  to the payload API isn't worth it here. */
  private async saveInline(mapId: string, sanitized: CanvasState): Promise<void> {
    try {
      await cSetDoc(
        this.snapRef(mapId),
        {
          payload: sanitized,
          payloadRef: null,
          payloadUrl: null,
          payloadSize: null,
          schemaVersion: 1,
          isCurrent: true,
          savedAt: serverTimestamp(),
        },
        { merge: true },
      );
    } catch (e) {
      console.warn("Inline live-board save failed", e);
    }
  }

  /** Personal/solo boards: upload the full JSON externally first, then
   *  write only a small pointer + metadata into Firestore. Never writes
   *  Firestore at all if the external upload failed. */
  private async saveExternal(mapId: string, sanitized: CanvasState): Promise<void> {
    let uploaded: { payloadRef: string; payloadUrl: string; size: number };
    try {
      uploaded = await savePayload(sanitized);
    } catch (e) {
      console.error("External payload upload failed — Firestore metadata was NOT touched.", e);
      if (!cloudWarnedThisSession) {
        cloudWarnedThisSession = true;
        toast.error(
          "Η αποθήκευση απέτυχε — δεν ήταν δυνατή η σύνδεση με τον server αποθήκευσης. Οι αλλαγές σας παραμένουν μόνο σε αυτή τη συσκευή.",
        );
      }
      throw e;
    }

    const metadata = {
      payloadRef: uploaded.payloadRef,
      payloadUrl: uploaded.payloadUrl,
      payloadSize: uploaded.size,
      // Clear any stale inline payload from a legacy/earlier save so
      // load() doesn't prefer old inline content over this fresh pointer.
      payload: null,
      schemaVersion: 1,
      isCurrent: true,
      savedAt: serverTimestamp(),
    };

    try {
      await cSetDoc(this.snapRef(mapId), metadata, { merge: true });
    } catch (e) {
      console.error("Firestore metadata write failed after a successful external upload.", e);
      toast.error(
        "Το περιεχόμενο αποθηκεύτηκε στον server, αλλά η καταγραφή στη βάση απέτυχε. Δοκιμάστε ξανά.",
      );
      throw e;
    }

    await this.verifyMetadataWrite(mapId, uploaded.payloadRef);

    if (cloudWarnedThisSession) {
      cloudWarnedThisSession = false;
      toast.success("Η αποθήκευση αποκαταστάθηκε.");
    }
  }

  /** setDoc() resolves as soon as the write lands in Firestore's LOCAL
   *  cache — before (and independent of) the actual server round trip.
   *  If a security rule rejects the write server-side, that happens
   *  silently in the background; this promise has already resolved
   *  "successfully" by then. Force a server read (bypassing the local
   *  cache) and confirm it reflects the payloadRef we just wrote. One
   *  retry after a short delay covers brief replication lag before
   *  concluding it's a genuine, persistent rejection. */
  private async verifyMetadataWrite(mapId: string, expectedPayloadRef: string): Promise<void> {
    const checkOnce = async (): Promise<boolean> => {
      const serverSnap = await getDocFromServer(this.snapRef(mapId));
      const data = serverSnap.exists() ? (serverSnap.data() as { payloadRef?: string }) : undefined;
      return canonicalStringify(data?.payloadRef ?? null) === canonicalStringify(expectedPayloadRef);
    };

    let verified = false;
    let readFailure: unknown = null;
    try {
      verified = await checkOnce();
    } catch (e) {
      readFailure = e;
    }

    if (!verified && !readFailure) {
      console.warn("Save verification mismatch on first attempt — retrying once after a short delay", { mapId });
      await new Promise((r) => setTimeout(r, 900));
      try {
        verified = await checkOnce();
      } catch (e) {
        readFailure = e;
      }
    }

    if (readFailure) {
      const code = (readFailure as { code?: string })?.code ?? "unknown";
      console.error("Save verification READ itself failed (not the write) — code:", code, readFailure);
      toast.error(`Δεν ήταν δυνατή η επιβεβαίωση αποθήκευσης (${code}). Δοκιμάστε ξανά.`);
      const wrapped = new Error(`Verification read failed: ${code}`);
      (wrapped as Error & { isWriteVerificationFailure?: boolean }).isWriteVerificationFailure = true;
      throw wrapped;
    }
    if (!verified) {
      console.error("Save verification MISMATCH even after retry — persistent rejection, not a timing fluke.", {
        mapId,
      });
      toast.error(
        "Η αποθήκευση δεν ολοκληρώθηκε στη βάση — δεν έχετε δικαίωμα εγγραφής εδώ. Οι αλλαγές σας ΔΕΝ αποθηκεύτηκαν.",
      );
      const mismatchErr = new Error("Firestore metadata write rejected (verification mismatch, persisted through retry)");
      (mismatchErr as Error & { isWriteVerificationFailure?: boolean }).isWriteVerificationFailure = true;
      throw mismatchErr;
    }
  }

  /** Always prefers a fresh server read over Firestore's local cache (see
   *  the module-level note on why). Falls back to the regular
   *  cache-tolerant read only if the server round-trip itself fails
   *  (e.g. offline), and to the local device cache if even that fails. */
  async loadWithMeta(mapId: string): Promise<{ state: CanvasState | null; savedAt: number }> {
    try {
      let snap;
      try {
        snap = await getDocFromServer(this.snapRef(mapId));
      } catch {
        snap = await cGetDoc(this.snapRef(mapId));
      }
      if (snap.exists()) {
        const data = snap.data() as {
          payload?: CanvasState;
          payloadRef?: string;
          payloadUrl?: string;
          savedAt?: { toMillis?: () => number };
        };
        const savedAt = data.savedAt?.toMillis?.() ?? 0;

        // External payload — the default format for personal/solo boards.
        if (data.payloadRef && data.payloadUrl) {
          const state = await loadPayload(data.payloadRef, data.payloadUrl);
          await this.local.save(mapId, state);
          return { state, savedAt };
        }

        // Inline payload — live sessions, group boards, or a legacy board
        // saved before the external payload API existed.
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

  async load(mapId: string): Promise<CanvasState | null> {
    const { state } = await this.loadWithMeta(mapId);
    return state;
  }

  /** Best-effort: also deletes the external payload if this board had
   *  one. Never blocks or throws on that part failing — the Firestore
   *  doc itself is what actually controls whether the board still
   *  "exists" from the app's point of view. */
  async delete(mapId: string): Promise<void> {
    try {
      const snap = await cGetDoc(this.snapRef(mapId));
      const data = snap.exists() ? (snap.data() as { payloadRef?: string }) : undefined;
      if (data?.payloadRef) {
        deletePayload(data.payloadRef).catch((e) => console.warn("External payload delete failed", e));
      }
    } catch (e) {
      console.warn("Could not check for an external payload to delete", e);
    }
    await this.local.delete(mapId);
  }
}

export const mapStore = new FirestoreMapStore();
