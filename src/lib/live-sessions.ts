// Live classroom flow — Firestore data model.
//
// Quota: all reads/writes go through quota-guard wrappers. The
// onSnapshot subscriptions here are the highest-risk paths under
// classroom load — keep them tight (only subscribe what is currently
// visible, unsubscribe on unmount). Live board content sync is NOT done
// here; it uses periodic getDoc polling in CanvasStage.
//
// A live session always clones the source draft into a fresh board so
// the personal draft is never overwritten.

import {
  collection,
  doc,
  query,
  serverTimestamp,
  where,
  limit,
  arrayUnion,
  arrayRemove,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import { createProject, type WorkspaceType } from "./projects";
import { cAddDoc, cGetDoc, cGetDocs, cOnSnapshot, cUpdateDoc } from "./quota-guard";

export type LiveSessionStatus = "active" | "paused" | "ended";
export type InvitationStatus = "pending" | "accepted" | "declined" | "expired" | "cancelled";

export interface LiveSession {
  id: string;
  teacherId: string;
  teacherName: string;
  title: string;
  workspaceType: WorkspaceType;
  status: LiveSessionStatus;
  mainBoardId: string;
  groupRoomIds: string[];
  participantIds: string[];
  /** UIDs allowed to edit. Creator always has edit. Others are view-only unless listed here. */
  editPermissions?: string[];
  /** When set, all participants see this boardId instead of mainBoardId (presentation mode). */
  presentingBoardId?: string | null;
  /** When set, teacher is presenting this workspace room to all. */
  presentingRoomId?: string | null;
  /** When false, students are returned to mainBoard but groupRooms are preserved. */
  groupRoomsActive?: boolean;
  /** Teacher is currently visiting this groupRoomId (triggers student notification). */
  teacherInRoomId?: string | null;
  createdAt?: unknown;
  updatedAt?: unknown;
  endedAt?: unknown;
}

export interface GroupRoom {
  id: string;
  sessionId: string;
  name: string;
  boardId: string;
  participantIds: string[];
  createdBy: string;
  createdAt?: unknown;
}

export interface Invitation {
  id: string;
  sessionId: string;
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
  status: InvitationStatus;
  createdAt?: unknown;
}

// ---------------------- Sessions ----------------------

export async function createLiveSession(opts: {
  teacherId: string;
  teacherName: string;
  title: string;
  workspaceType: WorkspaceType;
  sourceMapId?: string;
}): Promise<LiveSession> {
  // ── Rule: only one active session per teacher ──────────────────────
  const existing = await cGetDocs(
    query(
      collection(db(), "liveSessions"),
      where("teacherId", "==", opts.teacherId),
      where("status", "==", "active"),
    ),
  );
  if (!existing.empty) {
    throw new Error("Υπάρχει ήδη ενεργό Ζωντανό Μάθημα. Λήξτε το πρώτα πριν δημιουργήσετε νέο.");
  }
  const mainBoardId = await createProject(
    opts.teacherId,
    `[LIVE] ${opts.title}`,
    "session_board",
    opts.workspaceType,
  );
  await cUpdateDoc(doc(db(), "projects", mainBoardId), {
    mode: "live",
    sourceMapId: opts.sourceMapId ?? null,
  });

  const ref = await cAddDoc(collection(db(), "liveSessions"), {
    teacherId: opts.teacherId,
    teacherName: opts.teacherName,
    title: opts.title,
    workspaceType: opts.workspaceType,
    status: "active" as LiveSessionStatus,
    mainBoardId,
    groupRoomIds: [],
    participantIds: [opts.teacherId],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await cUpdateDoc(doc(db(), "projects", mainBoardId), {
    liveSessionId: ref.id,
  });

  const snap = await cGetDoc(ref);
  return { id: ref.id, ...(snap.data() as Omit<LiveSession, "id">) };
}

export async function endLiveSession(sessionId: string, teacherId: string) {
  const sRef = doc(db(), "liveSessions", sessionId);
  const snap = await cGetDoc(sRef);
  if (!snap.exists()) return;
  const data = snap.data() as Omit<LiveSession, "id">;
  if (data.teacherId !== teacherId) throw new Error("Only the teacher can end the session.");

  await cUpdateDoc(sRef, {
    status: "ended",
    endedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await cUpdateDoc(doc(db(), "projects", data.mainBoardId), {
    mode: "collaborativeFinal",
    status: "active_collab",
  });
  const roomsSnap = await cGetDocs(collection(db(), "liveSessions", sessionId, "groupRooms"));
  for (const r of roomsSnap.docs) {
    const g = r.data() as Omit<GroupRoom, "id">;
    await cUpdateDoc(doc(db(), "projects", g.boardId), {
      mode: "collaborativeFinal",
      status: "active_collab",
    }).catch(() => {});
  }
}

export function subscribeMySessions(uid: string, cb: (s: LiveSession[]) => void): Unsubscribe {
  const q = query(collection(db(), "liveSessions"), where("participantIds", "array-contains", uid));
  return cOnSnapshot(q, (snap) => {
    const qs = snap as unknown as {
      docs: Array<{ id: string; data: () => Omit<LiveSession, "id"> }>;
    };
    const rows = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
    rows.sort((a, b) => {
      const at = (a.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      const bt = (b.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      return bt - at;
    });
    cb(rows);
  });
}

/** The teacher's own session, active OR paused (but not ended) — used by
 *  LiveClassButton so a refreshed/reconnected teacher sees "re-enter" (which
 *  auto-resumes on arrival) instead of being offered a brand new session
 *  while their old one sits paused and orphaned. */
export function subscribeTeacherSession(
  teacherId: string,
  cb: (s: LiveSession | null) => void,
): Unsubscribe {
  const q = query(collection(db(), "liveSessions"), where("teacherId", "==", teacherId));
  return cOnSnapshot(q, (snap) => {
    const qs = snap as unknown as {
      docs: Array<{ id: string; data: () => Omit<LiveSession, "id"> }>;
    };
    const row = qs.docs.find((d) => {
      const status = d.data().status;
      return status === "active" || status === "paused";
    });
    cb(row ? { id: row.id, ...row.data() } : null);
  });
}

// ── Single-button live class entry point ────────────────────────────
// This app models one classroom at a time: there is no roster/cohort
// binding a given student to a given teacher, so "the live lesson" is
// simply whichever liveSession is currently active. Used by
// LiveClassButton (replaces the old browsable "live lessons" list).
export function subscribeActiveSession(cb: (s: LiveSession | null) => void): Unsubscribe {
  // Deliberately NOT combined with orderBy: a single equality filter uses
  // Firestore's automatic single-field index, while equality + orderBy on
  // a different field would need a composite index to be created manually
  // in the Firebase console first. "Only one active session per teacher"
  // is already enforced at creation time, so in practice there's at most
  // one result; limit(1) just caps the (rare) multi-teacher edge case.
  const q = query(collection(db(), "liveSessions"), where("status", "==", "active"), limit(1));
  return cOnSnapshot(q, (snap) => {
    const qs = snap as unknown as {
      docs: Array<{ id: string; data: () => Omit<LiveSession, "id"> }>;
    };
    const row = qs.docs[0];
    cb(row ? { id: row.id, ...row.data() } : null);
  });
}

/** Adds a student straight into an already-active session's participant
 *  list — no invitation round-trip. Only meant to be called once the
 *  LiveClassButton has confirmed (via presence) that the teacher is
 *  actually in the room. */
export async function joinLiveSessionDirect(sessionId: string, uid: string): Promise<void> {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    participantIds: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
}

export function subscribeSession(
  sessionId: string,
  cb: (s: LiveSession | null) => void,
): Unsubscribe {
  return cOnSnapshot(doc(db(), "liveSessions", sessionId), (snap) => {
    const ds = snap as unknown as {
      exists: () => boolean;
      id: string;
      data: () => Omit<LiveSession, "id">;
    };
    cb(ds.exists() ? { id: ds.id, ...ds.data() } : null);
  });
}

// ---------------------- Group rooms ----------------------

export async function createGroupRoom(opts: {
  sessionId: string;
  teacherId: string;
  name: string;
  workspaceType: WorkspaceType;
}): Promise<GroupRoom> {
  const boardId = await createProject(
    opts.teacherId,
    `[GROUP] ${opts.name}`,
    "session_board",
    opts.workspaceType,
  );
  await cUpdateDoc(doc(db(), "projects", boardId), {
    mode: "live",
    liveSessionId: opts.sessionId,
  });

  const ref = await cAddDoc(collection(db(), "liveSessions", opts.sessionId, "groupRooms"), {
    sessionId: opts.sessionId,
    name: opts.name,
    boardId,
    participantIds: [],
    createdBy: opts.teacherId,
    createdAt: serverTimestamp(),
  });

  await cUpdateDoc(doc(db(), "liveSessions", opts.sessionId), {
    groupRoomIds: arrayUnion(ref.id),
    updatedAt: serverTimestamp(),
  });

  const snap = await cGetDoc(ref);
  return { id: ref.id, ...(snap.data() as Omit<GroupRoom, "id">) };
}

export function subscribeGroupRooms(
  sessionId: string,
  cb: (rooms: GroupRoom[]) => void,
): Unsubscribe {
  return cOnSnapshot(collection(db(), "liveSessions", sessionId, "groupRooms"), (snap) => {
    const qs = snap as unknown as {
      docs: Array<{ id: string; data: () => Omit<GroupRoom, "id"> }>;
    };
    cb(qs.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function assignToGroup(sessionId: string, roomId: string, studentId: string) {
  const rooms = await cGetDocs(collection(db(), "liveSessions", sessionId, "groupRooms"));
  for (const r of rooms.docs) {
    if (r.id === roomId) continue;
    const data = r.data() as Omit<GroupRoom, "id">;
    if (data.participantIds?.includes(studentId)) {
      await cUpdateDoc(r.ref, { participantIds: arrayRemove(studentId) });
    }
  }
  await cUpdateDoc(doc(db(), "liveSessions", sessionId, "groupRooms", roomId), {
    participantIds: arrayUnion(studentId),
  });
}

export async function removeFromGroup(sessionId: string, roomId: string, studentId: string) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId, "groupRooms", roomId), {
    participantIds: arrayRemove(studentId),
  });
}

export const MAX_GROUP_ROOMS = 10;

export async function deleteGroupRoom(sessionId: string, roomId: string) {
  const { deleteDoc } = await import("firebase/firestore");
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    groupRoomIds: arrayRemove(roomId),
    updatedAt: serverTimestamp(),
  });
  await deleteDoc(doc(db(), "liveSessions", sessionId, "groupRooms", roomId));
}

/** Student picks their own group — e.g. "όποια ομάδα έχετε στο Zoom, μπείτε εκεί"
 *  — without needing the teacher to assign them one by one. Removes them from
 *  any other group first (a student can only be in one group at a time). */
export async function joinGroupRoom(sessionId: string, roomId: string, studentId: string) {
  const rooms = await cGetDocs(collection(db(), "liveSessions", sessionId, "groupRooms"));
  for (const r of rooms.docs) {
    if (r.id === roomId) continue;
    const data = r.data() as Omit<GroupRoom, "id">;
    if (data.participantIds?.includes(studentId)) {
      await cUpdateDoc(r.ref, { participantIds: arrayRemove(studentId) });
    }
  }
  await cUpdateDoc(doc(db(), "liveSessions", sessionId, "groupRooms", roomId), {
    participantIds: arrayUnion(studentId),
  });
}

/** Teacher clicks "Αυτόματος διαχωρισμός" — evenly distributes the given
 *  students across the given (already-created) groups, round-robin, replacing
 *  any previous assignment. */
export async function autoSplitIntoGroups(
  sessionId: string,
  groupRoomIds: string[],
  studentIds: string[],
) {
  if (groupRoomIds.length === 0) return;
  const shuffled = [...studentIds].sort(() => Math.random() - 0.5);
  const buckets: string[][] = groupRoomIds.map(() => []);
  shuffled.forEach((uid, i) => buckets[i % groupRoomIds.length].push(uid));
  await Promise.all(
    groupRoomIds.map((roomId, i) =>
      cUpdateDoc(doc(db(), "liveSessions", sessionId, "groupRooms", roomId), {
        participantIds: buckets[i],
      }),
    ),
  );
}

// ---------------------- Invitations ----------------------

export async function sendInvitation(opts: {
  sessionId: string;
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
}): Promise<string> {
  const existing = await cGetDocs(
    query(
      collection(db(), "invitations"),
      where("sessionId", "==", opts.sessionId),
      where("toUserId", "==", opts.toUserId),
      where("status", "==", "pending"),
    ),
  );
  if (!existing.empty) return existing.docs[0].id;

  const ref = await cAddDoc(collection(db(), "invitations"), {
    sessionId: opts.sessionId,
    fromUserId: opts.fromUserId,
    fromUserName: opts.fromUserName,
    toUserId: opts.toUserId,
    status: "pending" as InvitationStatus,
    createdAt: serverTimestamp(),
  });
  return ref.id;
}

export function subscribeMyInvitations(uid: string, cb: (inv: Invitation[]) => void): Unsubscribe {
  const q = query(
    collection(db(), "invitations"),
    where("toUserId", "==", uid),
    where("status", "==", "pending"),
  );
  return cOnSnapshot(q, (snap) => {
    const qs = snap as unknown as {
      docs: Array<{ id: string; data: () => Omit<Invitation, "id"> }>;
    };
    cb(qs.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function respondToInvitation(invitationId: string, accept: boolean, uid: string) {
  const ref = doc(db(), "invitations", invitationId);
  const snap = await cGetDoc(ref);
  if (!snap.exists()) return null;
  const inv = snap.data() as Omit<Invitation, "id">;
  if (inv.toUserId !== uid) throw new Error("Not your invitation");
  await cUpdateDoc(ref, { status: accept ? "accepted" : "declined" });
  if (accept) {
    await cUpdateDoc(doc(db(), "liveSessions", inv.sessionId), {
      participantIds: arrayUnion(uid),
      updatedAt: serverTimestamp(),
    });
    return inv.sessionId;
  }
  return null;
}

// ── Project sharing (Διαμοιρασμός σχεδίου) ──────────────────────────
// Creates a live session that uses the existing project's board as mainBoardId.

export async function shareProject(opts: {
  ownerId: string;
  ownerName: string;
  projectId: string;
  projectTitle: string;
  workspaceType: WorkspaceType;
}): Promise<LiveSession> {
  const ref = await cAddDoc(collection(db(), "liveSessions"), {
    teacherId: opts.ownerId,
    teacherName: opts.ownerName,
    title: opts.projectTitle,
    workspaceType: opts.workspaceType,
    status: "active" as LiveSessionStatus,
    mainBoardId: opts.projectId, // use the project itself as the board
    groupRoomIds: [],
    participantIds: [opts.ownerId],
    editPermissions: [opts.ownerId],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  const snap = await cGetDoc(ref);
  return { id: ref.id, ...(snap.data() as Omit<LiveSession, "id">) };
}

export async function endProjectShare(sessionId: string, ownerId: string) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    status: "ended" as LiveSessionStatus,
    endedAt: serverTimestamp(),
  });
}

export function subscribeProjectSession(
  projectId: string,
  cb: (session: LiveSession | null) => void,
) {
  const q = query(
    collection(db(), "liveSessions"),
    where("mainBoardId", "==", projectId),
    where("status", "==", "active"),
  );
  return cOnSnapshot(q, (snap) => {
    const qs = snap as import("firebase/firestore").QuerySnapshot;
    if (qs.empty) { cb(null); return; }
    const d = qs.docs[0];
    cb({ id: d.id, ...(d.data() as Omit<LiveSession, "id">) });
  });
}

export async function setEditPermission(
  sessionId: string,
  uid: string,
  canEdit: boolean,
) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    editPermissions: canEdit ? arrayUnion(uid) : arrayRemove(uid),
    updatedAt: serverTimestamp(),
  });
}

// ── Send design to user ───────────────────────────────────────────────
// Copies the board to the recipient's projects as a "received_design".

export async function sendDesignToUser(opts: {
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
  sourceProjectId: string;
  sourceTitle: string;
}): Promise<void> {
  // Record the share in a "receivedDesigns" collection for the recipient
  await cAddDoc(collection(db(), "receivedDesigns"), {
    toUserId: opts.toUserId,
    fromUserId: opts.fromUserId,
    fromUserName: opts.fromUserName,
    sourceProjectId: opts.sourceProjectId,
    title: opts.sourceTitle,
    status: "pending",
    createdAt: serverTimestamp(),
  });
}

export interface ReceivedDesign {
  id: string;
  toUserId: string;
  fromUserId: string;
  fromUserName: string;
  sourceProjectId: string;
  title: string;
  status: "pending" | "saved";
  createdAt?: unknown;
}

export function subscribeReceivedDesigns(
  userId: string,
  cb: (designs: ReceivedDesign[]) => void,
) {
  const q = query(
    collection(db(), "receivedDesigns"),
    where("toUserId", "==", userId),
    where("status", "==", "pending"),
  );
  return cOnSnapshot(q, (snap) => {
    const qs = snap as import("firebase/firestore").QuerySnapshot;
    cb(qs.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ReceivedDesign, "id">) })));
  });
}

export async function markDesignSaved(designId: string): Promise<void> {
  await cUpdateDoc(doc(db(), "receivedDesigns", designId), { status: "saved" });
}

// ── Session control functions ─────────────────────────────────────────

/** Teacher returns all students to main board (groupRooms preserved, not deleted). */
export async function returnAllToMain(sessionId: string) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    groupRoomsActive: false,
    teacherInRoomId: null,
    updatedAt: serverTimestamp(),
  });
}

