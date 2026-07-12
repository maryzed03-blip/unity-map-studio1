// LiveClassButton — the single entry point for the live classroom.
//
// Replaces the old "Ζωντανά μαθήματα" browsable list entirely. Sits next
// to the "Νέο σχέδιο" button on the projects tab.
//
// Gating rule (real-time, not polling): a student can only enter once the
// teacher's presence record shows they are actually inside this exact
// session (presence[teacherId].currentSessionId === session.id via the
// Firebase Realtime Database — see src/lib/presence.ts). Session.status
// alone is not enough, because a teacher can create a session and then
// step away before actually walking into the room.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useAuth } from "@/lib/auth-context";
import { subscribePresence, type PresenceMap } from "@/lib/presence";
import {
  createLiveSession,
  joinLiveSessionDirect,
  notifyOnlineUsers,
  subscribeActiveSession,
  subscribeTeacherSession,
  type LiveSession,
} from "@/lib/live-sessions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Radio, Loader2 } from "lucide-react";
import { toast } from "sonner";

function usePresenceMap(): PresenceMap {
  const [map, setMap] = useState<PresenceMap>({});
  useEffect(() => subscribePresence(setMap), []);
  return map;
}

function useActiveSession(): LiveSession | null | undefined {
  const [session, setSession] = useState<LiveSession | null | undefined>(undefined);
  useEffect(() => subscribeActiveSession(setSession), []);
  return session;
}

/** The signed-in teacher's own session (active OR paused). Distinct from
 *  useActiveSession, which only sees status === "active" and would miss a
 *  paused session entirely — leaving a refreshed teacher with no way back
 *  in except accidentally starting a duplicate. */
function useMyTeacherSession(uid: string | undefined): LiveSession | null | undefined {
  const [session, setSession] = useState<LiveSession | null | undefined>(undefined);
  useEffect(() => {
    if (!uid) { setSession(null); return; }
    return subscribeTeacherSession(uid, setSession);
  }, [uid]);
  return session;
}

export function LiveClassButton() {
  const { user, profile } = useAuth();
  const isTeacher = profile?.role === "teacher" || profile?.role === "therapist";
  const session = useActiveSession();
  const presence = usePresenceMap();
  const navigate = useNavigate();

  const teacherInRoom = useMemo(() => {
    if (!session) return false;
    const p = presence[session.teacherId];
    return !!p && p.state === "online" && p.currentSessionId === session.id;
  }, [session, presence]);

  if (!user || !profile) return null;
  return isTeacher ? (
    <TeacherButton session={session} />
  ) : (
    <StudentButton session={session} teacherInRoom={teacherInRoom} />
  );
}

// ── Teacher variant ────────────────────────────────────────────────
function TeacherButton({
  session,
}: {
  session: LiveSession | null | undefined;
}) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const presence = usePresenceMap();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);

  const myActiveSession = useMyTeacherSession(user?.uid);
  const teacherInRoom = useMemo(() => {
    if (!myActiveSession || !user) return false;
    const p = presence[user.uid];
    return myActiveSession.status === "active" && !!p && p.state === "online" && p.currentSessionId === myActiveSession.id;
  }, [myActiveSession, presence, user]);

  const start = async () => {
    if (!user || !profile || !title.trim()) return;
    setBusy(true);
    try {
      const s = await createLiveSession({
        teacherId: user.uid,
        teacherName: profile.displayName,
        title: title.trim(),
        workspaceType: "free-drawing",
      });
      const onlineUids = Object.entries(presence)
        .filter(([uid, p]) => uid !== user.uid && p.state === "online")
        .map(([uid]) => uid);
      if (onlineUids.length > 0) {
        await notifyOnlineUsers(s, profile.displayName, onlineUids).catch(() => {});
      }
      setOpen(false);
      setTitle("");
      navigate({ to: "/live/$sessionId", params: { sessionId: s.id } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Αποτυχία δημιουργίας μαθήματος";
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  };

  // A session already exists that this teacher owns — button re-enters it.
  // If it's paused, entering the /live/$sessionId route auto-resumes it.
  if (myActiveSession) {
    return (
      <Button
        size="lg"
        className="gap-2 bg-blue-600 hover:bg-blue-700 text-white shadow-sm relative"
        onClick={() => navigate({ to: "/live/$sessionId", params: { sessionId: myActiveSession.id } })}
      >
        <Radio className="h-4 w-4" />
        Ζωντανό Μάθημα
        {teacherInRoom && (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold tracking-wide">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </span>
        )}
        {myActiveSession.status === "paused" && (
          <span className="ml-1 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold tracking-wide">
            ⏸ Συνέχεια
          </span>
        )}
      </Button>
    );
  }

  // Someone else's session is active — don't let a second one start.
  const blockedByOther = !!session;

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) setTitle(""); }}>
      <Button
        size="lg"
        className="gap-2 bg-blue-600 hover:bg-blue-700 text-white shadow-sm"
        disabled={blockedByOther}
        title={blockedByOther ? "Υπάρχει ήδη ενεργό ζωντανό μάθημα." : undefined}
        onClick={() => setOpen(true)}
      >
        <Radio className="h-4 w-4" />
        Ζωντανό Μάθημα
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Έναρξη Ζωντανού Μαθήματος</DialogTitle>
          <DialogDescription>
            Μόλις μπείτε μέσα, οι μαθητές θα δουν την ένδειξη LIVE και θα μπορούν να συνδεθούν.
          </DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Τίτλος μαθήματος"
          value={title}
          autoFocus
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && start()}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Άκυρο</Button>
          <Button onClick={start} disabled={busy || !title.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Έναρξη
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Student variant ────────────────────────────────────────────────
function StudentButton({
  session,
  teacherInRoom,
}: {
  session: LiveSession | null | undefined;
  teacherInRoom: boolean;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [joining, setJoining] = useState(false);

  const enabled = !!session && teacherInRoom;

  const enter = async () => {
    if (!user || !session || !enabled) return;
    setJoining(true);
    try {
      if (!session.participantIds.includes(user.uid)) {
        await joinLiveSessionDirect(session.id, user.uid);
      }
      navigate({ to: "/live/$sessionId", params: { sessionId: session.id } });
    } catch {
      toast.error("Δεν ήταν δυνατή η είσοδος στο μάθημα");
    } finally {
      setJoining(false);
    }
  };

  const helper = !session
    ? "Δεν υπάρχει ζωντανό μάθημα αυτή τη στιγμή"
    : !teacherInRoom
      ? "Ο καθηγητής δεν έχει μπει ακόμη"
      : undefined;

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="lg"
        className="gap-2 bg-blue-600 hover:bg-blue-700 text-white shadow-sm disabled:opacity-40 disabled:bg-blue-600"
        disabled={!enabled || joining}
        onClick={enter}
        title={helper}
      >
        {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
        Ζωντανό Μάθημα
        {enabled && (
          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-white/20 px-2 py-0.5 text-[10px] font-bold tracking-wide">
            <span className="h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" />
            LIVE
          </span>
        )}
      </Button>
      {helper && <span className="text-[11px] text-muted-foreground">{helper}</span>}
    </div>
  );
}
