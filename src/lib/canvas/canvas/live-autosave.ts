// live-autosave.ts
// Handles micro-saves during live sessions and safe final save on session end.
//
// Live/collaborative board snapshots are stored INLINE in Firestore (the
// mapStore { inline: true } mode) — NOT via the external payload API
// (payload-api.ts). That external API needs its own bearer token/server and
// is meant for solo/draft boards only; routing live boards through it made
// multi-user sync silently do nothing whenever that token/service wasn't
// available, since a failed external save meant Firestore was never updated
// at all, so no other participant's poll ever saw a change.
//
// Every participant with active edit permission may write the shared
// live snapshot (the teacher on the main board, or any member of a group
// while co-editing that group's board). Read-only participants only poll
// for remote changes. See live.$sessionId.tsx's liveOwner computation.
// Micro-saves every AUTOSAVE_INTERVAL_MS so there's always a recent snapshot
// even if the session crashes or is force-closed.

import { mapStore } from "./storage";
import type { CanvasState } from "./types";

const AUTOSAVE_INTERVAL_MS = 30_000; // 30 seconds

export interface LiveAutosaveOptions {
  mapId: string;
  isOwner: boolean;
  isActive: boolean; // session is active (not ended)
  getState: () => CanvasState;
  onSaveStatus?: (status: "saving" | "saved" | "error") => void;
}

/** Start a micro-save interval for a live board.
 *  Returns a cleanup function to stop it. */
export function startLiveAutosave(opts: LiveAutosaveOptions): () => void {
  if (!opts.isOwner || !opts.isActive) return () => {};

  let cancelled = false;
  let lastSavedHash = "";

  const save = async () => {
    if (cancelled) return;
    const state = opts.getState();
    const hash = simpleHash(state);
    if (hash === lastSavedHash) return; // nothing changed
    opts.onSaveStatus?.("saving");
    try {
      await mapStore.save(opts.mapId, state, { inline: true });
      lastSavedHash = hash;
      opts.onSaveStatus?.("saved");
    } catch (e) {
      console.warn(`[live-autosave] micro-save failed for ${opts.mapId}`, e);
      opts.onSaveStatus?.("error");
    }
  };

  const interval = window.setInterval(save, AUTOSAVE_INTERVAL_MS);
  // First save shortly after start
  const initial = window.setTimeout(save, 3000);

  return () => {
    cancelled = true;
    window.clearInterval(interval);
    window.clearTimeout(initial);
  };
}

/** Force-save a board snapshot to the server. Retries up to maxRetries times.
 *  Used before ending a live session to ensure data is safe. */
export async function forceSaveBoard(
  mapId: string,
  state: CanvasState,
  maxRetries = 3,
): Promise<{ ok: boolean; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await mapStore.save(mapId, state, { inline: true });
      return { ok: true };
    } catch (e) {
      console.warn(`[live-autosave] forceSave attempt ${attempt}/${maxRetries} failed for ${mapId}`, e);
      if (attempt < maxRetries) {
        await delay(attempt * 1000); // exponential backoff: 1s, 2s
      }
    }
  }
  return { ok: false, error: `Failed after ${maxRetries} attempts` };
}

/** Force-save multiple boards in parallel, return results. */
export async function forceSaveAllBoards(
  boards: Array<{ mapId: string; state: CanvasState; label: string }>,
): Promise<{ saved: string[]; failed: string[] }> {
  const results = await Promise.allSettled(
    boards.map(async (b) => {
      const r = await forceSaveBoard(b.mapId, b.state);
      if (!r.ok) throw new Error(r.error);
      return b.label;
    }),
  );
  const saved: string[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") saved.push(boards[i].label);
    else failed.push(boards[i].label);
  });
  return { saved, failed };
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function simpleHash(state: CanvasState): string {
  return `${state.objects.length}:${state.objects.map((o) => o.id + (o as { updatedAt?: number }).updatedAt).join(",")}`;
}
