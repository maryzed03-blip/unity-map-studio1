// SharePanel — "Διαμοιρασμός σχεδίου" for a project.
// Renders: a header button, a start-share dialog, and a collapsible side panel.

import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  shareProject,
  endProjectShare,
  sendInvitation,
  setEditPermission,
  subscribeProjectSession,
  sendDesignToUser,
  type LiveSession,
} from "@/lib/live-sessions";
import { usePresence } from "@/components/live/LivePanels";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Share2,
  Users,
  UserCheck,
  UserX,
  Loader2,
  Radio,
  Crown,
  StopCircle,
  ChevronRight,
  ChevronLeft,
  MoreHorizontal,
  Send,
} from "lucide-react";
import { toast } from "sonner";
import type { WorkspaceType } from "@/lib/projects";

interface Props {
  projectId: string;
  projectTitle: string;
  workspaceType?: WorkspaceType;
  onRequestSave?: () => Promise<void>;
}

// Shared state lives in a context-like singleton per projectId
// so both the header button and the side panel stay in sync.
export function useShareState(projectId: string) {
  const [session, setSession] = useState<LiveSession | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    let prev: LiveSession | null = null;
    return subscribeProjectSession(projectId, (s) => {
      setSession(s);
      // Auto-open panel when share starts for the first time
      if (s && !prev) setPanelOpen(true);
      prev = s;
    });
  }, [projectId]);

  return { session, panelOpen, setPanelOpen };
}

// ── Header trigger button ────────────────────────────────────────────
export function ShareTriggerButton({
  session,
  panelOpen,
  setPanelOpen,
  onStartShare,
}: {
  session: LiveSession | null;
  panelOpen: boolean;
  setPanelOpen: (v: boolean) => void;
  onStartShare: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5"
      onClick={() => (session ? setPanelOpen(!panelOpen) : onStartShare())}
    >
      <Share2 className="h-4 w-4" />
      {session ? (
        <span className="flex items-center gap-1">
          Διαμοιρασμός
          <Badge variant="default" className="h-4 px-1 text-[10px]">LIVE</Badge>
        </span>
      ) : "Διαμοιρασμός σχεδίου"}
    </Button>
  );
}

