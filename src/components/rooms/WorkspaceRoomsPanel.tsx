import { useEffect, useRef, useState } from "react";
import { useAuth } from "@/lib/auth-context";
import {
  subscribeRooms, enterRoom, leaveRoom, requestToken,
  respondToTokenRequest, claimFreeToken, moveStudentToRoom,
  reconcileOfflineOccupants,
  TOKEN_AUTO_ACCEPT_MS, type WorkspaceRoom,
} from "@/lib/workspaces-rooms";
import { subscribePresence } from "@/lib/presence";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DoorOpen, Pencil, Eye, Crown, Users, Zap, LogOut } from "lucide-react";
import { toast } from "sonner";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

// Public, standalone co-working spaces shown in the lobby — independent of
// any live session. For teacher-led teams inside a live session, see
// GroupRoomsPanel in components/live/LivePanels.tsx instead.
interface Props {
  compact?: boolean;
  /** Called when user enters a room — parent can open a tab instead of navigating */
  onEnterRoom?: (room: WorkspaceRoom) => void;
}

export function WorkspaceRoomsPanel({ compact, onEnterRoom }: Props) {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<WorkspaceRoom[]>([]);
  const [myRoomId, setMyRoomId] = useState<string | null>(null);
  const [entering, setEntering] = useState<string | null>(null);
  const isTeacher = profile?.role === "teacher" || profile?.role === "therapist";
  const autoAcceptTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return subscribeRooms((r) => {
      setRooms(r);
      if (!user) return;
      const mine = r.find((room) =>
        room.occupants.includes(user.uid) || (room.teacherOccupants ?? []).includes(user.uid)
      );
      setMyRoomId(mine?.id ?? null);
      // Auto-accept token request after 30s
      r.forEach((room) => {
        if (room.tokenHolder === user.uid && room.tokenRequesterId && room.tokenRequestedAt) {
          const requestedAt = (room.tokenRequestedAt as { toMillis?: () => number })?.toMillis?.() ?? 0;
          const remaining = TOKEN_AUTO_ACCEPT_MS - (Date.now() - requestedAt);
          if (!autoAcceptTimers.current.has(room.id) && remaining > 0) {
            const t = setTimeout(() => {
              respondToTokenRequest(room.id, true);
              autoAcceptTimers.current.delete(room.id);
            }, remaining);
            autoAcceptTimers.current.set(room.id, t);
          }
        } else {
          const t = autoAcceptTimers.current.get(room.id);
          if (t) { clearTimeout(t); autoAcceptTimers.current.delete(room.id); }
        }
      });
    });
  }, [user]);

  useEffect(() => () => { autoAcceptTimers.current.forEach(clearTimeout); }, []);

  // ── Auto-cleanup on disconnect ────────────────────────────────────────
  // Fast path: if the user closes the tab/navigates away cleanly, remove
  // them from their room immediately (saving their draft in the process).
  const myRoomRef = useRef<string | null>(null);
  useEffect(() => { myRoomRef.current = myRoomId; }, [myRoomId]);
  useEffect(() => {
    if (!user) return;
    const cleanup = () => {
      if (myRoomRef.current) leaveRoom(myRoomRef.current, user.uid, isTeacher).catch(() => {});
    };
    window.addEventListener("beforeunload", cleanup);
    // NOTE: deliberately NOT calling cleanup() on unmount here — this panel
    // also unmounts when the collapsible side panel is folded (a normal UI
    // action, not "leaving the room"). Real disconnects are covered by
    // beforeunload (clean close/reload) and by the presence-based
    // reconciliation below (hard crashes, network loss).
    return () => window.removeEventListener("beforeunload", cleanup);
  }, [user?.uid, isTeacher]);

  // Slow path / safety net: for hard disconnects (crash, network loss) where
  // beforeunload never fires, any other open client reconciles stale
  // occupants against the presence system after a short grace period.
  useEffect(() => {
    if (rooms.length === 0) return;
    let cancelled = false;
    const unsubPresence = subscribePresence((presenceMap) => {
      if (cancelled) return;
      reconcileOfflineOccupants(
        rooms,
        (uid) => presenceMap[uid]?.state === "online",
        (uid) => presenceMap[uid]?.lastSeen ?? 0,
      ).catch(() => {});
    });
    return () => { cancelled = true; unsubPresence(); };
  }, [rooms]);

  const handleEnter = async (room: WorkspaceRoom) => {
    if (!user || !profile) return;
    if (myRoomId && myRoomId !== room.id) await leaveRoom(myRoomId, user.uid, isTeacher);
    setEntering(room.id);
    try {
      const result = await enterRoom(room.id, user.uid, profile.displayName, isTeacher);
      if (!result.ok) { toast.error(result.reason ?? "Δεν μπορείτε να μπείτε"); return; }
      if (onEnterRoom) {
        onEnterRoom(room); // parent handles tab opening (live route)
      } else {
        // Register in global tab store and navigate
        import("@/lib/tab-store").then(({ tabStore }) => {
          tabStore.openTab({
            id: `room-${room.id}`,
            mapId: room.boardId,
            label: `🏠 ${room.name}`,
            kind: "collab",
            closeable: true,
          });
        });
        navigate({ to: "/project/$projectId", params: { projectId: room.boardId } });
      }
    } catch { toast.error("Αποτυχία εισόδου"); }
    finally { setEntering(null); }
  };

  const handleLeave = async (room: WorkspaceRoom) => {
    if (!user) return;
    try { await leaveRoom(room.id, user.uid, isTeacher); }
    catch { toast.error("Αποτυχία εξόδου"); }
  };

  const handleMoveStudent = async (studentUid: string, targetRoomId: string) => {
    const studentName = rooms.flatMap((r) => Object.entries(r.occupantNames))
      .find(([uid]) => uid === studentUid)?.[1] ?? studentUid.slice(0, 6);
    try { await moveStudentToRoom(studentUid, studentName, targetRoomId, rooms); }
    catch { toast.error("Αποτυχία μεταφοράς"); }
  };

  if (compact) {
    // Compact view for live panel
    return (
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Χώροι Εργασίας</p>
        {rooms.map((room) => {
          const isFull = room.occupants.length >= 5;
          const iAmIn = room.occupants.includes(user?.uid ?? "") || (room.teacherOccupants ?? []).includes(user?.uid ?? "");
          const iAmToken = room.tokenHolder === user?.uid;
          const iAmReq = room.tokenRequesterId === user?.uid;
          const isTokenFree = !room.tokenHolder && room.occupants.length > 0;

          return (
            <div key={room.id} className={cn(
              "rounded-lg border p-2 text-xs transition-colors",
              iAmIn ? "border-primary/50 bg-primary/5" : "border-border",
            )}>
              <div className="flex items-center justify-between mb-1">
                <span className="font-medium">{room.name}</span>
                <div className="flex items-center gap-1">
                  <span className={cn("text-[10px]", isFull ? "text-destructive" : "text-muted-foreground")}>
                    {room.occupants.length}/5
                  </span>
                  {!iAmIn && (
                    <Button size="sm" variant={isFull ? "ghost" : "outline"} className="h-5 px-1.5 text-[10px]"
                      disabled={isFull || !!entering} onClick={() => handleEnter(room)}>
                      {isFull ? "Πλήρης" : entering === room.id ? "…" : "Είσοδος"}
                    </Button>
                  )}
                  {iAmIn && (
                    <Button size="sm" variant="ghost" className="h-5 px-1.5 text-[10px] text-destructive"
                      onClick={() => handleLeave(room)}>Έξοδος</Button>
                  )}
                </div>
              </div>
              {room.occupants.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {room.occupants.map((uid) => {
                    const name = room.occupantNames[uid] ?? uid.slice(0, 6);
                    const hasToken = room.tokenHolder === uid;
                    return (
                      <span key={uid} className={cn(
                        "flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px]",
                        hasToken ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                      )}>
                        {hasToken ? <Pencil className="h-2.5 w-2.5" /> : <Eye className="h-2.5 w-2.5" />}
                        {name}
                        {isTeacher && (
                          <Select onValueChange={(tid) => handleMoveStudent(uid, tid)}>
                            <SelectTrigger className="h-3 w-3 border-0 p-0 bg-transparent">→</SelectTrigger>
                            <SelectContent>
                              {rooms.filter(r => r.id !== room.id).map(r =>
                                <SelectItem key={r.id} value={r.id} className="text-xs">{r.name}</SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        )}
                      </span>
                    );
                  })}
                </div>
              )}
              {iAmToken && room.tokenRequesterId && (
                <div className="mt-1 flex items-center gap-1 bg-amber-50 rounded px-1.5 py-1">
                  <span className="flex-1 text-[10px] text-amber-800"><strong>{room.tokenRequesterName}</strong> ζητά σκυτάλη</span>
                  <Button size="sm" variant="default" className="h-4 px-1 text-[9px]"
                    onClick={() => respondToTokenRequest(room.id, true)}>✓</Button>
                  <Button size="sm" variant="outline" className="h-4 px-1 text-[9px]"
                    onClick={() => respondToTokenRequest(room.id, false)}>✕</Button>
                </div>
              )}
              {isTokenFree && iAmIn && (
                <Button size="sm" variant="default" className="w-full h-5 text-[10px] mt-1 gap-1"
                  onClick={() => claimFreeToken(room.id, user!.uid)}>
                  <Zap className="h-2.5 w-2.5" /> 🆓 Ελεύθερη σκυτάλη
                </Button>
              )}
              {iAmIn && !iAmToken && room.tokenHolder && !iAmReq && (
                <Button size="sm" variant="ghost" className="w-full h-5 text-[10px] mt-1"
                  onClick={() => requestToken(room.id, user!.uid, profile!.displayName)}>
                  Ζήτα σκυτάλη
                </Button>
              )}
              {iAmReq && <p className="text-[10px] text-center text-muted-foreground mt-1">⏳ Αναμονή…</p>}
            </div>
          );
        })}
      </div>
    );
  }

  // ── Full grid view for Lobby ──────────────────────────────────────────
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4">
      {rooms.map((room) => {
        const count = room.occupants.length;
        const isFull = count >= 5;
        const iAmStudent = room.occupants.includes(user?.uid ?? "");
        const iAmTeacherHere = (room.teacherOccupants ?? []).includes(user?.uid ?? "");
        const iAmIn = iAmStudent || iAmTeacherHere;
        const iAmToken = room.tokenHolder === user?.uid;
        const iAmReq = room.tokenRequesterId === user?.uid;
        const isTokenFree = !room.tokenHolder && count > 0;

        return (
          <div key={room.id} className={cn(
            "rounded-2xl border-2 flex flex-col overflow-hidden transition-all",
            iAmIn ? "border-primary shadow-md" : isFull ? "border-border opacity-70" : "border-border hover:border-primary/50 hover:shadow-sm",
          )}>
            {/* Card header */}
            <div className={cn(
              "px-4 py-3 flex items-center justify-between",
              iAmIn ? "bg-primary text-primary-foreground" : isFull ? "bg-muted" : "bg-surface",
            )}>
              <h3 className="font-semibold text-sm">{room.name}</h3>
              <Badge
                variant={isFull ? "destructive" : count === 0 ? "outline" : "secondary"}
                className="text-xs"
              >
                <Users className="h-3 w-3 mr-1" />{count}/5
              </Badge>
            </div>

            {/* Availability bar */}
            <div className={cn(
              "px-4 py-1.5 text-xs font-medium border-b border-border",
              isFull ? "bg-red-50 text-red-600 dark:bg-red-950/20 dark:text-red-400"
                : count === 0 ? "bg-green-50 text-green-600 dark:bg-green-950/20 dark:text-green-400"
                  : "bg-amber-50 text-amber-700 dark:bg-amber-950/20 dark:text-amber-400",
            )}>
              {isFull ? "● Μη διαθέσιμο"
                : count === 0 ? "● Διαθέσιμο — Κενός χώρος"
                  : `● Διαθέσιμο — ${5 - count} θέση${5 - count !== 1 ? "ς" : ""} ελεύθερη${5 - count !== 1 ? "ς" : ""}`}
            </div>

            {/* Occupants */}
            <div className="flex-1 px-4 py-3 min-h-[80px]">
              {count === 0 ? (
                <p className="text-xs text-muted-foreground italic">Κανείς δεν βρίσκεται εδώ</p>
              ) : (
                <ul className="space-y-1.5">
                  {room.occupants.map((uid) => {
                    const name = room.occupantNames[uid] ?? uid.slice(0, 6);
                    const hasToken = room.tokenHolder === uid;
                    const isReq = room.tokenRequesterId === uid;
                    return (
                      <li key={uid} className="flex items-center gap-2 text-sm">
                        {hasToken
                          ? <Pencil className="h-3.5 w-3.5 text-primary shrink-0" />
                          : <Eye className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                        <span className={cn("flex-1 truncate", hasToken && "font-semibold text-primary")}>
                          {name}
                        </span>
                        {hasToken && <Crown className="h-3.5 w-3.5 text-amber-500 shrink-0" />}
                        {isReq && <span className="text-[10px] text-amber-600">⏳</span>}
                        {/* Teacher move student */}
                        {isTeacher && !iAmStudent && rooms.length > 1 && (
                          <Select onValueChange={(tid) => handleMoveStudent(uid, tid)}>
                            <SelectTrigger className="h-5 w-14 text-[10px] px-1 shrink-0">→</SelectTrigger>
                            <SelectContent>
                              {rooms.filter(r => r.id !== room.id).map(r =>
                                <SelectItem key={r.id} value={r.id} className="text-xs">{r.name}</SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        )}
                      </li>
                    );
                  })}
                  {/* Teacher invisible slot */}
                  {(room.teacherOccupants ?? []).map((uid) => (
                    <li key={uid} className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Crown className="h-3 w-3 shrink-0" />
                      <span className="truncate">{room.occupantNames[uid] ?? uid.slice(0, 6)}</span>
                      <span className="text-[10px] ml-auto">παρατηρητής</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Token request notification */}
            {iAmToken && room.tokenRequesterId && (
              <div className="mx-4 mb-2 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200 px-3 py-2">
                <p className="text-xs text-amber-800 dark:text-amber-200 mb-2">
                  <strong>{room.tokenRequesterName}</strong> ζητά τη σκυτάλη
                  <span className="text-[10px] block text-amber-600">Αυτόματη αποδοχή σε 30s</span>
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="default" className="flex-1 h-7 text-xs"
                    onClick={() => respondToTokenRequest(room.id, true)}>Αποδοχή</Button>
                  <Button size="sm" variant="outline" className="flex-1 h-7 text-xs"
                    onClick={() => respondToTokenRequest(room.id, false)}>Άρνηση</Button>
                </div>
              </div>
            )}

            {/* Free token */}
            {isTokenFree && iAmStudent && (
              <div className="px-4 pb-2">
                <Button size="sm" variant="default" className="w-full gap-1.5 animate-pulse"
                  onClick={() => claimFreeToken(room.id, user!.uid)}>
                  <Zap className="h-3.5 w-3.5" /> 🆓 Ελεύθερη σκυτάλη — Πάρτην!
                </Button>
              </div>
            )}

            {/* Request token */}
            {iAmStudent && !iAmToken && room.tokenHolder && !iAmReq && (
              <div className="px-4 pb-2">
                <Button size="sm" variant="outline" className="w-full"
                  onClick={() => requestToken(room.id, user!.uid, profile!.displayName)}>
                  Ζήτα σκυτάλη
                </Button>
              </div>
            )}
            {iAmReq && <p className="text-xs text-muted-foreground text-center pb-2">⏳ Αναμονή αποδοχής σκυτάλης…</p>}

            {/* Footer actions */}
            <div className="px-4 pb-4 flex gap-2">
              {!iAmIn ? (
                <Button className="flex-1 gap-2" disabled={isFull || !!entering} onClick={() => handleEnter(room)}>
                  {entering === room.id ? "…" : isFull
                    ? "Πλήρης"
                    : <><DoorOpen className="h-4 w-4" /> Είσοδος</>}
                </Button>
              ) : (
                <>
                  <Button asChild variant="default" className="flex-1 gap-2">
                    <Link to="/project/$projectId" params={{ projectId: room.boardId }}>
                      <DoorOpen className="h-4 w-4" /> Άνοιγμα
                    </Link>
                  </Button>
                  <Button variant="outline" className="px-3" onClick={() => handleLeave(room)} title="Έξοδος">
                    <LogOut className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
