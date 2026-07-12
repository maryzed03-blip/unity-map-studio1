// Pure live-board merge policy, extracted from CanvasStage so it can be
// unit-tested without mounting React. Last-write-wins per-object, NOT a CRDT.
//
// Inputs:
//   local          — current local objects (in-memory state)
//   remote         — objects from the latest remote snapshot
//   seenRemoteIds  — set of every object id we have seen in any PREVIOUS
//                    remote snapshot. Mutated by this call to include
//                    the current snapshot's ids before returning.
//   recentWindowMs — local objects with createdAt newer than
//                    (nowMs - recentWindowMs) are kept even if absent
//                    from the remote snapshot.
//   nowMs          — clock injection for deterministic tests.
//
// Policy:
//   - Take all remote objects as-is.
//   - For each local object NOT in the current remote snapshot:
//       * Keep it if its id was never seen in any prior remote snapshot
//         (genuinely new local addition that hasn't been synced yet).
//       * Keep it if it was created within the recent window (the remote
//         simply hasn't caught up yet).
//       * Otherwise drop it — its id was previously seen remotely but is
//         now absent, which we treat as a remote delete.

import type { CanvasObject } from "./types";

export function mergeLiveObjects(
  local: CanvasObject[],
  remote: CanvasObject[],
  seenRemoteIds: Set<string>,
  recentWindowMs: number,
  nowMs: number = Date.now(),
): CanvasObject[] {
  // Snapshot "seen before THIS call" before we fold in the current ids.
  // We need this to distinguish "this id is in current remote" (continue)
  // from "this id was in a prior remote but no longer" (delete).
  const remoteIds = new Set(remote.map((o) => o.id));
  const merged: CanvasObject[] = [...remote];
  for (const lo of local) {
    if (remoteIds.has(lo.id)) continue;
    const seenBefore = seenRemoteIds.has(lo.id);
    const recentlyCreated =
      typeof lo.createdAt === "number" && nowMs - lo.createdAt < recentWindowMs;
    if (!seenBefore || recentlyCreated) {
      merged.push(lo);
    }
    // else: previously seen remotely, now absent → drop as remote delete.
  }
  // Update seen set with current snapshot ids for next call.
  for (const id of remoteIds) seenRemoteIds.add(id);
  return merged;
}
