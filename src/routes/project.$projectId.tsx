import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ClientOnly } from "@/lib/client-only";
import { QuotaWarningSurface } from "@/components/QuotaWarningSurface";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Save,
  Loader2,
  HelpCircle,
  Download,
  FileImage,
  FileCode2,
  FileJson,
  FileText,
} from "lucide-react";
import { toast } from "sonner";
import { CanvasToolbar } from "@/components/canvas/Toolbar";
import { CanvasStage } from "@/components/canvas/CanvasStage";
import { CanvasTabs, type CanvasTab } from "@/components/canvas/CanvasTabs";
import { GlobalTabBar } from "@/components/canvas/GlobalTabBar";
import type { ToolId } from "@/lib/workspaces";
import { WORKSPACES } from "@/lib/workspaces";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Send, Upload, Pencil } from "lucide-react";
import { exportPNG, exportSVG, exportJSON, exportPDF, importJSON } from "@/lib/canvas/export";
import { mapStore } from "@/lib/canvas/storage";
import { AIPanel } from "@/components/ai/AIPanel";
import type { CanvasObject, CanvasState } from "@/lib/canvas/types";
import { subscribeActiveSession, subscribeGroupRooms, sendDesignToUser, findUserByEmail, type LiveSession, type GroupRoom } from "@/lib/live-sessions";
import { getProject, createProjectFromObjects, subscribeCollabParticipants, saveMyCollabCopy, type Project } from "@/lib/projects";
import { setCurrentCollabProject } from "@/lib/presence";
import { insertObjectsIntoBoard } from "@/lib/canvas/insert-into-board";
import { SelectionActionsBar, type SendTarget } from "@/components/canvas/SelectionActionsBar";

export const Route = createFileRoute("/project/$projectId")({
  head: () => ({ meta: [{ title: "Editor — Unity Map Studio" }] }),
  component: () => (
    <ClientOnly fallback={<div className="min-h-screen bg-background" />}>
      <EditorGate />
    </ClientOnly>
  ),
});

function EditorGate() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);
  if (loading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  return <Editor />;
}

type SaveState = "idle" | "dirty" | "saving" | "saved";