// ── Full SharePanel component ────────────────────────────────────────
export function SharePanel({ projectId, projectTitle, workspaceType, onRequestSave }: Props) {
  const { user, profile } = useAuth();
  const presence = usePresence();

  const { session, panelOpen, setPanelOpen } = useShareState(projectId);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!user || !profile) return null;

  const isOwner = !session || session.teacherId === user.uid;
  const onlineOthers = Object.entries(presence).filter(
    ([uid, p]) => uid !== user.uid && p.state === "online",
  );
  const participants = session?.participantIds.filter((id) => id !== user.uid) ?? [];

  const startShare = async () => {
    setLoading(true);
    try {
      if (onRequestSave) await onRequestSave();
      await shareProject({
        ownerId: user.uid,
        ownerName: profile.displayName,
        projectId,
        projectTitle,
        workspaceType: workspaceType ?? "free-drawing",
      });
      setDialogOpen(false);
      setPanelOpen(true);
      toast.success("Ο διαμοιρασμός ξεκίνησε — το σχέδιο αποθηκεύτηκε και είναι ορατό");
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία εκκίνησης διαμοιρασμού");
    } finally {
      setLoading(false);
    }
  };

  const endShare = async () => {
    if (!session) return;
    if (!confirm("Να τερματιστεί ο διαμοιρασμός;")) return;
    setLoading(true);
    try {
      await endProjectShare(session.id, user.uid);
      setPanelOpen(false);
      toast.success("Ο διαμοιρασμός τερματίστηκε");
    } catch (e) {
      toast.error("Αποτυχία τερματισμού");
    } finally {
      setLoading(false);
    }
  };

  const invite = async (uid: string, displayName: string) => {
    if (!session) return;
    try {
      await sendInvitation({
        sessionId: session.id,
        fromUserId: user.uid,
        fromUserName: profile.displayName,
        toUserId: uid,
      });
      toast.success(`Πρόσκληση στάλθηκε σε ${displayName}`);
    } catch { toast.error("Αποτυχία πρόσκλησης"); }
  };

  const inviteAll = async () => {
    if (!session) return;
    setLoading(true);
    try {
      const toInvite = onlineOthers.filter(([uid]) => !session.participantIds.includes(uid));
      await Promise.all(toInvite.map(([uid, p]) => sendInvitation({
        sessionId: session.id,
        fromUserId: user.uid,
        fromUserName: profile.displayName,
        toUserId: uid,
      })));
      toast.success(`Προσκλήσεις σε ${toInvite.length} χρήστες`);
    } catch { toast.error("Αποτυχία μαζικής πρόσκλησης"); }
    finally { setLoading(false); }
  };

  const toggleEdit = async (uid: string, canEdit: boolean) => {
    if (!session) return;
    try {
      await setEditPermission(session.id, uid, !canEdit);
      toast.success(canEdit ? "Αφαιρέθηκε η άδεια" : "Δόθηκε άδεια επεξεργασίας");
    } catch { toast.error("Αποτυχία αλλαγής δικαιώματος"); }
  };

  const sendDesign = async (uid: string, displayName: string) => {
    try {
      await sendDesignToUser({
        fromUserId: user.uid,
        fromUserName: profile.displayName,
        toUserId: uid,
        sourceProjectId: projectId,
        sourceTitle: projectTitle,
      });
      toast.success(`Το σχέδιο στάλθηκε στον/στην ${displayName}`);
    } catch { toast.error("Αποτυχία αποστολής"); }
  };

  return (
    <>
      {/* Header trigger button */}
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5"
        onClick={() => session ? setPanelOpen(!panelOpen) : setDialogOpen(true)}
      >
        <Share2 className="h-4 w-4" />
        {session ? (
          <span className="flex items-center gap-1">
            Διαμοιρασμός
            <Badge variant="default" className="h-4 px-1 text-[10px]">LIVE</Badge>
          </span>
        ) : "Διαμοιρασμός σχεδίου"}
      </Button>

      {/* Start share dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Share2 className="h-4 w-4" /> Διαμοιρασμός σχεδίου
            </DialogTitle>
            <DialogDescription>
              Θα αποθηκευτεί αυτόματα και άλλοι θα μπορούν να δουν το σχέδιό σας.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4 flex flex-col items-center gap-3">
            <div className="rounded-full bg-primary/10 p-4">
              <Radio className="h-8 w-8 text-primary" />
            </div>
            <p className="text-sm text-center text-muted-foreground">
              Μοιραστείτε αυτό το σχέδιο σε πραγματικό χρόνο. Οι προσκεκλημένοι θα βλέπουν το πραγματικό περιεχόμενο.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Άκυρο</Button>
            <Button onClick={startShare} disabled={loading} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
              Έναρξη διαμοιρασμού
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Collapsible side panel — only when sharing */}
      {session && (
        <div className="fixed right-0 top-14 bottom-0 flex z-30 pointer-events-none">
          {/* Toggle tab */}
          <button
            onClick={() => setPanelOpen((v) => !v)}
            className="pointer-events-auto self-center flex h-12 w-5 items-center justify-center rounded-l-md border border-border bg-surface shadow-sm hover:bg-muted transition-colors"
            title={panelOpen ? "Κλείσιμο πάνελ" : "Άνοιγμα πάνελ διαμοιρασμού"}
          >
            {panelOpen ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
          </button>

          {panelOpen && (
            <div className="pointer-events-auto w-72 border-l border-border bg-surface flex flex-col shadow-xl">
              {/* Header */}
              <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-[color:var(--success)] animate-pulse" />
                  <span className="text-sm font-semibold">Διαμοιρασμός</span>
                  <Badge variant="secondary" className="text-[10px] h-4 px-1">
                    {participants.length + 1}
                  </Badge>
                </div>
                {isOwner && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 px-2 text-xs gap-1 text-destructive hover:text-destructive"
                    onClick={endShare}
                    disabled={loading}
                  >
                    <StopCircle className="h-3 w-3" /> Λήξη
                  </Button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-3 space-y-4">
                {/* Invite all */}
                {isOwner && onlineOthers.filter(([uid]) => !session.participantIds.includes(uid)).length > 0 && (
                  <Button size="sm" variant="outline" className="w-full gap-2 text-xs" onClick={inviteAll} disabled={loading}>
                    <Users className="h-3.5 w-3.5" />
                    Προσκαλέστε Όλους Online
                  </Button>
                )}

                {/* In session */}
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                    Στο σχέδιο ({participants.length + 1})
                  </p>
                  <ul className="space-y-1">
                    <li className="flex items-center gap-2 rounded-md px-2 py-1.5 bg-muted/50">
                      <span className="h-2 w-2 rounded-full bg-[color:var(--success)] shrink-0" />
                      <span className="flex-1 text-sm truncate font-medium">
                        {profile.displayName}
                        <span className="text-[10px] text-muted-foreground ml-1">(εσείς)</span>
                      </span>
                      <Crown className="h-3 w-3 text-muted-foreground" />
                    </li>
                    {participants.map((uid) => {
                      const name = presence[uid]?.displayName ?? uid.slice(0, 8);
                      const online = presence[uid]?.state === "online";
                      const canEdit = (session.editPermissions ?? []).includes(uid);
                      return (
                        <li key={uid} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
                          <span className={`h-2 w-2 rounded-full shrink-0 ${online ? "bg-[color:var(--success)]" : "bg-muted-foreground/40"}`} />
                          <span className="flex-1 text-sm truncate">{name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded shrink-0 ${canEdit ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
                            {canEdit ? "Επεξ." : "Θέαση"}
                          </span>
                          {isOwner && (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0">
                                  <MoreHorizontal className="h-3.5 w-3.5" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className="w-52">
                                {canEdit ? (
                                  <DropdownMenuItem onClick={() => toggleEdit(uid, true)}>
                                    <UserX className="h-4 w-4 mr-2" /> Αφαίρεσε άδεια επεξεργασίας
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onClick={() => toggleEdit(uid, false)}>
                                    <UserCheck className="h-4 w-4 mr-2" /> Δώσε άδεια επεξεργασίας
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => sendDesign(uid, name)}>
                                  <Send className="h-4 w-4 mr-2" /> Στείλε το σχέδιο
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>

                {/* Online not yet in session */}
                {isOwner && (() => {
                  const notIn = onlineOthers.filter(([uid]) => !session.participantIds.includes(uid));
                  if (notIn.length === 0) return null;
                  return (
                    <div>
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                        Online — δεν έχουν μπει
                      </p>
                      <ul className="space-y-1">
                        {notIn.map(([uid, p]) => (
                          <li key={uid} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/60">
                            <span className="h-2 w-2 rounded-full bg-[color:var(--success)] shrink-0" />
                            <span className="flex-1 text-sm truncate">{p.displayName || uid.slice(0, 8)}</span>
                            <Button size="sm" variant="ghost" className="h-6 px-2 text-xs shrink-0"
                              onClick={() => invite(uid, p.displayName)}>
                              Πρόσκληση
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