/** Teacher re-activates groupRooms so students return to their rooms. */
export async function reactivateGroupRooms(sessionId: string) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    groupRoomsActive: true,
    updatedAt: serverTimestamp(),
  });
}

/** Teacher enters a specific group room — triggers student notification. */
export async function teacherEnterRoom(sessionId: string, roomId: string | null) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    teacherInRoomId: roomId,
    updatedAt: serverTimestamp(),
  });
}

/** Teacher presents a board to all participants (null = stop presenting). */
export async function setPresentingBoard(sessionId: string, boardId: string | null) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    presentingBoardId: boardId ?? null,
    updatedAt: serverTimestamp(),
  });
}

/** Save all group rooms to participants' lobbies and end the session safely.
 *  Returns { saved: number, failed: string[] } so caller can abort on failure. */
export async function endSessionAndSave(
  sessionId: string,
  teacherId: string,
): Promise<{ saved: number; failed: string[] }> {
  const { mapStore } = await import("@/lib/canvas/storage");
  const { forceSaveBoard } = await import("@/lib/canvas/live-autosave");
  const { createProject } = await import("@/lib/projects");

  // Load all group rooms
  const roomsSnap = await cGetDocs(
    query(collection(db(), "liveSessions", sessionId, "groupRooms")),
  );
  const rooms = roomsSnap.docs.map((d) => ({
    id: d.id,
    ...(d.data() as Omit<GroupRoom, "id">),
  }));

  const failed: string[] = [];
  let saved = 0;

  // Step 1: Force-save each room's current snapshot to the server (with retry)
  for (const room of rooms) {
    const state = await mapStore.load(room.boardId);
    if (state) {
      const r = await forceSaveBoard(room.boardId, state, 3);
      if (!r.ok) {
        failed.push(`${room.name} (snapshot)`);
        continue; // don't distribute if snapshot failed
      }
    }

    // Step 2: Distribute a copy to each participant's lobby (ONLY their participants)
    const participants = [...new Set([...room.participantIds, teacherId])];
    for (const uid of participants) {
      try {
        const newId = await createProject(uid, room.name, "collaborative", "free-drawing");
        if (state) {
          const saveR = await forceSaveBoard(newId, state, 3);
          if (!saveR.ok) throw new Error(saveR.error);
        }
        await cUpdateDoc(doc(db(), "projects", newId), {
          sourceSessionId: sessionId,
          sourceRoomId: room.id,
          sessionParticipants: room.participantIds,
          savedAt: serverTimestamp(),
        });
        saved++;
      } catch (e) {
        console.error(`Failed to save room ${room.id} for user ${uid}`, e);
        failed.push(`${room.name} → ${uid.slice(0, 6)}`);
      }
    }
  }

  // Step 3: Only mark session as ended if ALL saves succeeded
  if (failed.length === 0) {
    await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
      status: "ended" as LiveSessionStatus,
      endedAt: serverTimestamp(),
    });
  }

  return { saved, failed };
}

