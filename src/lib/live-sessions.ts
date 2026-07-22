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
  arrayUnion,
  arrayRemove,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import { createProject, type WorkspaceType } from "./projects";
import { cAddDoc, cGetDoc, cGetDocs, cOnSnapshot, cSetDoc, cUpdateDoc } from "./quota-guard";

export type LiveSessionStatus = "active" | "paused" | "ending" | "ended";
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

/** Per-student participation record within a group room — lives at
 *  liveSessions/{sid}/groupRooms/{gid}/members/{uid}. Kept even after a
 *  student leaves the group (isCurrentMember: false) so contribution
 *  history survives group switches, and so end-of-session distribution
 *  knows exactly who actually worked on this board. Written by the
 *  student's own browser (self-tracking) — see recordGroupJoin/Leave/
 *  markGroupContribution below. */
export interface GroupMember {
  userId: string;
  displayName: string;
  joinedAt?: unknown;
  leftAt?: unknown | null;
  isCurrentMember: boolean;
  contributed: boolean;
  firstContributionAt?: unknown | null;
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
    const rows = qs.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => s.status === "active" || s.status === "paused");
    rows.sort((a, b) => {
      const at = (a.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      const bt = (b.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      return bt - at;
    });
    cb(rows[0] ?? null);
  });
}