function Editor() {
  const { projectId } = Route.useParams();
  const { profile } = useAuth();
  const isTeacher = profile?.role === "teacher" || profile?.role === "therapist";
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [tool, setTool] = useState<ToolId>("select");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveApiRef = useRef<{
    save: () => Promise<void>;
    appendObjects: (o: CanvasObject[]) => void;
    replaceState: (next: CanvasState) => void;
  } | null>(null);
  const [manualSaving, setManualSaving] = useState(false);

  // Tabs — main tab is always this project
  const [tabs, setTabs] = useState<CanvasTab[]>([
    { id: "main", mapId: projectId, label: "…", kind: "personal", closeable: false },
  ]);
  const [activeTabId, setActiveTabId] = useState("main");

  const openNewTab = async () => {
    if (!user) return;
    try {
      const { createProject } = await import("@/lib/projects");
      const newId = await createProject(user.uid, "Νέο σχέδιο", "personal");
      const t: CanvasTab = { id: `p-${newId}`, mapId: newId, label: "Νέο σχέδιο", kind: "personal", closeable: true };
      setTabs((prev) => [...prev, t]);
      setActiveTabId(t.id);
    } catch { /* ignore */ }
  };

  const closeTab = (tabId: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId && next.length > 0) setActiveTabId(next[next.length - 1].id);
      // Clear memory cache for this tab's mapId (not the main project)
      if (tab && tab.id !== "main" && user) {
        import("@/lib/canvas/memory-cache").then(({ memoryCache }) => {
          memoryCache.delete(tab.mapId);
        });
      }
      return next;
    });
  };

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeMapId = activeTab?.mapId ?? projectId;

  // Real-time list of who can co-edit this project — only meaningful for
  // projectType "collaborative" (see startCollabProject/joinCollabProject
  // in projects.ts). Deliberately independent of liveSessions entirely:
  // no "one active session" restriction, any number of different people
  // can each be running their own simultaneous collaboration.
  const [collabParticipantIds, setCollabParticipantIds] = useState<string[]>([]);
  useEffect(() => {
    if (project?.projectType !== "collaborative") { setCollabParticipantIds([]); return; }
    return subscribeCollabParticipants(projectId, setCollabParticipantIds);
  }, [projectId, project?.projectType]);

  // Is this board one of the public Χώρος Εργασίας boards? Checked directly
  // against the live workspaceRooms collection (boardId), NOT a flag stored
  // on the project doc — that flag requires owner-only write permission and
  // may never get backfilled for rooms that already existed, silently
  // leaving liveSync off. This check works for every signed-in user.
  const [isWorkspaceRoomBoard, setIsWorkspaceRoomBoard] = useState(false);
  useEffect(() => {
    let alive = true;
    let unsub: (() => void) | undefined;
    import("@/lib/workspaces-rooms").then(({ subscribeRooms }) => {
      if (!alive) return;
      unsub = subscribeRooms((rooms) => {
        if (!alive) return;
        setIsWorkspaceRoomBoard(rooms.some((r) => r.boardId === projectId));
      });
    });
    return () => {
      alive = false;
      unsub?.();
    };
  }, [projectId]);

  const { user } = useAuth();
  const isCollabParticipant = project?.projectType === "collaborative" && collabParticipantIds.includes(user?.uid ?? "");
  // A collaborative project: anyone in the participant list can co-edit,
  // like a group — everyone else (an invite hasn't been accepted yet) is
  // read-only. Any other project (personal/etc): always editable, same as
  // before this feature existed.
  const readOnly =
    project?.viewOnly === true ||
    (project?.projectType === "collaborative" && !isCollabParticipant && !isWorkspaceRoomBoard);

  // Mark myself as "currently here" in real-time presence while I'm a
  // participant on this collaborative project's page — purely so the
  // lobby's "Συνεργατικό σχέδιο live" button can tell someone else is
  // in there right now. The collaboration itself never auto-closes:
  // people may come back to keep working on it at any time, and anyone
  // can save their own personal snapshot of it whenever they like (see
  // the "Αποθήκευση στα Έργα μου" button below) without affecting
  // anyone else's access to the shared original.
  useEffect(() => {
    if (!isCollabParticipant) return;
    setCurrentCollabProject(projectId);
    return () => setCurrentCollabProject(null);
  }, [isCollabParticipant, projectId]);

  const [savingCollabCopy, setSavingCollabCopy] = useState(false);
  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const handleSaveMyCollabCopy = async () => {
    if (!user) return;
    setSavingCollabCopy(true);
    try {
      await saveMyCollabCopy(projectId, user.uid);
      toast.success("Αποθηκεύτηκε στα Έργα μου");
    } catch {
      toast.error("Αποτυχία αποθήκευσης");
    } finally {
      setSavingCollabCopy(false);
    }
  };

  // ── Selection actions bar (send to live lesson / new project) ──────
  const [selectedObjects, setSelectedObjects] = useState<CanvasObject[]>([]);
  const [selectionViaMarquee, setSelectionViaMarquee] = useState(false);
  // Stable reference is essential — see the matching comment in
  // live.$sessionId.tsx for why an inline arrow function here causes an
  // infinite render loop.
  const handleSelectionChange = useCallback((objs: CanvasObject[], viaMarquee: boolean) => {
    setSelectedObjects(objs);
    setSelectionViaMarquee(viaMarquee);
  }, []);
  const [activeLiveSession, setActiveLiveSession] = useState<LiveSession | null | undefined>(undefined);
  useEffect(() => subscribeActiveSession(setActiveLiveSession), []);
  const isActiveSessionTeacher = !!user && !!activeLiveSession && activeLiveSession.teacherId === user.uid;
  const [liveGroups, setLiveGroups] = useState<GroupRoom[]>([]);
  useEffect(() => {
    if (!activeLiveSession || !isActiveSessionTeacher) { setLiveGroups([]); return; }
    return subscribeGroupRooms(activeLiveSession.id, setLiveGroups);
  }, [activeLiveSession, isActiveSessionTeacher]);

  const sendTargets: SendTarget[] = activeLiveSession
    ? [
        { id: "main", mapId: activeLiveSession.mainBoardId, label: `📚 ${activeLiveSession.title} (κεντρικός πίνακας)` },
        ...(isActiveSessionTeacher
          ? liveGroups.map((g) => ({ id: g.id, mapId: g.boardId, label: `👥 ${g.name}` }))
          : []),
      ]
    : [];

  const handleCreateNewProject = async (objects: CanvasObject[]) => {
    if (!user) return;
    const newId = await createProjectFromObjects(user.uid, `${project?.title ?? "Σχέδιο"} (επιλογή)`, objects, project?.workspaceType ?? "free-drawing");
    window.open(`/project/${newId}`, "_blank");
  };

  const handleSendTo = async (target: SendTarget, objects: CanvasObject[]) => {
    await insertObjectsIntoBoard(target.mapId, objects);
  };

  useEffect(() => {
    (async () => {
      try {
        const p = await getProject(projectId);
        setProject(p);
        if (p?.title) {
          setTabs((prev) => prev.map((t) => t.id === "main" ? { ...t, label: p.title } : t));
          // Register in global persistent tab store
          import("@/lib/tab-store").then(({ tabStore }) => {
            tabStore.openTab({
              id: `project-${projectId}`,
              mapId: projectId,
              label: p.title ?? "Σχέδιο",
              kind: "personal",
              closeable: true,
            });
          });
        }
      } catch (e) {
        console.error(e);
        toast.error("Αποτυχία φόρτωσης έργου", {
          description: e instanceof Error ? e.message : undefined,
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!project) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">Το έργο δεν βρέθηκε.</p>
        <Button asChild variant="outline">
          <Link to="/lobby">Επιστροφή</Link>
        </Button>
      </div>
    );
  }

  const workspaceLabel = WORKSPACES[project.workspaceType ?? "free-drawing"].label;
  const saveLabel =
    saveState === "saving"
      ? "Αποθήκευση…"
      : saveState === "dirty"
        ? "Μη αποθηκευμένο"
        : saveState === "saved"
          ? "Αποθηκεύτηκε"
          : "Αποθηκεύτηκε";
  const saveTone =
    saveState === "dirty"
      ? "bg-amber-100 text-amber-900"
      : saveState === "saving"
        ? "bg-muted text-muted-foreground"
        : "bg-[color:var(--success)]/15 text-[color:var(--success)]";

  return (
    <div className="h-screen flex flex-col bg-background">
      {/* Top bar */}
      <header className="h-14 border-b border-border bg-surface flex items-center justify-between px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <Button asChild variant="ghost" size="sm" className="gap-2">
            <Link to="/lobby">
              <ArrowLeft className="h-4 w-4" />
              Lobby
            </Link>
          </Button>
          <div className="h-5 w-px bg-border" />
          <div className="flex items-center gap-2 min-w-0">
            <EditableTitle
              title={project.title}
              readOnly={readOnly}
              onSave={async (t) => {
                const { renameProject } = await import("@/lib/projects");
                await renameProject(projectId, t);
              }}
            />
            <span className="pill bg-muted text-muted-foreground">{workspaceLabel}</span>
            <span className={`pill ${saveTone}`}>{saveLabel}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isTeacher && (
            <AIPanel
              mapId={projectId}
              onInsert={(objs) => saveApiRef.current?.appendObjects(objs)}
            />
          )}
          {isCollabParticipant && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={savingCollabCopy}
              onClick={handleSaveMyCollabCopy}
            >
              {savingCollabCopy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Αποθήκευση στα Έργα μου
            </Button>
          )}
          {!readOnly && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  if (
                    !window.confirm(
                      "Η εισαγωγή θα αντικαταστήσει όλο το τρέχον σχέδιο με το περιεχόμενο του αρχείου. Μπορείτε να το αναιρέσετε (Ctrl+Z) αν χρειαστεί. Συνέχεια;",
                    )
                  ) {
                    return;
                  }
                  try {
                    const imported = await importJSON(file);
                    saveApiRef.current?.replaceState(imported);
                    toast.success("Το σχέδιο εισήχθη");
                  } catch (err) {
                    console.error(err);
                    toast.error("Το αρχείο δεν είναι έγκυρο αντίγραφο JSON");
                  }
                }}
              />
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={() => importInputRef.current?.click()}
              >
                <Upload className="h-4 w-4" />
                Εισαγωγή
              </Button>
            </>
          )}
          {!!user && !readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => setSendDialogOpen(true)}
            >
              <Send className="h-4 w-4" />
              Αποστολή σε
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="gap-1.5">
                <Download className="h-4 w-4" />
                Εξαγωγή
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    await exportPNG(`${project.title || "canvas"}.png`);
                    toast.success("Εξήχθη PNG");
                  } catch (e) {
                    toast.error("Αποτυχία εξαγωγής PNG");
                    console.error(e);
                  }
                }}
              >
                <FileImage className="h-4 w-4 mr-2" /> PNG εικόνα
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => {
                  try {
                    exportSVG(`${project.title || "canvas"}.svg`);
                    toast.success("Εξήχθη SVG");
                  } catch (e) {
                    toast.error("Αποτυχία εξαγωγής SVG");
                    console.error(e);
                  }
                }}
              >
                <FileCode2 className="h-4 w-4 mr-2" /> SVG διάνυσμα
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    const s = await mapStore.load(projectId);
                    if (!s) {
                      toast.error("Δεν υπάρχει αποθηκευμένη κατάσταση");
                      return;
                    }
                    await exportPDF(s, project.title || "Χάρτης", `${project.title || "canvas"}.pdf`);
                    toast.success("Εξήχθη PDF");
                  } catch (e) {
                    toast.error("Αποτυχία εξαγωγής PDF");
                    console.error(e);
                  }
                }}
              >
                <FileText className="h-4 w-4 mr-2" /> PDF με πίνακα πληροφοριών
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async () => {
                  try {
                    const s = await mapStore.load(projectId);
                    if (!s) {
                      toast.error("Δεν υπάρχει αποθηκευμένη κατάσταση");
                      return;
                    }
                    exportJSON(s, `${project.title || "canvas"}.json`);
                    toast.success("Εξήχθη JSON");
                  } catch (e) {
                    toast.error("Αποτυχία εξαγωγής JSON");
                    console.error(e);
                  }
                }}
              >
                <FileJson className="h-4 w-4 mr-2" /> JSON αντίγραφο
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={manualSaving}
            onClick={async () => {
              if (!saveApiRef.current) {
                toast.error("Ο πίνακας δεν είναι έτοιμος");
                return;
              }
              setManualSaving(true);
              try {
                await saveApiRef.current.save();
                toast.success("Αποθηκεύτηκε");
              } catch (e) {
                console.error(e);
                toast.error("Αποτυχία αποθήκευσης", {
                  description: e instanceof Error ? e.message : undefined,
                });
              } finally {
                setManualSaving(false);
              }
            }}
          >
            {manualSaving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Αποθήκευση
          </Button>
        </div>
      </header>

      <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
        {/* Global persistent tab bar */}
        <GlobalTabBar
          currentMapId={projectId}
          onTabSwitch={(mapId) => {
            const localTab = tabs.find((t) => t.mapId === mapId);
            if (localTab) setActiveTabId(localTab.id);
          }}
        />

        <div className="flex-1 flex min-h-0 overflow-hidden">
        <CanvasToolbar
          tool={tool}
          setTool={setTool}
          workspaceType={project.workspaceType ?? "free-drawing"}
        />

        {/* Canvas — only mount active tab */}
        <div className="flex-1 relative min-w-0 overflow-hidden">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const mapIdForTab = tab.id === "main" ? projectId : tab.mapId;
            return (
              // Keep ALL tabs mounted — use pointer-events + visibility to hide.
              // display:none causes unmount which loses canvas state.
              // visibility:hidden keeps component mounted and state preserved.
              <div
                key={tab.id}
                className="absolute inset-0"
                style={{
                  visibility: isActive ? "visible" : "hidden",
                  pointerEvents: isActive ? "auto" : "none",
                  zIndex: isActive ? 1 : 0,
                }}
              >
                <CanvasStage
                  mapId={mapIdForTab}
                  tool={tool}
                  setTool={setTool}
                  isActive={isActive}
                  onSaveStatusChange={tab.id === "main" ? setSaveState : undefined}
                  onReady={tab.id === "main" ? (api) => { saveApiRef.current = api; } : undefined}
                  onSelectionChange={tab.id === "main" ? handleSelectionChange : undefined}
                  liveSync={tab.id === "main" ? (isCollabParticipant || isWorkspaceRoomBoard) : false}
                  liveOwner={tab.id === "main" ? (isCollabParticipant || isWorkspaceRoomBoard) : false}
                  readOnly={tab.id === "main" ? readOnly : false}
                />
              </div>
            );
          })}
          {!readOnly && selectionViaMarquee && (
            <SelectionActionsBar
              selectedObjects={selectedObjects}
              onCreateNewProject={handleCreateNewProject}
              sendTargets={sendTargets}
              onSendTo={handleSendTo}
            />
          )}
          {readOnly && (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
              <span className="flex items-center gap-1.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-3 py-1 text-xs font-semibold">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                Λειτουργία θέασης — δεν μπορείτε να επεξεργαστείτε
              </span>
            </div>
          )}
          <div className="absolute top-4 left-4 z-10 hidden sm:block">
            <Button variant="ghost" size="icon" className="h-9 w-9 panel-soft" title="Βοήθεια" aria-label="Βοήθεια">
              <HelpCircle className="h-4 w-4" />
            </Button>
          </div>
          <MobileCanvasNotice />
        </div>
        </div>
      </div>
      <QuotaWarningSurface />
      {user && (
        <SendProjectDialog
          open={sendDialogOpen}
          onOpenChange={setSendDialogOpen}
          projectId={projectId}
          projectTitle={project?.title ?? "Σχέδιο"}
          fromUserId={user.uid}
          fromUserName={user.displayName || user.email || "Χρήστης"}
        />
      )}
    </div>
  );
}

