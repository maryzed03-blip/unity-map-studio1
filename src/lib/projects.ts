// Cost annotations per call:
//   createProject:        3 writes (project + initial snapshot + owner member doc)
//   subscribeMyProjects:  N reads on initial + 1 per change delivered.
//                         onSnapshot is a known quota risk; see quota-guard.ts.
//   getProject:           1 read
//   updateProjectStatus / renameProject: 1 write
//   listProjectsWhere:    N reads (one per matched doc, min 1)

import {
  collection,
  doc,
  query,
  where,
  serverTimestamp,
  arrayUnion,
  type Unsubscribe,
} from "firebase/firestore";
import { db } from "./firebase";
import {
  cAddDoc,
  cDeleteDoc,
  cGetDoc,
  cGetDocs,
  cOnSnapshot,
  cSetDoc,
  cUpdateDoc,
} from "./quota-guard";
import { mapStore } from "./canvas/storage";

export type ProjectStatus = "draft" | "active_collab" | "submitted" | "returned" | "archived";

export type ProjectType = "personal" | "collaborative" | "session_board";

export type ProjectMode = "solo" | "live" | "collaborativeFinal";

export type WorkspaceType = "case-analysis" | "concept-analysis" | "free-drawing" | "genogram";

export interface Project {
  id: string;
  ownerId: string;
  workspace?: string;
  workspaceType?: WorkspaceType;
  mode?: ProjectMode;
  sourceMapId?: string | null;
  liveSessionId?: string | null;
  /** Stage 6: optional folder reference. null/absent = "Χωρίς φάκελο". */
  folderId?: string | null;
  title: string;
  status: ProjectStatus;
  projectType: ProjectType;
  thumbnail?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
  /** Anyone in this list can co-edit the project live, exactly like a
   *  group's members — set for projectType "collaborative" only. See
   *  startCollabProject / joinCollabProject / subscribeCollabParticipants. */
  collabParticipantIds?: string[];
  /** Set true once finalizeCollabProjectIfEmpty has distributed personal
   *  copies to everyone — the lobby's "Συνεργατικό live" button ignores
   *  any project with this set. */
  collabFinalized?: boolean;
  /** Human-readable origin, e.g. "Χώρος Εργασίας — Χώρος 3" or a group's name.
   *  Shown under the project title in the library so people can tell where
   *  an auto-saved draft came from. Absent for normal, manually-created projects. */
  originLabel?: string;
  /** When this copy was auto-saved (e.g. on leaving a room). Distinct from
   *  createdAt/updatedAt which track the underlying project doc lifecycle. */
  savedAt?: unknown;
  /** True for the fixed set of public "Χώρος Εργασίας" boards (see
   *  workspaces-rooms.ts). These are always multi-user — the editor route
   *  must force liveSync on for them regardless of any liveSessions doc. */
  isWorkspaceRoom?: boolean;
}

