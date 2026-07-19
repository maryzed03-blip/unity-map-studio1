import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { ClientOnly } from "@/lib/client-only";
import { subscribeSession, pauseSession, resumeSession, notifySessionPaused, endSessionAndSave, type LiveSession } from "@/lib/live-sessions";
import { setCurrentSession } from "@/lib/presence";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  PauseCircle,
  Loader2,
  Radio,
  Save,
  Download,
  FileImage,
  FileCode2,
  FileJson,
  MonitorPlay,
  Eye,
  Pencil,
} from "lucide-react";
import { CanvasStage } from "@/components/canvas/CanvasStage";
import { CanvasToolbar } from "@/components/canvas/Toolbar";
import { CanvasTabs, type CanvasTab } from "@/components/canvas/CanvasTabs";
import type { ToolId } from "@/lib/workspaces";
import { subscribeGroupRooms, type GroupRoom } from "@/lib/live-sessions";
import {
  TeacherSessionPanel,
  StudentSessionPanel,
  CreatorSessionPanel,
  CollapsibleLivePanel,
  GroupRoomsPanel,
} from "@/components/live/LivePanels";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { exportPNG, exportSVG, exportJSON } from "@/lib/canvas/export";
import { mapStore } from "@/lib/canvas/storage";
import { QuotaWarningSurface } from "@/components/QuotaWarningSurface";

// ── Route ──────────────────────────────────────────────────────────────

function LiveErrorFallback({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 px-4 text-center">
      <p className="text-base font-medium">Παρουσιάστηκε σφάλμα στη ζωντανή συνεδρία.</p>
      <p className="text-xs text-muted-foreground max-w-md">{error?.message}</p>
      <div className="flex gap-2">
        <Button variant="outline" onClick={reset}>Δοκιμή ξανά</Button>
        <Button asChild><Link to="/lobby">Επιστροφή στο Lobby</Link></Button>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/live/$sessionId")({
  ssr: false,
  head: () => ({ meta: [{ title: "Ζωντανό Μάθημα — Unity Map Studio" }] }),
  component: () => (
    <ClientOnly fallback={<div className="min-h-screen bg-background" />}>
      <LiveGate />
    </ClientOnly>
  ),
  errorComponent: LiveErrorFallback,
});

function LiveGate() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [loading, user, navigate]);
  if (loading || !user) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  return <LiveRoom />;
}

// ── EndedSessionBar ────────────────────────────────────────────────────

function EndedSessionBar({ session }: { session: LiveSession }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);

  const saveAsDraft = async () => {
    if (!user) return;
    setSaving(true);
    try {
      const { duplicateProject } = await import("@/lib/projects");
      const newId = await duplicateProject(user.uid, session.mainBoardId, `${session.title} (αντίγραφο)`);
      toast.success("Αποθηκεύτηκε στη βιβλιοθήκη σας");
      navigate({ to: "/project/$projectId", params: { projectId: newId } });
    } catch { toast.error("Αποτυχία αποθήκευσης"); }
    finally { setSaving(false); }
  };

  return (
    <div className="shrink-0 border-b border-border bg-amber-50 dark:bg-amber-950/30 px-4 py-2 flex items-center gap-3 flex-wrap">
      <span className="text-xs font-medium text-amber-800 dark:text-amber-200 flex-1">
        📋 Το μάθημα έχει λήξει — προβολή μόνο.
      </span>
      <div className="flex items-center gap-2 shrink-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5 h-7 text-xs">
              <Download className="h-3.5 w-3.5" /> Εξαγωγή
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={async () => { try { await exportPNG(`${session.title}.png`); toast.success("PNG εξήχθη"); } catch { toast.error("Αποτυχία"); } }}>
              <FileImage className="h-4 w-4 mr-2" /> PNG εικόνα
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { try { exportSVG(`${session.title}.svg`); toast.success("SVG εξήχθη"); } catch { toast.error("Αποτυχία"); } }}>
              <FileCode2 className="h-4 w-4 mr-2" /> SVG διάνυσμα
            </DropdownMenuItem>
            <DropdownMenuItem onClick={async () => {
              try {
                const s = await mapStore.load(session.mainBoardId);
                if (s) { exportJSON(s, `${session.title}.json`); toast.success("JSON εξήχθη"); }
              } catch { toast.error("Αποτυχία"); }
            }}>
              <FileJson className="h-4 w-4 mr-2" /> JSON αντίγραφο
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" className="gap-1.5 h-7 text-xs" onClick={saveAsDraft} disabled={saving}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Αποθήκευση στη βιβλιοθήκη μου
        </Button>
      </div>
    </div>
  );
}