function MobileCanvasNotice() {
  return (
    <div className="sm:hidden absolute top-2 left-2 right-2 z-20 panel-soft text-xs text-muted-foreground px-3 py-2 rounded-md bg-amber-50/95 border border-amber-200 text-amber-900">
      Ο πίνακας λειτουργεί καλύτερα σε μεγαλύτερη οθόνη (tablet ή desktop).
    </div>
  );
}

function EditableTitle({
  title,
  readOnly,
  onSave,
}: {
  title: string;
  readOnly: boolean;
  onSave: (t: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(title);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!editing) setValue(title);
  }, [title, editing]);

  const commit = async () => {
    const trimmed = value.trim();
    setEditing(false);
    if (!trimmed || trimmed === title) {
      setValue(title);
      return;
    }
    setSaving(true);
    try {
      await onSave(trimmed);
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία μετονομασίας");
      setValue(title);
    } finally {
      setSaving(false);
    }
  };

  if (readOnly) {
    return <span className="text-sm font-medium truncate">{title}</span>;
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setValue(title);
            setEditing(false);
          }
        }}
        className="text-sm font-medium bg-transparent border-b border-primary outline-none min-w-0 w-40"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className="group flex items-center gap-1.5 min-w-0"
      title="Μετονομασία σχεδίου"
    >
      <span className="text-sm font-medium truncate">{title}</span>
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
      ) : (
        <Pencil className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
      )}
    </button>
  );
}

