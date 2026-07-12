import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
  type User,
} from "firebase/auth";
import { doc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "./firebase";
import { cGetDoc, cSetDoc } from "./quota-guard";
import { startPresence, stopPresence } from "./presence";

export type UserRole = "student" | "teacher" | "therapist";

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  role: UserRole;
  workspace?: string;
  createdAt?: unknown;
  lastSeen?: unknown;
}

interface AuthCtx {
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (
    email: string,
    password: string,
    displayName: string,
    role: UserRole,
    accessCode?: string,
  ) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

/**
 * SECURITY NOTE — role selection is currently CLIENT-TRUSTED.
 * The signup form lets the user choose `teacher` / `therapist`; the only
 * gate today is a shared `accessCode` checked against
 * `import.meta.env.VITE_TEACHER_SIGNUP_CODE` (or a hardcoded fallback).
 * A determined user could bypass this by calling Firestore directly, so
 * this is a stop-gap. Proper enforcement requires a server-side path
 * (Cloud Function / custom claim) that verifies the code and writes the
 * role with admin credentials. Until then, treat any non-student role
 * as advisory and re-verify on the server before granting privileges.
 */
const TEACHER_SIGNUP_CODE: string =
  (import.meta.env.VITE_TEACHER_SIGNUP_CODE as string | undefined) ?? "unity-teacher";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth(), async (u) => {
      setUser(u);
      if (u) {
        const ref = doc(db(), "users", u.uid);
        const snap = await cGetDoc(ref);
        let p: UserProfile;
        if (snap.exists()) {
          p = snap.data() as UserProfile;
          await cSetDoc(ref, { lastSeen: serverTimestamp() }, { merge: true });
        } else {
          p = {
            uid: u.uid,
            displayName: u.displayName || u.email?.split("@")[0] || "Χρήστης",
            email: u.email || "",
            role: "student",
          };
          await cSetDoc(ref, { ...p, createdAt: serverTimestamp(), lastSeen: serverTimestamp() });
        }
        setProfile(p);
        try {
          startPresence(p);
        } catch (e) {
          console.warn("presence start failed", e);
        }
      } else {
        stopPresence();
        setProfile(null);
      }
      setLoading(false);
    });
    return unsub;
  }, []);

  const signIn = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth(), email, password);
  };

  const signUp = async (
    email: string,
    password: string,
    displayName: string,
    role: UserRole,
    accessCode?: string,
  ) => {
    // Stop-gap role gate (client-trusted): non-student roles require the
    // shared access code. If it doesn't match, silently downgrade to
    // "student" so the user still gets an account. See SECURITY NOTE above.
    let effectiveRole: UserRole = role;
    if (role !== "student" && accessCode?.trim() !== TEACHER_SIGNUP_CODE) {
      effectiveRole = "student";
    }
    const cred = await createUserWithEmailAndPassword(auth(), email, password);
    await updateProfile(cred.user, { displayName });
    const p: UserProfile = {
      uid: cred.user.uid,
      displayName,
      email,
      role: effectiveRole,
    };
    await cSetDoc(doc(db(), "users", cred.user.uid), {
      ...p,
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
    });
    setProfile(p);
  };

  const signOut = async () => {
    // Auto-leave all workspace rooms before signing out
    if (user) {
      try {
        const { subscribeRooms, leaveRoom } = await import("@/lib/workspaces-rooms");
        const { getDoc, collection, getDocs, query, where } = await import("firebase/firestore");
        const { db } = await import("@/lib/firebase");
        const snap = await getDocs(query(collection(db(), "workspaceRooms")));
        const isTeacher = profile?.role === "teacher" || profile?.role === "therapist";
        await Promise.all(
          snap.docs.map(async (d) => {
            const data = d.data() as { occupants?: string[]; teacherOccupants?: string[] };
            if (data.occupants?.includes(user.uid) || data.teacherOccupants?.includes(user.uid)) {
              await leaveRoom(d.id, user.uid, isTeacher).catch(() => {});
            }
          })
        );
      } catch (e) {
        console.warn("Failed to leave workspace rooms on signOut", e);
      }
    }
    stopPresence();
    // Clear persistent tabs on logout
    const { clearTabs } = await import("@/lib/tab-store");
    clearTabs();
    await fbSignOut(auth());
  };

  return (
    <Ctx.Provider value={{ user, profile, loading, signIn, signUp, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth must be inside AuthProvider");
  return c;
}