// ── Activate / announce a session ─────────────────────────────────────
// Teacher presses "Ενεργοποίηση Μαθήματος" → sends invitation-style
// notification to every participant so they see "Μάθημα X ξεκίνησε — Είσοδος".

export async function activateAndNotifyAll(
  session: LiveSession,
  fromUserName: string,
): Promise<void> {
  const toNotify = session.participantIds.filter((id) => id !== session.teacherId);
  await Promise.all(
    toNotify.map((uid) =>
      cAddDoc(collection(db(), "invitations"), {
        sessionId: session.id,
        fromUserId: session.teacherId,
        fromUserName,
        toUserId: uid,
        type: "lesson_start",
        title: session.title,
        status: "pending",
        createdAt: serverTimestamp(),
      }),
    ),
  );
}

/** Notify an explicit list of users (e.g. everyone currently online) that a
 *  live session started — NOT limited to the session's existing
 *  participantIds. Also adds them to participantIds immediately so the
 *  session shows up in their "Ζωντανά μαθήματα" list right away, even before
 *  they act on the notification. Used right after creating/activating a
 *  session so online students don't have to be invited one by one. */
export async function notifyOnlineUsers(
  session: LiveSession,
  fromUserName: string,
  toUserIds: string[],
): Promise<void> {
  const targets = [...new Set(toUserIds)].filter(
    (id) => id !== session.teacherId && !session.participantIds.includes(id),
  );
  if (targets.length === 0) return;
  await cUpdateDoc(doc(db(), "liveSessions", session.id), {
    participantIds: arrayUnion(...targets),
    updatedAt: serverTimestamp(),
  });
  await Promise.all(
    targets.map((uid) =>
      cAddDoc(collection(db(), "invitations"), {
        sessionId: session.id,
        fromUserId: session.teacherId,
        fromUserName,
        toUserId: uid,
        type: "lesson_start",
        title: session.title,
        status: "pending",
        createdAt: serverTimestamp(),
      }),
    ),
  );
}