// ── Single-button live class entry point ────────────────────────────
// This app models one classroom at a time: there is no roster/cohort
// binding a given student to a given teacher, so "the live lesson" is
// simply whichever liveSession is currently active. Used by
// LiveClassButton (replaces the old browsable "live lessons" list).
export function subscribeActiveSession(cb: (s: LiveSession | null) => void): Unsubscribe {
  // Deliberately NOT combined with orderBy in the query itself: equality +
  // orderBy on a different field needs a composite index created manually
  // in the Firebase console first. Instead, fetch all "active" sessions
  // (normally just one) and pick the most recently updated client-side —
  // this matters because stale orphaned sessions from earlier testing can
  // be left marked "active" too, and an arbitrary Firestore pick among
  // them could grab the wrong one, leaving the student-side LIVE badge
  // permanently grey even though the teacher really is in a (different)
  // active session.
  const q = query(collection(db(), "liveSessions"), where("status", "==", "active"));
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
    cb(rows[0] ?? null);
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
/** Called by a student's own browser the moment they become a current
 *  member of a group (self-join via "Είσοδος", or the teacher assigning
 *  them — either way their OWN browser records it once it sees itself in
 *  participantIds). First-ever join creates the record with
 *  contributed:false; a later rejoin only flips isCurrentMember back on
 *  without touching prior contribution history. */
export async function recordGroupJoin(
  sessionId: string,
  groupId: string,
  userId: string,
  displayName: string,
): Promise<void> {
  const ref = doc(db(), "liveSessions", sessionId, "groupRooms", groupId, "members", userId);
  const existing = await cGetDoc(ref);
  if (existing.exists()) {
    await cUpdateDoc(ref, { isCurrentMember: true, leftAt: null, displayName });
  } else {
    await cSetDoc(ref, {
      userId,
      displayName,
      joinedAt: serverTimestamp(),
      leftAt: null,
      isCurrentMember: true,
      contributed: false,
      firstContributionAt: null,
    });
  }
}

/** Called by a student's own browser when they stop being a current
 *  member of a group (left themselves, reassigned elsewhere, or removed
 *  by the teacher). Keeps the record — just flips isCurrentMember off —
 *  so contribution history survives for end-of-session distribution. */
export async function recordGroupLeave(sessionId: string, groupId: string, userId: string): Promise<void> {
  const ref = doc(db(), "liveSessions", sessionId, "groupRooms", groupId, "members", userId);
  await cUpdateDoc(ref, { isCurrentMember: false, leftAt: serverTimestamp() }).catch(() => {});
}

/** Marks a student as having made at least one real edit on their
 *  group's board. Called once client-side on first genuine change (see
 *  the group-tab save-status wiring in live.$sessionId.tsx) — the
 *  one-time guard lives there, this just needs to be safe to call. */
export async function markGroupContribution(sessionId: string, groupId: string, userId: string): Promise<void> {
  const ref = doc(db(), "liveSessions", sessionId, "groupRooms", groupId, "members", userId);
  await cSetDoc(ref, { contributed: true, firstContributionAt: serverTimestamp() }, { merge: true }).catch(() => {});
}

export function subscribeGroupMembers(
  sessionId: string,
  groupId: string,
  cb: (members: GroupMember[]) => void,
): Unsubscribe {
  return cOnSnapshot(
    collection(db(), "liveSessions", sessionId, "groupRooms", groupId, "members"),
    (snap) => {
      const qs = snap as unknown as { docs: Array<{ data: () => GroupMember }> };
      cb(qs.docs.map((d) => d.data()));
    },
  );
}

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
      where("fromUserId", "==", opts.fromUserId),
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
  const inv = snap.data() as Omit<Invitation, "id"> & { type?: string; projectId?: string };
  if (inv.toUserId !== uid) throw new Error("Not your invitation");
  await cUpdateDoc(ref, { status: accept ? "accepted" : "declined" });
  if (!accept) return null;
  if (inv.type === "collab_project" && inv.projectId) {
    const { joinCollabProject } = await import("./projects");
    await joinCollabProject(inv.projectId, uid);
    return inv.projectId;
  }
  await cUpdateDoc(doc(db(), "liveSessions", inv.sessionId), {
    participantIds: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
  return inv.sessionId;
}

/** Sends an invitation to co-edit a collaborative project — parallel to
 *  sendInvitation, but for the lightweight project-level collaboration
 *  model (see startCollabProject/joinCollabProject in projects.ts)
 *  instead of a liveSessions-based classroom session. */
export async function sendCollabProjectInvitation(opts: {
  projectId: string;
  projectTitle: string;
  fromUserId: string;
  fromUserName: string;
  toUserId: string;
}): Promise<string> {
  const existing = await cGetDocs(
    query(
      collection(db(), "invitations"),
      where("fromUserId", "==", opts.fromUserId),
      where("projectId", "==", opts.projectId),
      where("toUserId", "==", opts.toUserId),
      where("status", "==", "pending"),
    ),
  );
  if (!existing.empty) return existing.docs[0].id;

  const ref = await cAddDoc(collection(db(), "invitations"), {
    type: "collab_project",
    projectId: opts.projectId,
    title: opts.projectTitle,
    fromUserId: opts.fromUserId,
    fromUserName: opts.fromUserName,
    toUserId: opts.toUserId,
    status: "pending" as InvitationStatus,
    createdAt: serverTimestamp(),
  });
  return ref.id;
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
export interface EndSessionFailure {
  groupId: string;
  groupName: string;
  studentId: string;
  studentName: string;
}

export interface EndSessionResult {
  ended: boolean;
  distributed: number;
  failed: EndSessionFailure[];
}

/** Ends a live session, distributing each group's FINAL board to every
 *  student who actually contributed to it (not just anyone who briefly
 *  joined) as an independent personal copy in their own lobby.
 *
 *  Safe to call more than once (double-click, network retry): copy IDs
 *  are deterministic (`livecopy_{sessionId}_{groupId}_{studentId}`), so
 *  a re-run skips everything that already succeeded and only retries
 *  what previously failed. The session only flips to "ended" once every
 *  contributor's copy exists; until then it sits in "ending" (locked for
 *  editing, but resumable-by-retry) so nothing is ever silently lost. */
export async function endSessionAndSave(
  sessionId: string,
  teacherId: string,
  teacherName: string,
): Promise<EndSessionResult> {
  const { mapStore } = await import("@/lib/canvas/storage");
  const { forceSaveBoard } = await import("@/lib/canvas/live-autosave");

  // Step 1: lock out further editing app-wide while we finish saving.
  await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
    status: "ending" as LiveSessionStatus,
    updatedAt: serverTimestamp(),
  });

  const sessionSnap = await cGetDoc(doc(db(), "liveSessions", sessionId));
  const sessionData = sessionSnap.exists() ? (sessionSnap.data() as Omit<LiveSession, "id">) : undefined;
  const lessonTitle = sessionData?.title ?? "Ζωντανό μάθημα";
  const dateLabel = new Date().toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" });

  const roomsSnap = await cGetDocs(query(collection(db(), "liveSessions", sessionId, "groupRooms")));
  const rooms = roomsSnap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<GroupRoom, "id">) }));

  const failed: EndSessionFailure[] = [];
  let distributed = 0;

  for (const room of rooms) {
    const membersSnap = await cGetDocs(
      collection(db(), "liveSessions", sessionId, "groupRooms", room.id, "members"),
    );
    const contributors = membersSnap.docs
      .map((d) => d.data() as GroupMember)
      .filter((m) => m.contributed);
    if (contributors.length === 0) continue; // nobody actually worked here — nothing to save

    // Step 3: final snapshot save, retried up to 3x.
    const state = await mapStore.load(room.boardId);
    if (state) {
      const r = await forceSaveBoard(room.boardId, state, 3);
      if (!r.ok) {
        contributors.forEach((m) =>
          failed.push({ groupId: room.id, groupName: room.name, studentId: m.userId, studentName: m.displayName }),
        );
        continue; // can't distribute a board we couldn't even save
      }
    }

    const groupMemberNames = contributors.map((m) => m.displayName);
    const title = `Ζωντανό μάθημα – ${room.name} – ${lessonTitle} – ${dateLabel}`;

    // Step 5 + 9: one personal copy per contributor, deterministic ID so
    // re-running this after a partial failure never creates duplicates.
    for (const member of contributors) {
      const copyId = `livecopy_${sessionId}_${room.id}_${member.userId}`;
      try {
        await cSetDoc(
          doc(db(), "projects", copyId),
          {
            ownerId: member.userId,
            title,
            status: "draft",
            projectType: "collaborative",
            mode: "solo",
            workspaceType: sessionData?.workspaceType ?? "free-drawing",
            sourceMapId: null,
            liveSessionId: null,
            originLabel: `🎓 Τελικό σχέδιο ζωντανού μαθήματος — ${groupMemberNames.join(", ")}`,
            sourceType: "live-group-final",
            sourceSessionId: sessionId,
            sourceGroupId: room.id,
            groupName: room.name,
            groupMemberNames,
            lessonTitle,
            lessonDate: serverTimestamp(),
            teacherId,
            teacherName,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
            copiedAt: serverTimestamp(),
          },
          { merge: true },
        );
        if (state) {
          const sanitized = JSON.parse(JSON.stringify(state));
          await cSetDoc(
            doc(db(), "projects", copyId, "snapshots", "current"),
            { payload: sanitized, schemaVersion: 1, isCurrent: true, savedAt: serverTimestamp() },
            { merge: true },
          );
        }
        distributed++;
      } catch (e) {
        console.error(`Failed to distribute group ${room.id} to ${member.userId}`, e);
        failed.push({ groupId: room.id, groupName: room.name, studentId: member.userId, studentName: member.displayName });
      }
    }
  }

  // Step 6/7: only finalize (and clean up, step 8) once EVERYTHING succeeded.
  if (failed.length === 0) {
    await cUpdateDoc(doc(db(), "liveSessions", sessionId), {
      status: "ended" as LiveSessionStatus,
      endedAt: serverTimestamp(),
      editPermissions: [],
      teacherInRoomId: null,
      presentingBoardId: null,
      presentingRoomId: null,
      groupRoomsActive: false,
    });
    return { ended: true, distributed, failed: [] };
  }
  // Left in "ending" — locked, not yet finalized — so the teacher can
  // press the same button again to retry only what failed.
  return { ended: false, distributed, failed };
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
