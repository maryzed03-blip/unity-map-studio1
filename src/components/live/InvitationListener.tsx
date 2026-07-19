// InvitationListener — mounted once in AppShell.
// Shows toast for each pending invitation exactly ONCE per user per session.
// Uses localStorage to track dismissed invitations so they never re-appear.

import { useEffect, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { subscribeMyInvitations, respondToInvitation, deleteInvitation } from "@/lib/live-sessions";
import { toast } from "sonner";
import { useNavigate } from "@tanstack/react-router";

function getDismissedKey(uid: string) {
  return `ums:dismissed_invitations:${uid}`;
}
function getDismissed(uid: string): Set<string> {
  try {
    const raw = localStorage.getItem(getDismissedKey(uid));
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}
function addDismissed(uid: string, invId: string) {
  try {
    const set = getDismissed(uid);
    set.add(invId);
    // Keep only last 100 to avoid unbounded growth
    const arr = Array.from(set).slice(-100);
    localStorage.setItem(getDismissedKey(uid), JSON.stringify(arr));
  } catch { /**/ }
}

export function InvitationListener() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const shownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!user) return;

    // Load already-dismissed from localStorage on mount
    const dismissed = getDismissed(user.uid);
    dismissed.forEach((id) => shownRef.current.add(id));

    const unsub = subscribeMyInvitations(user.uid, (invites) => {
      for (const inv of invites) {
        // Never show same invitation twice (in-memory + localStorage)
        if (shownRef.current.has(inv.id)) continue;
        shownRef.current.add(inv.id);
        addDismissed(user.uid, inv.id); // persist immediately

        const type = (inv as { type?: string }).type;
        const lessonTitle = (inv as { title?: string }).title ?? inv.fromUserName;
        const isLessonStart = type === "lesson_start";
        const isLessonPaused = type === "lesson_paused";
        const isCollabProject = type === "collab_project";

        // Always delete from Firestore so it stops appearing in queries
        deleteInvitation(inv.id).catch(() => {});

        if (isLessonPaused) {
          toast(`⏸ Το μάθημα "${lessonTitle}" διακόπηκε`, { duration: 8_000 });
          continue;
        }

        if (isLessonStart) {
          toast(`🔴 Το μάθημα "${lessonTitle}" ξεκίνησε`, {
            duration: 60_000,
            action: {
              label: "Είσοδος",
              onClick: async () => {
                try {
                  const sid = await respondToInvitation(inv.id, true, user.uid);
                  if (sid) navigate({ to: "/live/$sessionId", params: { sessionId: sid } });
                  else navigate({ to: "/lobby" });
                } catch {
                  navigate({ to: "/lobby" });
                }
              },
            },
          });
          continue;
        }

        if (isCollabProject) {
          toast(`Πρόσκληση για συνεργασία: "${lessonTitle}"`, {
            duration: 60_000,
            action: {
              label: "Αποδοχή",
              onClick: async () => {
                try {
                  const pid = await respondToInvitation(inv.id, true, user.uid);
                  if (pid) navigate({ to: "/project/$projectId", params: { projectId: pid } });
                } catch { toast.error("Αποτυχία αποδοχής"); }
              },
            },
            cancel: {
              label: "Άρνηση",
              onClick: () => respondToInvitation(inv.id, false, user.uid).catch(() => {}),
            },
          });
          continue;
        }

        // Regular invitation
        toast(`Πρόσκληση από ${inv.fromUserName}`, {
          duration: 60_000,
          action: {
            label: "Αποδοχή",
            onClick: async () => {
              try {
                const sid = await respondToInvitation(inv.id, true, user.uid);
                if (sid) navigate({ to: "/live/$sessionId", params: { sessionId: sid } });
              } catch { toast.error("Αποτυχία αποδοχής"); }
            },
          },
          cancel: {
            label: "Άρνηση",
            onClick: () => respondToInvitation(inv.id, false, user.uid).catch(() => {}),
          },
        });
      }
    });
    return unsub;
  }, [user, navigate]);

  return null;
}