// ── Main LiveRoom component ────────────────────────────────────────────

function LiveRoom() {
  const { sessionId } = Route.useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [session, setSession] = useState<LiveSession | null | undefined>(undefined);
  const [tool, setTool] = useState<ToolId>("select");
  const [showBanner, setShowBanner] = useState(true);
  const [groups, setGroups] = useState<GroupRoom[]>([]);
  const [manualSaving, setManualSaving] = useState(false);
  const [leaveChoiceOpen, setLeaveChoiceOpen] = useState(false);
  const [leaveBusy, setLeaveBusy] = useState<"pause" | "end" | null>(null);
  const saveApiRef = useRef<{ save: () => Promise<void> } | null>(null);

  // Tab system — each tab has its own mapId
  const [tabs, setTabs] = useState<CanvasTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>("");

  useEffect(() => subscribeGroupRooms(sessionId, setGroups), [sessionId]);

  useEffect(() => {
    const t = setTimeout(() => setShowBanner(false), 4000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    try { setCurrentSession(sessionId); } catch { /**/ }
    return () => { try { setCurrentSession(null); } catch { /**/ } };
  }, [sessionId]);

  useEffect(() => {
    return subscribeSession(sessionId, (s) => {
      setSession(s);
      if (s) {
        // Register live tab in global persistent store
        import("@/lib/tab-store").then(({ tabStore }) => {
          tabStore.openTab({
            id: `live-${sessionId}`,
            mapId: s.mainBoardId,
            label: s.title,
            kind: "live",
            closeable: true,
            sessionId,
          });
        });
        // Init local tab state
        if (tabs.length === 0) {
          setTabs([{ id: "main", mapId: s.mainBoardId, label: "Ζωντανό Μάθημα", kind: "live", closeable: false }]);
          setActiveTabId("main");
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Auto-resume on teacher return ─────────────────────────────────────
  // resumeSession has no other caller since the old browsable sessions
  // list (with its manual "Επανεκκίνηση" button) was removed in favour of
  // the single LiveClassButton. The teacher physically re-entering this
  // route IS the "they're back" signal, so resume right here — otherwise
  // a paused session (toolbar hidden, "wait for teacher" banner shown to
  // students) can never recover.
  useEffect(() => {
    if (!session || !user || user.uid !== session.teacherId) return;
    if (session.status !== "paused") return;
    resumeSession(session.id).catch(() => {});
  }, [session?.id, session?.status, user?.uid, session?.teacherId]);

  // ── Teacher presence monitoring ──────────────────────────────────────
  // Pause session ONLY when browser closes (beforeunload), NOT when navigating to lobby.
  useEffect(() => {
    if (!session || !user || user.uid !== session.teacherId) return;
    if (session.status !== "active") return;

    const handleBeforeUnload = () => {
      // Fire-and-forget — browser is closing
      pauseSession(session.id).catch(() => {});
      notifySessionPaused(session, session.teacherName).catch(() => {});
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [session?.id, session?.status, user?.uid]);

  // Open a collab room as a new tab
  const openRoomTab = useCallback((roomId: string, boardId: string, name: string) => {
    setTabs((prev) => {
      const existing = prev.find((t) => t.mapId === boardId);
      if (existing) { setActiveTabId(existing.id); return prev; }
      const newTab: CanvasTab = {
        id: `room-${roomId}`,
        mapId: boardId,
        label: name,
        kind: "collab",
        closeable: true,
      };
      setActiveTabId(newTab.id);
      return [...prev, newTab];
    });
  }, []);

  // Open a personal board as a new tab
  const openPersonalTab = useCallback(async () => {
    if (!user) return;
    try {
      const { createProject } = await import("@/lib/projects");
      const newId = await createProject(user.uid, "Νέο σχέδιο", "personal");
      const newTab: CanvasTab = {
        id: `personal-${newId}`,
        mapId: newId,
        label: "Νέο σχέδιο",
        kind: "personal",
        closeable: true,
      };
      setTabs((prev) => [...prev, newTab]);
      setActiveTabId(newTab.id);
    } catch { toast.error("Αποτυχία δημιουργίας σχεδίου"); }
  }, [user]);

  const closeTab = useCallback((tabId: string) => {
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === tabId);
      const next = prev.filter((t) => t.id !== tabId);
      if (activeTabId === tabId && next.length > 0) {
        setActiveTabId(next[next.length - 1].id);
      }
      // Personal tabs: only keep if they have content (>1 object)
      if (tab && tab.kind === "personal" && user) {
        import("@/lib/canvas/storage").then(({ mapStore }) => {
          mapStore.load(tab.mapId).then((state) => {
            if (!state || state.objects.length <= 1) {
              console.log(`Tab ${tab.label} was empty, not saving as draft.`);
            }
            // Content tabs are already auto-saved
          });
        });
      }
      return next;
    });
  }, [activeTabId, user]);

  const goToMain = useCallback(() => setActiveTabId("main"), []);

  const isTeacher = user?.uid === (session?.teacherId ?? "");
  const isParticipant = !!user && !!(session?.participantIds ?? []).includes(user.uid);

  // The moment a student's group membership changes (whether they clicked
  // "Είσοδος" themselves or the teacher added them via the group panel),
  // give them a real tab — same model the teacher already uses for group
  // boards — instead of silently swapping their one-and-only canvas.
  const lastNotifiedGroupRef = useRef<string | null>(null);
  const hasNotifiedOnceRef = useRef(false);
  useEffect(() => {
    if (!user || isTeacher) return;
    const myGroup = groups.find((g) => g.participantIds.includes(user.uid));
    const myGroupId = myGroup?.id ?? null;
    if (myGroupId !== lastNotifiedGroupRef.current) {
      if (myGroup) {
        toast.success(`Είστε στην ομάδα «${myGroup.name}»`, { duration: 5000 });
        openRoomTab(myGroup.id, myGroup.boardId, `👥 ${myGroup.name}`);
        // Reassignment: drop any OTHER stale collab tab (e.g. their
        // previous group) so it can't linger around still editable —
        // openRoomTab above already made the new group's tab active.
        setTabs((prev) => prev.filter((t) => t.kind !== "collab" || t.mapId === myGroup.boardId));
      } else {
        if (hasNotifiedOnceRef.current) toast.info("Βγήκατε από την ομάδα", { duration: 3000 });
        // Left every group — drop any lingering collab tab and, if that
        // was the tab being viewed, fall back to the main lesson.
        setTabs((prev) => {
          const stillActive = prev.some((t) => t.id === activeTabId && t.kind === "collab");
          if (stillActive) setActiveTabId("main");
          return prev.filter((t) => t.kind !== "collab");
        });
      }
      lastNotifiedGroupRef.current = myGroupId;
      hasNotifiedOnceRef.current = true;
    }
  }, [groups, user, isTeacher, openRoomTab]);

  // Guard conditions — all hooks must be above these
  if (session === undefined) return <div className="min-h-screen flex items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  if (!session) return <div className="min-h-screen flex flex-col items-center justify-center gap-3"><p className="text-sm text-muted-foreground">Η συνεδρία δεν βρέθηκε.</p><Button asChild variant="outline"><Link to="/lobby">Επιστροφή</Link></Button></div>;
  if (!session.mainBoardId) return <div className="min-h-screen flex flex-col items-center justify-center gap-3"><p className="text-sm text-muted-foreground">Ο πίνακας δεν είναι διαθέσιμος.</p><Button asChild variant="outline"><Link to="/lobby">Επιστροφή</Link></Button></div>;
  if (!isParticipant && !isTeacher) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3">
      <p className="text-sm text-muted-foreground">Δεν είστε μέλος αυτής της συνεδρίας.</p>
      <Button asChild variant="outline"><Link to="/lobby">Επιστροφή</Link></Button>
    </div>
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Presentation mode: students see the presented board read-only
  const isPresentationMode = !isTeacher && !!session.presentingBoardId;

  // Students are read-only on the main live board UNLESS teacher granted edit permission
  const studentHasEditOnMain = !isTeacher && (session.editPermissions ?? []).includes(user?.uid ?? "");

  // The student's own group, if any — still used to know whether a group
  // tab should exist / what banner to show, but no longer force-swaps
  // their canvas. Students now use the same tab bar as the teacher: a
  // "Ζωντανό Μάθημα" tab plus one tab per group they've joined, and they
  // click between them like the teacher does.
  const myGroup = !isTeacher ? groups.find((g) => g.participantIds.includes(user?.uid ?? "")) : undefined;

  const studentOnGroupTab = !isPresentationMode && activeTab?.kind === "collab";
  const studentIsShowingOwnGroup = studentOnGroupTab;
  const studentIsShowingMain = !isPresentationMode && !studentOnGroupTab;
  // Presentation mode always overrides whatever tab a student has open —
  // it's a broadcast from the teacher, not a personal navigation choice.
  const studentBoardId = session.presentingBoardId || activeTab?.mapId || session.mainBoardId;

  // For the TEACHER, tabs still apply (main + any group boards they've
  // opened to check in on). "collab" tabs are teacher-only navigation now.
  const activeGroup = isTeacher && activeTab?.kind === "collab"
    ? groups.find((g) => g.boardId === activeTab.mapId)
    : undefined;

  const isLiveOwner = isTeacher
    ? true
    : isPresentationMode
      ? false
      : studentIsShowingOwnGroup
        ? true // any group member can co-edit with their groupmates
        : studentHasEditOnMain; // showing the central board — needs explicit permission

  const isReadOnly =
    session.status === "ended" ||
    session.status === "paused" ||
    (!isTeacher && !isLiveOwner);

  const handlePauseAndLeave = async () => {
    setLeaveBusy("pause");
    try {
      await pauseSession(session.id);
      await notifySessionPaused(session, session.teacherName).catch(() => {});
      navigate({ to: "/lobby" });
    } catch {
      toast.error("Αποτυχία παύσης");
      setLeaveBusy(null);
    }
  };

  const handleEndAndLeave = async () => {
    if (!user) return;
    setLeaveBusy("end");
    try {
      const { saved, failed } = await endSessionAndSave(session.id, user.uid);
      if (failed.length > 0) {
        toast.error(`Αποτυχία αποθήκευσης ${failed.length} σχεδίων. Το μάθημα ΔΕΝ έκλεισε.`, {
          description: failed.join(", "),
          duration: 10000,
        });
        setLeaveBusy(null);
        return;
      }
      toast.success(`Το μάθημα έληξε οριστικά. ${saved} σχέδια αποθηκεύτηκαν.`);
      navigate({ to: "/lobby" });
    } catch {
      toast.error("Αποτυχία αποθήκευσης. Το μάθημα ΔΕΝ έκλεισε.");
      setLeaveBusy(null);
    }
  };

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <header className="h-14 border-b border-border bg-surface flex items-center justify-between px-4 shrink-0 z-10">
        <div className="flex items-center gap-3 min-w-0">
          {isTeacher ? (
            <Dialog open={leaveChoiceOpen} onOpenChange={setLeaveChoiceOpen}>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 shrink-0"
                onClick={() => setLeaveChoiceOpen(true)}
              >
                <ArrowLeft className="h-4 w-4" />Lobby
              </Button>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Πριν φύγετε…</DialogTitle>
                  <DialogDescription>
                    Θέλετε να βάλετε το μάθημα σε παύση (το ξαναβρίσκετε ακριβώς όπως το αφήνετε), ή να το λήξετε οριστικά;
                  </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2 pt-2">
                  <Button
                    variant="outline"
                    className="w-full gap-2 justify-start"
                    onClick={handlePauseAndLeave}
                    disabled={leaveBusy !== null}
                  >
                    <PauseCircle className="h-4 w-4" />
                    {leaveBusy === "pause" ? "Παύση…" : "Παύση Μαθήματος"}
                  </Button>
                  <Button
                    variant="destructive"
                    className="w-full gap-2 justify-start"
                    onClick={handleEndAndLeave}
                    disabled={leaveBusy !== null}
                  >
                    <ArrowLeft className="h-4 w-4" />
                    {leaveBusy === "end" ? "Αποθήκευση και Λήξη…" : "Οριστική Λήξη"}
                  </Button>
                </div>
              </DialogContent>
            </Dialog>
          ) : (
            <Button asChild variant="ghost" size="sm" className="gap-2 shrink-0">
              <Link to="/lobby"><ArrowLeft className="h-4 w-4" />Lobby</Link>
            </Button>
          )}
          <div className="h-5 w-px bg-border shrink-0" />
          <div className="flex items-center gap-2 min-w-0">
            <Radio className="h-4 w-4 text-[color:var(--success)] shrink-0 animate-pulse" />
            <span className="text-sm font-semibold truncate">{session.title}</span>
            <Badge variant={session.status === "active" ? "default" : session.status === "paused" ? "outline" : "secondary"} className="shrink-0">
              {session.status === "active" ? "Σε εξέλιξη" : session.status === "paused" ? "⏸ Διακοπή" : "Έληξε"}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!isReadOnly && session.status === "active" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 h-7 text-xs"
              disabled={manualSaving}
              onClick={async () => {
                if (!saveApiRef.current) return;
                setManualSaving(true);
                try {
                  await saveApiRef.current.save();
                  toast.success("Αποθηκεύτηκε");
                } catch {
                  toast.error("Η αποθήκευση απέτυχε");
                } finally {
                  setManualSaving(false);
                }
              }}
            >
              {manualSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Αποθήκευση
            </Button>
          )}
          {session.presentingBoardId && !isTeacher && (
            <span className="flex items-center gap-1.5 text-xs font-bold text-primary border border-primary/30 rounded px-2 py-0.5">
              <MonitorPlay className="h-3.5 w-3.5" /> Παρουσίαση
            </span>
          )}
          <span className="hidden sm:flex items-center gap-1.5 text-xs font-bold tracking-widest uppercase text-[color:var(--success)] border border-[color:var(--success)] rounded px-2 py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-[color:var(--success)] animate-pulse" />
            Ζωντανό Μάθημα
          </span>
        </div>
      </header>

      {/* Entrance banner */}
      {showBanner && (
        <div className="absolute inset-x-0 top-14 z-50 flex justify-center pointer-events-none">
          <div className="mt-4 flex items-center gap-3 bg-primary text-primary-foreground rounded-xl px-6 py-3 shadow-xl animate-in fade-in slide-in-from-top-4 duration-300">
            <Radio className="h-5 w-5 animate-pulse" />
            <div>
              <p className="text-sm font-bold tracking-wide uppercase">Ζωντανό Μάθημα σε Εξέλιξη</p>
              <p className="text-xs opacity-80">{session.title} · Καλωσήρθατε!</p>
            </div>
          </div>
        </div>
      )}

      {/* Ended bar */}
      {session.status === "ended" && <EndedSessionBar session={session} />}
      {session.status === "paused" && !isTeacher && (
        <div className="shrink-0 border-b border-border bg-amber-50 dark:bg-amber-950/20 px-4 py-3 flex items-center gap-3">
          <span className="text-lg">⏸</span>
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-200">
              Το μάθημα διακόπηκε προσωρινά
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Ο καθηγητής αποσυνδέθηκε. Περιμένετε την επανεκκίνηση.
            </p>
          </div>
        </div>
      )}

      {/* Global persistent tab bar intentionally omitted here — inside a
          live session, CanvasTabs below already covers switching between
          the main lesson and any group boards. Showing both stacked one
          above the other was redundant and confusing. */}

      {/* Tab bar — main lesson + any group boards opened. Now shared by
          teacher and students alike (students: main + their own group, if
          any); presentation mode below overrides display regardless. */}
      {tabs.length > 1 && (
        <CanvasTabs
          tabs={tabs}
          activeId={activeTabId}
          onSwitch={setActiveTabId}
          onClose={closeTab}
        />
      )}

      {/* Main content */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Toolbar — hidden only when ended or in presentation mode */}
        {!isReadOnly && session.status === "active" && (
          <div className="shrink-0">
            <CanvasToolbar tool={tool} setTool={setTool} workspaceType={session.workspaceType} />
          </div>
        )}

        {/* Canvas */}
        <div className="flex-1 relative overflow-hidden flex flex-col" style={{ minWidth: 0 }}>
          {/* Student banners — exactly one of these three applies at a time */}
          {!isTeacher && session.status === "active" && isPresentationMode && (
            <div className="shrink-0 border-b border-border bg-primary/10 px-4 py-1.5 flex items-center gap-2">
              <MonitorPlay className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="text-xs text-primary font-medium">
                Ο καθηγητής παρουσιάζει — προβολή μόνο
              </span>
            </div>
          )}
          {!isTeacher && session.status === "active" && studentIsShowingOwnGroup && (
            <div className="shrink-0 border-b border-border bg-green-50 dark:bg-green-950/20 px-4 py-1.5 flex items-center gap-2">
              <Pencil className="h-3.5 w-3.5 text-green-600 shrink-0" />
              <span className="text-xs text-green-700 dark:text-green-400 font-medium">
                Ομάδα «{myGroup?.name}» — μπορείτε να επεξεργαστείτε μαζί με την ομάδα σας
              </span>
            </div>
          )}
          {!isTeacher && session.status === "active" && studentIsShowingMain && !studentHasEditOnMain && (
            <div className="shrink-0 border-b border-border bg-muted/50 px-4 py-1.5 flex items-center gap-2">
              <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-xs text-muted-foreground">
                Προβολή μόνο — ο καθηγητής μπορεί να σας δώσει άδεια επεξεργασίας
              </span>
            </div>
          )}
          {!isTeacher && session.status === "active" && studentIsShowingMain && studentHasEditOnMain && (
            <div className="shrink-0 border-b border-border bg-green-50 dark:bg-green-950/20 px-4 py-1.5 flex items-center gap-2">
              <Pencil className="h-3.5 w-3.5 text-green-600 shrink-0" />
              <span className="text-xs text-green-700 dark:text-green-400 font-medium">
                Έχετε άδεια επεξεργασίας από τον καθηγητή
              </span>
            </div>
          )}

          <div className="flex-1 relative overflow-hidden">
          {isPresentationMode ? (
            // Student, teacher is presenting: ignore tabs entirely, show
            // exactly what's being broadcast, read-only.
            <div className="absolute inset-0">
              <CanvasStage
                mapId={studentBoardId}
                tool={tool}
                setTool={setTool}
                isActive
                onReady={(api) => { saveApiRef.current = api; }}
                liveSync={session.status === "active"}
                liveOwner={isLiveOwner}
                readOnly={isReadOnly}
              />
            </div>
          ) : (
            // Teacher and students alike: every open tab (main lesson +
            // any group boards) stays mounted so switching between them is
            // instant and never loses in-progress edits.
            tabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              return (
                // Keep ALL tabs mounted — visibility:hidden preserves state without display:none unmount
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
                    mapId={tab.mapId}
                    tool={tool}
                    setTool={setTool}
                    isActive={isActive}
                    onReady={isActive ? (api) => { saveApiRef.current = api; } : undefined}
                    liveSync={session.status === "active"}
                    liveOwner={
                      isTeacher
                        ? isLiveOwner
                        : tab.kind === "collab" && tab.mapId === myGroup?.boardId
                          ? true // any group member can co-edit with their groupmates
                          : studentHasEditOnMain
                    }
                    readOnly={
                      isTeacher
                        ? isReadOnly
                        : session.status === "ended" ||
                          session.status === "paused" ||
                          (tab.kind === "collab" && tab.mapId === myGroup?.boardId ? false : !studentHasEditOnMain)
                    }
                  />
                </div>
              );
            })
          )}
          </div>
        </div>

        {/* Side panel */}
        <CollapsibleLivePanel>
          {isTeacher ? (
            <>
              <TeacherSessionPanel session={session} onOpenRoom={openRoomTab} />
              <div className="border-t border-border pt-3 mt-1">
                <GroupRoomsPanel session={session} isTeacher onOpenGroup={openRoomTab} />
              </div>
            </>
          ) : (
            <>
              <StudentSessionPanel
                session={session}
                currentTabLabel={
                  isPresentationMode ? "Παρουσίαση" : activeTab?.kind === "collab" ? activeTab.label : "Ζωντανό Μάθημα"
                }
              />
              <div className="border-t border-border pt-3 mt-1">
                <GroupRoomsPanel session={session} isTeacher={false} />
              </div>
            </>
          )}
        </CollapsibleLivePanel>
      </div>
      <QuotaWarningSurface />
    </div>
  );
}
