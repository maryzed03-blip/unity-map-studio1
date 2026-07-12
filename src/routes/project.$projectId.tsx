import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ClientOnly } from "@/lib/client-only";
import { getProject, type Project } from "@/lib/projects";
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
import { exportPNG, exportSVG, exportJSON } from "@/lib/canvas/export";
import { mapStore } from "@/lib/canvas/storage";
import { AIPanel } from "@/components/ai/AIPanel";
import type { CanvasObject } from "@/lib/canvas/types";
import { SharePanel } from "@/components/live/SharePanel";
import { subscribeProjectSession, type LiveSession } from "@/lib/live-sessions";

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
  } | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [shareSession, setShareSession] = useState<LiveSession | null>(null);

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

  // Subscribe to active share session for this project
  useEffect(() => {
    return subscribeProjectSession(projectId, setShareSession);
  }, [projectId]);

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

  // readOnly = sharing active AND current user is not owner AND not in editPermissions
  const { user } = useAuth();
  const readOnly =
    !!shareSession &&
    shareSession.teacherId !== user?.uid &&
    !(shareSession.editPermissions ?? []).includes(user?.uid ?? "");

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
            <span className="text-sm font-medium truncate">{project.title}</span>
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
          <SharePanel
            projectId={projectId}
            projectTitle={project.title}
            workspaceType={project.workspaceType ?? "free-drawing"}
            onRequestSave={() => saveApiRef.current?.save() ?? Promise.resolve()}
          />
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
            const mapIdForTab = tab.id === "main"
              ? (readOnly ? shareSession?.mainBoardId ?? projectId : projectId)
              : tab.mapId;
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
                  liveSync={tab.id === "main" ? (!!shareSession || isWorkspaceRoomBoard) : false}
                  liveOwner={tab.id === "main" ? (!!shareSession || isWorkspaceRoomBoard) : false}
                  readOnly={tab.id === "main" ? readOnly : false}
                />
              </div>
            );
          })}
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