// ── Pause / resume session on teacher disconnect ──────────────────────

/** Pause a session when teacher disconnects (sets status to "paused"). */
export async function pauseSession(sessionId: string): Promise<void> {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    status: "paused" as LiveSessionStatus,
    updatedAt: serverTimestamp(),
  });
}

/** Resume a session when teacher reconnects. */
export async function resumeSession(sessionId: string): Promise<void> {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    status: "active" as LiveSessionStatus,
    updatedAt: serverTimestamp(),
  });
}

/** Notify all participants that the session was paused (teacher disconnected). */
export async function notifySessionPaused(
  session: LiveSession,
  teacherName: string,
): Promise<void> {
  const toNotify = session.participantIds.filter((id) => id !== session.teacherId);
  await Promise.all(
    toNotify.map((uid) =>
      cAddDoc(collection(db(), "invitations"), {
        sessionId: session.id,
        fromUserId: session.teacherId,
        fromUserName: teacherName,
        toUserId: uid,
        type: "lesson_paused",
        title: session.title,
        status: "pending",
        createdAt: serverTimestamp(),
      }),
    ),
  );
}

// ── Auto-expire sessions older than 24 hours ─────────────────────────
// Called on lobby load. Checks all active/paused sessions for the teacher
// and pauses any that are older than SESSION_MAX_AGE_MS.
// No Cloud Function needed — runs client-side on lobby mount.

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function autoExpireOldSessions(teacherId: string): Promise<string[]> {
  const expired: string[] = [];
  try {
    const snap = await cGetDocs(
      query(
        collection(db(), "liveSessions"),
        where("teacherId", "==", teacherId),
        where("status", "in", ["active", "paused"]),
      ),
    );
    const now = Date.now();
    for (const d of snap.docs) {
      const data = d.data() as LiveSession;
      const createdAt = (data.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
      if (createdAt > 0 && now - createdAt > SESSION_MAX_AGE_MS) {
        await cUpdateDoc(d.ref, {
          status: "paused" as LiveSessionStatus,
          autoExpiredAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        expired.push(data.title);
      }
    }
  } catch (e) {
    console.warn("autoExpireOldSessions failed", e);
  }
  return expired;
}

/** Teacher presents a workspace room to all participants. null = stop. */
export async function setPresentingRoom(sessionId: string, roomId: string | null) {
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    presentingRoomId: roomId ?? null,
    updatedAt: serverTimestamp(),
  });
}

/** Delete an invitation document (used for info-only notifications like lesson_paused). */
export async function deleteInvitation(invitationId: string): Promise<void> {
  const { deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db(), "invitations", invitationId));
}