function SendProjectDialog({
  open,
  onOpenChange,
  projectId,
  projectTitle,
  fromUserId,
  fromUserName,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  projectId: string;
  projectTitle: string;
  fromUserId: string;
  fromUserName: string;
}) {
  const [email, setEmail] = useState("");
  const [permission, setPermission] = useState<"view" | "edit">("edit");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEmail("");
      setPermission("edit");
    }
  }, [open]);

  const submit = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const match = await findUserByEmail(trimmed);
      if (!match) {
        toast.error("Δεν βρέθηκε χρήστης με αυτό το email.");
        return;
      }
      if (match.uid === fromUserId) {
        toast.error("Δεν μπορείτε να στείλετε το σχέδιο στον εαυτό σας.");
        return;
      }
      await sendDesignToUser({
        fromUserId,
        fromUserName,
        toUserId: match.uid,
        sourceProjectId: projectId,
        sourceTitle: projectTitle,
        permission,
      });
      toast.success(`Στάλθηκε στον/στην ${match.displayName}`);
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία αποστολής");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Αποστολή σχεδίου σε</DialogTitle>
          <DialogDescription>
            Ο παραλήπτης θα λάβει το δικό του, ανεξάρτητο αντίγραφο — δεν επηρεάζεται το δικό σας.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="send-email">Email παραλήπτη</Label>
            <Input
              id="send-email"
              type="email"
              placeholder="onoma@example.com"
              value={email}
              autoFocus
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Δικαίωμα πρόσβασης</Label>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => setPermission("view")}
                className={`h-9 rounded-md border text-xs transition-colors ${
                  permission === "view"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-muted text-muted-foreground"
                }`}
              >
                Μόνο προβολή
              </button>
              <button
                type="button"
                onClick={() => setPermission("edit")}
                className={`h-9 rounded-md border text-xs transition-colors ${
                  permission === "edit"
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border hover:bg-muted text-muted-foreground"
                }`}
              >
                Επεξεργάσιμο
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {permission === "view"
                ? "Θα μπορεί μόνο να το δει, όχι να το αλλάξει."
                : "Θα μπορεί να το αποθηκεύσει και να το επεξεργαστεί ελεύθερα."}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Άκυρο
          </Button>
          <Button onClick={submit} disabled={busy || !email.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Αποστολή
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
