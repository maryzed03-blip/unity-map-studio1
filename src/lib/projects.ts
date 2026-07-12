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