export async function createProject(
  ownerId: string,
  title: string,
  projectType: ProjectType = "personal",
  workspaceType: WorkspaceType = "free-drawing",
): Promise<string> {
  const ref = await cAddDoc(collection(db(), "projects"), {
    ownerId,
    title,
    status: "draft",
    projectType,
    mode: "solo" as ProjectMode,
    workspaceType,
    sourceMapId: null,
    liveSessionId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await cSetDoc(doc(db(), "projects", ref.id, "snapshots", "current"), {
    payload: { objects: [], viewport: { x: 0, y: 0, zoom: 1 }, settings: {} },
    schemaVersion: 1,
    version: 1,
    isCurrent: true,
    savedBy: ownerId,
    saveType: "auto",
    savedAt: serverTimestamp(),
  });
  await cSetDoc(doc(db(), "projects", ref.id, "members", ownerId), {
    role: "owner",
    invitedAt: serverTimestamp(),
    acceptedAt: serverTimestamp(),
  });
  return ref.id;
}

/** Creates a new personal project pre-populated with the given objects
 *  (fresh ids, re-centered near the origin so it looks tidy when opened)
 *  instead of starting blank. Used by "Δημιουργία νέου σχεδίου" on a
 *  canvas selection — see insert-into-board.ts for the id-regeneration
 *  helper this reuses. */
export async function createProjectFromObjects(
  ownerId: string,
  title: string,
  objects: import("./canvas/types").CanvasObject[],
  workspaceType: WorkspaceType = "free-drawing",
): Promise<string> {
  const { regenerateAndOffsetObjects } = await import("./canvas/insert-into-board");
  const PADDING = 40;
  const left = objects.length > 0 ? Math.min(...objects.map((o) => o.x)) : 0;
  const top = objects.length > 0 ? Math.min(...objects.map((o) => o.y)) : 0;
  const placed = regenerateAndOffsetObjects(objects, PADDING - left, PADDING - top);

  const ref = await cAddDoc(collection(db(), "projects"), {
    ownerId,
    title,
    status: "draft",
    projectType: "personal" as ProjectType,
    mode: "solo" as ProjectMode,
    workspaceType,
    sourceMapId: null,
    liveSessionId: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  await cSetDoc(doc(db(), "projects", ref.id, "snapshots", "current"), {
    payload: { objects: placed, viewport: { x: 0, y: 0, zoom: 1 }, settings: {} },
    schemaVersion: 1,
    version: 1,
    isCurrent: true,
    savedBy: ownerId,
    saveType: "auto",
    savedAt: serverTimestamp(),
  });
  await cSetDoc(doc(db(), "projects", ref.id, "members", ownerId), {
    role: "owner",
    invitedAt: serverTimestamp(),
    acceptedAt: serverTimestamp(),
  });
  return ref.id;
}

// ── Collaborative projects — lightweight, unlimited concurrent ─────────
// Deliberately independent of liveSessions.ts entirely: a "Συνεργατικό"
// project is just a regular project with a list of co-editors who can
// all live-sync it, exactly like group boards inside a live session.
// No "one active session per owner" restriction — any number of
// different people can each have their own simultaneous collaborative
// project running at once, since nothing here is scoped by teacherId or
// a single shared "active session" document.

/** Marks a freshly-created project as collaborative and seeds its
 *  participant list with just the owner. Call once, right after
 *  createProject(...). */
export async function startCollabProject(projectId: string, ownerId: string): Promise<void> {
  await cUpdateDoc(doc(db(), "projects", projectId), {
    collabParticipantIds: [ownerId],
    updatedAt: serverTimestamp(),
  });
}

/** Self-join — called by an invited user's own browser after accepting
 *  a collab_project invitation (see InvitationListener.tsx). */
export async function joinCollabProject(projectId: string, uid: string): Promise<void> {
  await cUpdateDoc(doc(db(), "projects", projectId), {
    collabParticipantIds: arrayUnion(uid),
    updatedAt: serverTimestamp(),
  });
}

/** Real-time participant list — lets the editor page react instantly
 *  when someone new joins, without needing a page refresh. */
export function subscribeCollabParticipants(
  projectId: string,
  cb: (uids: string[]) => void,
): Unsubscribe {
  return cOnSnapshot(doc(db(), "projects", projectId), (snap) => {
    const data = (snap as { data: () => { collabParticipantIds?: string[] } | undefined }).data();
    cb(data?.collabParticipantIds ?? []);
  });
}

/** Called whenever ANY client notices (via real-time presence) that
 *  nobody currently has this collaborative project open. Safe to call
 *  repeatedly / from multiple clients — idempotent via collabFinalized
 *  and deterministic copy ids, and a no-op for anything that isn't an
 *  active, non-finalized collaborative project.
 *
 *  Distributes an independent personal draft copy to EVERY participant
 *  who ever joined (including the owner), then clears the collaboration
 *  so the lobby's "Συνεργατικό live" indicator stops showing it. */
export async function finalizeCollabProjectIfEmpty(projectId: string): Promise<void> {
  const project = await getProject(projectId);
  if (!project) return;
  if (project.projectType !== "collaborative") return;
  if (project.collabFinalized) return;
  const participants = project.collabParticipantIds ?? [];
  if (participants.length === 0) return;

  const state = await mapStore.load(projectId);
  const dateLabel = new Date().toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" });
  const title = `Συνεργασία — ${project.title} — ${dateLabel}`;

  for (const uid of participants) {
    const copyId = `collabcopy_${projectId}_${uid}`;
    try {
      await cSetDoc(
        doc(db(), "projects", copyId),
        {
          ownerId: uid,
          title,
          status: "draft",
          projectType: "personal",
          mode: "solo",
          workspaceType: project.workspaceType ?? "free-drawing",
          sourceMapId: null,
          liveSessionId: null,
          originLabel: `👥 Συνεργασία`,
          sourceCollabProjectId: projectId,
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
    } catch (e) {
      console.warn(`finalizeCollabProjectIfEmpty: failed to copy for ${uid}`, e);
      // Don't mark finalized if any copy failed — a later call (from
      // whoever next notices the empty presence) will retry, skipping
      // whatever already succeeded thanks to the deterministic id check
      // above.
      return;
    }
  }

  await cUpdateDoc(doc(db(), "projects", projectId), {
    collabParticipantIds: [],
    collabFinalized: true,
    updatedAt: serverTimestamp(),
  });
}

export function subscribeMyCollabProjects(uid: string, cb: (projects: Project[]) => void): Unsubscribe {
  const q = query(collection(db(), "projects"), where("collabParticipantIds", "array-contains", uid));
  return cOnSnapshot(q, (snap) => {
    const qs = snap as unknown as { docs: Array<{ id: string; data: () => Omit<Project, "id"> }> };
    cb(
      qs.docs
        .map((d) => ({ id: d.id, ...d.data() }))
        .filter((p) => p.projectType === "collaborative" && !p.collabFinalized),
    );
  });
}

export function subscribeMyProjects(
  ownerId: string,
  cb: (projects: Project[]) => void,
): Unsubscribe {
  const q = query(collection(db(), "projects"), where("ownerId", "==", ownerId));
  return cOnSnapshot(q, (snap) => {
    const qs = snap as unknown as { docs: Array<{ id: string; data: () => Omit<Project, "id"> }> };
    const rows = qs.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => {
        if (p.projectType === "session_board") return false;
        if ((p as { isWorkspaceRoom?: boolean }).isWorkspaceRoom) return false;
        if (p.projectType === "collaborative" && /^Χώρος \d+/.test(p.title ?? "")) return false;
        if ((p.title ?? "").startsWith("[LIVE]")) return false;
        return true;
      });
    rows.sort((a, b) => {
      const at = (a.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      const bt = (b.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
      return bt - at;
    });
    cb(rows);
  });
}

export async function getProject(id: string): Promise<Project | null> {
  const snap = await cGetDoc(doc(db(), "projects", id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...(snap.data() as Omit<Project, "id">) };
}

export async function updateProjectStatus(id: string, status: ProjectStatus) {
  await cUpdateDoc(doc(db(), "projects", id), { status, updatedAt: serverTimestamp() });
}

export async function renameProject(id: string, title: string) {
  await cUpdateDoc(doc(db(), "projects", id), { title, updatedAt: serverTimestamp() });
}

/**
 * Stage 6: Delete a project. Best-effort external payload cleanup first
 * (Stage 4 left this as a follow-up), then delete the project doc itself.
 *
 * Known limitation: Firestore subcollections (members/, snapshots/) are
 * NOT cascaded — fully iterating them client-side would burn quota and is
 * impractical from a Spark-tier free plan. The orphaned subcollection
 * documents are unreachable (the parent doc is gone, RLS denies them) and
 * will be cleaned by a future server-side maintenance script if needed.
 */
export async function deleteProject(id: string): Promise<void> {
  try {
    await mapStore.deleteRemotePayload?.(id);
  } catch (e) {
    console.warn("deleteRemotePayload failed (continuing with project delete)", e);
  }
  await cDeleteDoc(doc(db(), "projects", id));
}

/**
 * Stage 6: Save a copy of an existing project's current canvas state as a
 * brand-new project. The source project is unchanged.
 */
export async function duplicateProject(
  ownerId: string,
  sourceProjectId: string,
  newTitle: string,
): Promise<string> {
  const state = await mapStore.load(sourceProjectId);
  const src = await getProject(sourceProjectId);
  const newId = await createProject(
    ownerId,
    newTitle,
    src?.projectType ?? "personal",
    src?.workspaceType ?? "free-drawing",
  );
  if (state) {
    await mapStore.save(newId, state);
  }
  return newId;
}

export async function listProjectsWhere(predicate: {
  ownerId?: string;
  status?: ProjectStatus;
  projectType?: ProjectType;
}): Promise<Project[]> {
  const filters = [];
  if (predicate.ownerId) filters.push(where("ownerId", "==", predicate.ownerId));
  if (predicate.status) filters.push(where("status", "==", predicate.status));
  if (predicate.projectType) filters.push(where("projectType", "==", predicate.projectType));
  const q = query(collection(db(), "projects"), ...filters);
  const snap = await cGetDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Project, "id">) }));
}
