// Χώροι Εργασίας — Global, permanent, 5 rooms always exist.
// These are the PUBLIC, standalone co-working spaces shown in the lobby.
// They work independently of any live session. For teacher-led breakout
// teams inside a live session, see the separate GroupRoom system in
// live-sessions.ts (session-scoped, not this file).
//
// Firestore structure:
//   /workspaceRooms/{roomId}  (5 docs, IDs: room-1 to room-5)
//     name: "Χώρος 1"
//     boardId: string          ← permanent canvas for this room
//     occupants: string[]      ← current UIDs inside (max 5)
//     occupantNames: Record<uid, displayName>
//     tokenHolder: string|null ← uid who has edit (the "σκυτάλη")
//     tokenRequesterId: string|null  ← uid who requested token
//     tokenRequesterName: string|null
//     tokenRequestedAt: Timestamp|null
//     lastActivityAt: Timestamp
//     sessionParticipants: string[]  ← all who were in THIS session (for draft save on empty)
//     activeSessionId: string|null   ← if a live session is currently using this room,
//                                      locks it so a second, concurrent session can't
//                                      collide with it. Cleared when the room empties.

import {
  collection,
  doc,
  onSnapshot,
  updateDoc,
  arrayUnion,
  arrayRemove,
  serverTimestamp,
  getDoc,
  getDocs,
  setDoc,
} from "firebase/firestore";
import { db } from "./firebase";

export const ROOM_COUNT = 5;
export const ROOM_MAX_OCCUPANTS = 5;
export const TOKEN_AUTO_ACCEPT_MS = 30_000;  // 30s
export const TOKEN_FREE_MS = 60_000;          // 60s free baton
// A room occupant not seen "online" in presence for longer than this is
// considered disconnected and is auto-removed by the reconciliation hook.
export const OFFLINE_GRACE_MS = 15_000;

export interface WorkspaceRoom {
  id: string;
  name: string;
  boardId: string;
  occupants: string[];           // regular students (max 5)
  teacherOccupants: string[];    // invisible teacher slots (unlimited)
  occupantNames: Record<string, string>;
  tokenHolder: string | null;
  tokenRequesterId: string | null;
  tokenRequesterName: string | null;
  tokenRequestedAt: unknown;
  lastActivityAt: unknown;
  sessionParticipants: string[];
  activeSessionId: string | null;
}

// ── Bootstrap (called once on app init if rooms don't exist) ──────────

export async function bootstrapRooms(creatorUid: string): Promise<void> {
  const { createProject } = await import("./projects");
  for (let i = 1; i <= ROOM_COUNT; i++) {
    const roomId = `room-${i}`;
    const ref = doc(db(), "workspaceRooms", roomId);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      const boardId = await createProject(
        creatorUid,
        `Χώρος ${i}`,
        "collaborative",
        "free-drawing",
      );
      // Mark this project as a workspace room board so it doesn't appear in "Τα Έργα μου"
      const { doc: firestoreDoc, updateDoc: firestoreUpdate } = await import("firebase/firestore");
      const { db: getDb } = await import("./firebase");
      await firestoreUpdate(firestoreDoc(getDb(), "projects", boardId), { isWorkspaceRoom: true });
      await setDoc(ref, {
        name: `Χώρος ${i}`,
        boardId,
        occupants: [],
        teacherOccupants: [],
        occupantNames: {},
        tokenHolder: null,
        tokenRequesterId: null,
        tokenRequesterName: null,
        tokenRequestedAt: null,
        lastActivityAt: serverTimestamp(),
        sessionParticipants: [],
        activeSessionId: null,
      });
    } else {
      // Backfill: older room docs created before these fields existed.
      const data = snap.data() as Partial<WorkspaceRoom>;
      const patch: Record<string, unknown> = {};
      if (data.activeSessionId === undefined) patch.activeSessionId = null;
      if (Object.keys(patch).length > 0) {
        await setDoc(ref, patch, { merge: true });
      }
      // Critical: the linked project board must be flagged isWorkspaceRoom
      // so the editor route knows to force liveSync on for it. Rooms
      // created before that flag existed never got it set (it was only
      // written inside the "create new room" branch above), so it must be
      // backfilled here every time too, not just once.
      if (data.boardId) {
        const { doc: firestoreDoc, updateDoc: firestoreUpdate, getDoc: firestoreGetDoc } = await import(
          "firebase/firestore"
        );
        const { db: getDb } = await import("./firebase");
        const projectRef = firestoreDoc(getDb(), "projects", data.boardId);
        const projectSnap = await firestoreGetDoc(projectRef);
        if (projectSnap.exists() && !(projectSnap.data() as { isWorkspaceRoom?: boolean }).isWorkspaceRoom) {
          await firestoreUpdate(projectRef, { isWorkspaceRoom: true }).catch((e) =>
            console.warn(`Failed to backfill isWorkspaceRoom for ${roomId}`, e),
          );
        }
      }
    }
  }
}

// ── Subscribe ──────────────────────────────────────────────────────────

export function subscribeRooms(cb: (rooms: WorkspaceRoom[]) => void): () => void {
  return onSnapshot(collection(db(), "workspaceRooms"), (snap) => {
    const rooms = snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as Omit<WorkspaceRoom, "id">) }))
      .sort((a, b) => {
        const ai = parseInt(a.id.split("-")[1]);
        const bi = parseInt(b.id.split("-")[1]);
        return ai - bi;
      });
    cb(rooms);
  });
}

// ── Enter / Leave ──────────────────────────────────────────────────────

export async function enterRoom(
  roomId: string,
  uid: string,
  displayName: string,
  isTeacher = false,
  /** Pass the current live session id when entering from inside a live session,
   *  so the room gets locked to that session while occupied. Omit for
   *  standalone/lobby use (no lock). */
  sessionId?: string | null,
): Promise<{ ok: boolean; reason?: string }> {
  const ref = doc(db(), "workspaceRooms", roomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return { ok: false, reason: "Ο χώρος δεν βρέθηκε" };
  const room = snap.data() as Omit<WorkspaceRoom, "id">;

  const hasOccupants = room.occupants.length > 0 || (room.teacherOccupants ?? []).length > 0;
  if (
    sessionId &&
    room.activeSessionId &&
    room.activeSessionId !== sessionId &&
    hasOccupants
  ) {
    return { ok: false, reason: "Ο χώρος χρησιμοποιείται αυτή τη στιγμή από άλλο ζωντανό μάθημα" };
  }

  if (isTeacher) {
    // Teacher occupies invisible slot — always allowed
    if ((room.teacherOccupants ?? []).includes(uid)) return { ok: true };
    await updateDoc(ref, {
      teacherOccupants: arrayUnion(uid),
      [`occupantNames.${uid}`]: displayName,
      lastActivityAt: serverTimestamp(),
      ...(sessionId ? { activeSessionId: sessionId } : {}),
    });
    return { ok: true };
  }

  if (room.occupants.includes(uid)) return { ok: true };
  if (room.occupants.length >= ROOM_MAX_OCCUPANTS) return { ok: false, reason: "Ο χώρος είναι πλήρης (5/5)" };

  const isFirst = room.occupants.length === 0;
  await updateDoc(ref, {
    occupants: arrayUnion(uid),
    [`occupantNames.${uid}`]: displayName,
    sessionParticipants: arrayUnion(uid),
    tokenHolder: isFirst ? uid : room.tokenHolder,
    lastActivityAt: serverTimestamp(),
    ...(sessionId ? { activeSessionId: sessionId } : {}),
  });
  return { ok: true };
}

export async function leaveRoom(
  roomId: string,
  uid: string,
  isTeacher = false,
  /** Skip the personal-library save. Used when the TEACHER's client is
   *  relocating a student (moveStudentToRoom) — a cross-user save would be
   *  rejected by Firestore rules anyway (only the room's own client can
   *  create a project owned by that uid). Real self-initiated leaves and
   *  disconnects always save normally. */
  opts?: { skipPersonalSave?: boolean },
): Promise<void> {
  const ref = doc(db(), "workspaceRooms", roomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const room = snap.data() as Omit<WorkspaceRoom, "id">;

  if (isTeacher) {
    await updateDoc(ref, {
      teacherOccupants: arrayRemove(uid),
      lastActivityAt: serverTimestamp(),
    });
    return;
  }

  // Save a personal, dated copy of the board for the person actually leaving —
  // regardless of whether anyone else is still inside the room.
  if (!opts?.skipPersonalSave) {
    await saveRoomCopyForUser(uid, room.boardId, room.name);
  }

  const newOccupants = room.occupants.filter((id) => id !== uid);
  const newNames = { ...room.occupantNames };
  delete newNames[uid];

  let newTokenHolder = room.tokenHolder;
  if (room.tokenHolder === uid) {
    if (room.tokenRequesterId && newOccupants.includes(room.tokenRequesterId)) {
      newTokenHolder = room.tokenRequesterId;
    } else if (newOccupants.length > 0) {
      newTokenHolder = newOccupants[0];
    } else {
      newTokenHolder = null;
    }
  }

  const updates: Record<string, unknown> = {
    occupants: arrayRemove(uid),
    [`occupantNames.${uid}`]: null,
    tokenHolder: newTokenHolder,
    tokenRequesterId: newOccupants.includes(room.tokenRequesterId ?? "") ? room.tokenRequesterId : null,
    tokenRequesterName: newOccupants.includes(room.tokenRequesterId ?? "") ? room.tokenRequesterName : null,
    lastActivityAt: serverTimestamp(),
  };

  if (newOccupants.length === 0 && (room.teacherOccupants ?? []).length === 0) {
    updates.sessionParticipants = [];
    updates.tokenHolder = null;
    updates.tokenRequesterId = null;
    updates.tokenRequesterName = null;
    updates.tokenRequestedAt = null;
    updates.activeSessionId = null; // unlock the room for other sessions
    await resetRoomBoard(room.boardId);
  }

  await updateDoc(ref, updates);
}

/**
 * Save an individual, timestamped copy of a room's current board into the
 * given user's own library/drafts, tagged with where it came from. Called
 * every time a person leaves or disconnects from a public Χώρος Εργασίας —
 * not only when the room becomes empty. Skips silently if the board is
 * still blank (nothing worth keeping) or the save fails.
 */
async function saveRoomCopyForUser(
  uid: string,
  boardId: string,
  roomName: string,
): Promise<void> {
  try {
    const { mapStore } = await import("./canvas/storage");
    const state = await mapStore.load(boardId);
    if (!state || state.objects.length === 0) return; // empty board — nothing to save

    const { createProject } = await import("./projects");
    const { doc: firestoreDoc, updateDoc: firestoreUpdate, serverTimestamp: ts } = await import(
      "firebase/firestore"
    );
    const { db: getDb } = await import("./firebase");

    const dateLabel = new Date().toLocaleDateString("el-GR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    const title = `${roomName} · ${dateLabel}`;
    const newId = await createProject(uid, title, "personal", "free-drawing");
    await mapStore.save(newId, state, { inline: true });
    await firestoreUpdate(firestoreDoc(getDb(), "projects", newId), {
      originLabel: `Χώρος Εργασίας — ${roomName}`,
      savedAt: ts(),
    });
  } catch (e) {
    console.warn(`saveRoomCopyForUser failed for ${uid} in ${roomName}`, e);
  }
}

// ── Token (σκυτάλη) management ─────────────────────────────────────────

export async function requestToken(
  roomId: string,
  uid: string,
  displayName: string,
): Promise<void> {
  await updateDoc(doc(db(), "workspaceRooms", roomId), {
    tokenRequesterId: uid,
    tokenRequesterName: displayName,
    tokenRequestedAt: serverTimestamp(),
    lastActivityAt: serverTimestamp(),
  });
}

export async function respondToTokenRequest(
  roomId: string,
  accept: boolean,
): Promise<void> {
  const ref = doc(db(), "workspaceRooms", roomId);
  const snap = await getDoc(ref);
  if (!snap.exists()) return;
  const room = snap.data() as Omit<WorkspaceRoom, "id">;
  if (!room.tokenRequesterId) return;

  if (accept) {
    await updateDoc(ref, {
      tokenHolder: room.tokenRequesterId,
      tokenRequesterId: null,
      tokenRequesterName: null,
      tokenRequestedAt: null,
      lastActivityAt: serverTimestamp(),
    });
  } else {
    await updateDoc(ref, {
      tokenRequesterId: null,
      tokenRequesterName: null,
      tokenRequestedAt: null,
    });
  }
}

export async function claimFreeToken(roomId: string, uid: string): Promise<void> {
  await updateDoc(doc(db(), "workspaceRooms", roomId), {
    tokenHolder: uid,
    tokenRequesterId: null,
    tokenRequesterName: null,
    tokenRequestedAt: null,
    lastActivityAt: serverTimestamp(),
  });
}

// ── Board reset when room empties ───────────────────────────────────────

async function resetRoomBoard(boardId: string): Promise<void> {
  try {
    const { mapStore } = await import("./canvas/storage");
    const { emptyCanvasState } = await import("./canvas/types");
    await mapStore.save(boardId, emptyCanvasState(), { inline: true });
  } catch (e) {
    console.warn("resetRoomBoard failed", e);
  }
}

/**
 * Client-only "self-heal" for hard disconnects (browser crash, network loss,
 * closing the tab without the beforeunload handler firing in time). There is
 * no backend here, so any currently-open client that is watching both the
 * rooms list and the presence map can notice a stale occupant and clean them
 * up — whichever tab happens to be open first wins, which is fine since
 * leaveRoom() is idempotent.
 *
 * Returns the uids that were removed (for logging/telemetry only).
 */
export async function reconcileOfflineOccupants(
  rooms: WorkspaceRoom[],
  isOnline: (uid: string) => boolean,
  lastSeenAt: (uid: string) => number,
): Promise<string[]> {
  const removed: string[] = [];
  const now = Date.now();
  for (const room of rooms) {
    for (const uid of room.occupants) {
      if (isOnline(uid)) continue;
      if (now - lastSeenAt(uid) < OFFLINE_GRACE_MS) continue; // could be a brief reconnect
      try {
        await leaveRoom(room.id, uid, false, { skipPersonalSave: true });
        removed.push(uid);
      } catch (e) {
        console.warn(`reconcileOfflineOccupants: failed to remove ${uid} from ${room.id}`, e);
      }
    }
    for (const uid of room.teacherOccupants ?? []) {
      if (isOnline(uid)) continue;
      if (now - lastSeenAt(uid) < OFFLINE_GRACE_MS) continue;
      try {
        await leaveRoom(room.id, uid, true);
        removed.push(uid);
      } catch (e) {
        console.warn(`reconcileOfflineOccupants: failed to remove teacher ${uid} from ${room.id}`, e);
      }
    }
  }
  return removed;
}

/** Teacher moves a student from wherever they are to a specific room. */
export async function moveStudentToRoom(
  studentUid: string,
  studentName: string,
  targetRoomId: string,
  allRooms: WorkspaceRoom[],
): Promise<void> {
  // Leave current room if any
  const currentRoom = allRooms.find((r) => r.occupants.includes(studentUid));
  if (currentRoom && currentRoom.id !== targetRoomId) {
    await leaveRoom(currentRoom.id, studentUid, false, { skipPersonalSave: true });
  }
  await enterRoom(targetRoomId, studentUid, studentName, false);
}
