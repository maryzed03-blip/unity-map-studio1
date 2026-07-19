import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { z } from "zod";
import { useAuth } from "@/lib/auth-context";
import { ClientOnly } from "@/lib/client-only";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  subscribeMyProjects,
  createProject,
  renameProject,
  deleteProject,
  duplicateProject,
  type Project,
} from "@/lib/projects";
import {
  createFolder,
  renameFolder,
  deleteFolder,
  moveProjectToFolder,
  subscribeMyFolders,
  type Folder,
} from "@/lib/folders";
import {
  FolderOpen,
  Folder as FolderIcon,
  Plus,
  FileText,
  LibraryBig,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
  Copy as CopyIcon,
  Move,
  FolderPlus,
  Users,
  User,
  Radio,
  Check,
  Mail,
} from "lucide-react";
import { subscribeMySessions, sendCollabProjectInvitation, subscribeReceivedDesigns, markDesignSaved, type ReceivedDesign } from "@/lib/live-sessions";
import { WorkspaceRoomsPanel } from "@/components/rooms/WorkspaceRoomsPanel";
import { getProject, startCollabProject } from "@/lib/projects";
import {
  OnlineUsersPanel,
  usePresence,
} from "@/components/live/LivePanels";
import { LiveClassButton } from "@/components/live/LiveClassButton";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { el } from "date-fns/locale";

const searchSchema = z.object({
  tab: z.string().optional().default("projects"),
});

export const Route = createFileRoute("/lobby")({
  validateSearch: searchSchema,
  head: () => ({ meta: [{ title: "Lobby — Unity Map Studio" }] }),
  component: () => (
    <ClientOnly fallback={<div className="min-h-screen bg-background" />}>
      <LobbyGate />
    </ClientOnly>
  ),
});

function LobbyGate() {
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
  return (
    <AppShell>
      <Lobby />
    </AppShell>
  );
}

function Lobby() {
  const { tab } = Route.useSearch();
  const { profile, user } = useAuth();
  const isTeacher = profile?.role === "teacher" || profile?.role === "therapist";

  // Auto-expire old sessions (>24h) on lobby load — teachers only
  useEffect(() => {
    if (!isTeacher || !user) return;
    import("@/lib/live-sessions").then(({ autoExpireOldSessions }) => {
      autoExpireOldSessions(user.uid).then((expired) => {
        if (expired.length > 0) {
          toast.info(`${expired.length} μάθημα${expired.length > 1 ? "τα" : ""} έκλεισαν αυτόματα μετά από 24 ώρες: ${expired.join(", ")}`);
        }
      });
    });
  }, [isTeacher, user?.uid]);

  const meta = tabMeta(tab, isTeacher);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      <div className="flex items-end justify-between mb-8 gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{meta.title}</h1>
          <p className="text-sm text-muted-foreground mt-1">{meta.subtitle}</p>
        </div>
        {meta.action}
      </div>

      <TabContent tab={tab} isTeacher={isTeacher} />
    </div>
  );
}

function tabMeta(
  tab: string,
  isTeacher: boolean,
): { title: string; subtitle: string; action?: React.ReactNode } {
  switch (tab) {
    case "projects":
      return {
        title: "Τα Έργα μου",
        subtitle: "Προσωπικά πρόχειρα και ολοκληρωμένες εργασίες σας.",
        action: (
          <div className="flex items-center gap-2">
            <NewFolderButton />
            <NewProjectButton />
            <LiveClassButton />
          </div>
        ),
      };
    case "collab":
      return { title: "Συνεργατικά", subtitle: "Έργα που μοιράζεστε με άλλους χρήστες." };
    case "submissions":
      return {
        title: isTeacher ? "Εισερχόμενες Υποβολές" : "Οι Υποβολές μου",
        subtitle: isTeacher
          ? "Εργασίες μαθητών για αξιολόγηση και επιστροφή."
          : "Έργα που έχετε στείλει στον εκπαιδευτικό.",
      };
    case "returned":
      return {
        title: "Επιστραφέντα",
        subtitle: "Εργασίες με σχόλια του εκπαιδευτικού — δείτε τι άλλαξε.",
      };
    case "rooms":
      return { title: "Χώροι Εργασίας", subtitle: "10 κοινοί χώροι για ατομική ή ομαδική εργασία. Μέχρι 5 άτομα ανά χώρο." };
    case "archive":
      return { title: "Αρχείο", subtitle: "Παλαιότερα έργα που έχετε αρχειοθετήσει." };
    case "library":
      return { title: "Βιβλιοθήκη", subtitle: "Πρότυπα και έτοιμοι χάρτες για γρήγορη εκκίνηση." };
    case "received":
      return { title: "Απεσταλμένα από Συμμαθητές", subtitle: "Σχέδια που σας έχουν στείλει άλλοι χρήστες." };
    case "students":
      return {
        title: "Μαθητές",
        subtitle: "Δείτε ποιοι μαθητές είναι συνδεδεμένοι και προσκαλέστε σε συνεδρίες.",
      };
    default:
      return { title: "Lobby", subtitle: "" };
  }
}

function TabContent({ tab, isTeacher }: { tab: string; isTeacher: boolean }) {
  switch (tab) {
    case "projects":
      return <MyProjectsGrid />;
    case "collab":
      return <CollabProjectsList />;
    case "library":
      return <LibraryComing />;
    case "students":
      return <OnlineUsersPanel />;
    case "rooms":
      return <WorkspaceRoomsLobby />;
    case "received":
      return <ReceivedDesignsList />;
    default:
      return <ComingSoon label={tabMeta(tab, isTeacher).title} />;
  }
}

// ── Project library w/ folders ──────────────────────────────────────

type FolderFilter = "all" | "unfiled" | string; // string = folderId

function MyProjectsGrid() {
  const { user } = useAuth();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [filter, setFilter] = useState<FolderFilter>("all");

  useEffect(() => {
    if (!user) return;
    const u1 = subscribeMyProjects(user.uid, (p) =>
      setProjects(p.filter((x) => x.status !== "archived")),
    );
    const u2 = subscribeMyFolders(user.uid, setFolders);
    return () => {
      u1();
      u2();
    };
  }, [user]);

  const visibleProjects = useMemo(() => {
    if (!projects) return null;
    if (filter === "all") return projects;
    if (filter === "unfiled") return projects.filter((p) => !p.folderId);
    return projects.filter((p) => p.folderId === filter);
  }, [projects, filter]);

  if (projects === null) {
    return <SkeletonGrid />;
  }

  const counts = {
    all: projects.length,
    unfiled: projects.filter((p) => !p.folderId).length,
  };

  return (
    <div className="space-y-5">
      <FolderChips
        folders={folders}
        projects={projects}
        filter={filter}
        setFilter={setFilter}
        counts={counts}
      />

      {visibleProjects && visibleProjects.length === 0 ? (
        <EmptyState
          icon={<FolderOpen className="h-6 w-6" />}
          title={filter === "all" ? "Δεν έχετε έργα ακόμα" : "Κενός φάκελος"}
          description={
            filter === "all"
              ? "Δημιουργήστε το πρώτο σας έργο για να ξεκινήσετε."
              : "Δεν υπάρχουν έργα σε αυτή την προβολή."
          }
          cta={filter === "all" ? <NewProjectButton /> : undefined}
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {visibleProjects!.map((p) => (
            <ProjectCard key={p.id} project={p} folders={folders} />
          ))}
        </div>
      )}
    </div>
  );
}

function FolderChips({
  folders,
  projects,
  filter,
  setFilter,
  counts,
}: {
  folders: Folder[];
  projects: Project[];
  filter: FolderFilter;
  setFilter: (f: FolderFilter) => void;
  counts: { all: number; unfiled: number };
}) {
  const countFor = (fid: string) => projects.filter((p) => p.folderId === fid).length;
  return (
    <div className="flex flex-wrap gap-2">
      <FolderChip
        active={filter === "all"}
        onClick={() => setFilter("all")}
        icon={<LibraryBig className="h-3.5 w-3.5" />}
        label="Όλα τα έργα"
        count={counts.all}
      />
      <FolderChip
        active={filter === "unfiled"}
        onClick={() => setFilter("unfiled")}
        icon={<FolderOpen className="h-3.5 w-3.5" />}
        label="Χωρίς φάκελο"
        count={counts.unfiled}
      />
      {folders.map((f) => (
        <FolderChip
          key={f.id}
          active={filter === f.id}
          onClick={() => setFilter(f.id)}
          icon={<FolderIcon className="h-3.5 w-3.5" />}
          label={f.name}
          count={countFor(f.id)}
          menu={<FolderMenu folder={f} onAfterDelete={() => setFilter("all")} />}
        />
      ))}
    </div>
  );
}

function FolderChip({
  active,
  onClick,
  icon,
  label,
  count,
  menu,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  count: number;
  menu?: React.ReactNode;
}) {
  return (
    <div
      className={`inline-flex items-center rounded-full border text-xs px-1 transition-colors ${
        active
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-background hover:bg-muted"
      }`}
    >
      <button onClick={onClick} className="inline-flex items-center gap-1.5 px-2 py-1.5">
        {icon}
        <span className="truncate max-w-[12rem]">{label}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{count}</span>
      </button>
      {menu && <div className="pr-1">{menu}</div>}
    </div>
  );
}

function FolderMenu({ folder, onAfterDelete }: { folder: Folder; onAfterDelete: () => void }) {
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="h-5 w-5 rounded-full hover:bg-muted flex items-center justify-center"
            aria-label="Ενέργειες φακέλου"
            onClick={(e) => e.stopPropagation()}
          >
            <MoreHorizontal className="h-3 w-3" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onClick={() => setRenameOpen(true)}>
            <Pencil className="h-3.5 w-3.5 mr-2" />
            Μετονομασία
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="text-destructive focus:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="h-3.5 w-3.5 mr-2" />
            Διαγραφή
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <RenameFolderDialog folder={folder} open={renameOpen} onOpenChange={setRenameOpen} />
      <DeleteFolderDialog
        folder={folder}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDeleted={onAfterDelete}
      />
    </>
  );
}

function RenameFolderDialog({
  folder,
  open,
  onOpenChange,
}: {
  folder: Folder;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(folder.name);
  }, [open, folder.name]);
  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await renameFolder(folder.id, name);
      toast.success("Ο φάκελος μετονομάστηκε");
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία μετονομασίας");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Μετονομασία φακέλου</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="fname">Νέο όνομα</Label>
          <Input
            id="fname"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Άκυρο
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Αποθήκευση
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteFolderDialog({
  folder,
  open,
  onOpenChange,
  onDeleted,
}: {
  folder: Folder;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDeleted: () => void;
}) {
  const { user } = useAuth();
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setCascade(false);
  }, [open]);
  const submit = async () => {
    if (!user) return;
    setBusy(true);
    try {
      await deleteFolder(folder.id, user.uid, { deleteProjects: cascade });
      toast.success("Ο φάκελος διαγράφηκε");
      onOpenChange(false);
      onDeleted();
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία διαγραφής");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Διαγραφή φακέλου «{folder.name}»</DialogTitle>
          <DialogDescription>
            Από προεπιλογή, τα έργα μέσα στον φάκελο διατηρούνται και μετακινούνται στο «Χωρίς
            φάκελο». Επιλέξτε παρακάτω για να διαγραφούν κι αυτά.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-2 text-sm py-2">
          <Checkbox
            checked={cascade}
            onCheckedChange={(v) => setCascade(v === true)}
            className="mt-0.5"
          />
          <span>
            <span className="font-medium text-destructive">
              Διαγραφή και των έργων μέσα στον φάκελο
            </span>
            <span className="block text-xs text-muted-foreground">
              Μη αναστρέψιμο. Τα έργα δεν θα μπορούν να ανακτηθούν.
            </span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Άκυρο
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Διαγραφή φακέλου
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectCard({ project, folders }: { project: Project; folders: Folder[] }) {
  const ts = (project.updatedAt as { toDate?: () => Date } | undefined)?.toDate?.();
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);

  return (
    <>
      <Card className="panel-soft p-0 overflow-hidden hover:shadow-[var(--shadow-lift)] transition-shadow group relative">
        <Link to="/project/$projectId" params={{ projectId: project.id }} className="block">
          <div className="aspect-[4/3] canvas-dotgrid border-b border-border flex items-center justify-center">
            <FileText className="h-8 w-8 text-muted-foreground/40" />
          </div>
          <div className="p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-medium truncate group-hover:text-primary transition-colors">
                {project.title}
              </h3>
              <StatusPill status={project.status} />
            </div>
            <div className="flex items-center justify-between mt-2 text-xs text-muted-foreground">
              <span>
                {ts
                  ? `Ενημερώθηκε ${formatDistanceToNow(ts, { addSuffix: true, locale: el })}`
                  : "Νέο"}
              </span>
            </div>
            {project.originLabel && (
              <p className="mt-1 text-[10px] text-muted-foreground truncate" title={project.originLabel}>
                📥 {project.originLabel}
                {ts && ` · ${ts.toLocaleDateString("el-GR", { day: "2-digit", month: "2-digit", year: "numeric" })}`}
              </p>
            )}
          </div>
        </Link>
        <div className="absolute top-2 right-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="h-7 w-7 rounded-md bg-background/90 backdrop-blur border border-border hover:bg-muted flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100"
                aria-label="Ενέργειες έργου"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild>
                <Link to="/project/$projectId" params={{ projectId: project.id }}>
                  <FolderOpen className="h-3.5 w-3.5 mr-2" />
                  Άνοιγμα
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRenameOpen(true)}>
                <Pencil className="h-3.5 w-3.5 mr-2" />
                Μετονομασία
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setDupOpen(true)}>
                <CopyIcon className="h-3.5 w-3.5 mr-2" />
                Αποθήκευση ως αντίγραφο
              </DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Move className="h-3.5 w-3.5 mr-2" />
                  Μετακίνηση σε φάκελο
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-52">
                  <DropdownMenuLabel className="text-[10px] uppercase tracking-wider">
                    Φάκελοι
                  </DropdownMenuLabel>
                  <DropdownMenuItem
                    onClick={() => doMove(project.id, null)}
                    disabled={!project.folderId}
                  >
                    <FolderOpen className="h-3.5 w-3.5 mr-2" />
                    Χωρίς φάκελο
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {folders.length === 0 ? (
                    <DropdownMenuItem disabled>Δεν υπάρχουν φάκελοι</DropdownMenuItem>
                  ) : (
                    folders.map((f) => (
                      <DropdownMenuItem
                        key={f.id}
                        onClick={() => doMove(project.id, f.id)}
                        disabled={project.folderId === f.id}
                      >
                        <FolderIcon className="h-3.5 w-3.5 mr-2" />
                        {f.name}
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="h-3.5 w-3.5 mr-2" />
                Διαγραφή
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </Card>
      <RenameProjectDialog project={project} open={renameOpen} onOpenChange={setRenameOpen} />
      <DeleteProjectDialog project={project} open={deleteOpen} onOpenChange={setDeleteOpen} />
      <DuplicateProjectDialog project={project} open={dupOpen} onOpenChange={setDupOpen} />
    </>
  );
}

async function doMove(projectId: string, folderId: string | null) {
  try {
    await moveProjectToFolder(projectId, folderId);
    toast.success(folderId ? "Μετακινήθηκε στον φάκελο" : "Αφαιρέθηκε από φάκελο");
  } catch (e) {
    console.error(e);
    toast.error("Αποτυχία μετακίνησης");
  }
}

function RenameProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [title, setTitle] = useState(project.title);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTitle(project.title);
  }, [open, project.title]);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await renameProject(project.id, title);
      toast.success("Το έργο μετονομάστηκε");
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία μετονομασίας");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Μετονομασία έργου</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="ptitle">Νέος τίτλος</Label>
          <Input
            id="ptitle"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Άκυρο
          </Button>
          <Button onClick={submit} disabled={busy || !title.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Αποθήκευση
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await deleteProject(project.id);
      toast.success("Το έργο διαγράφηκε");
      onOpenChange(false);
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία διαγραφής");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Διαγραφή έργου «{project.title}»</DialogTitle>
          <DialogDescription>
            Μη αναστρέψιμη ενέργεια. Το έργο και η αποθηκευμένη του κατάσταση θα διαγραφούν.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Άκυρο
          </Button>
          <Button variant="destructive" onClick={submit} disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Διαγραφή
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateProjectDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [title, setTitle] = useState(`${project.title} (αντίγραφο)`);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setTitle(`${project.title} (αντίγραφο)`);
  }, [open, project.title]);
  const submit = async () => {
    if (!user || !title.trim()) return;
    setBusy(true);
    try {
      const newId = await duplicateProject(user.uid, project.id, title.trim());
      toast.success("Δημιουργήθηκε αντίγραφο");
      onOpenChange(false);
      navigate({ to: "/project/$projectId", params: { projectId: newId } });
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία δημιουργίας αντιγράφου");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Αποθήκευση ως αντίγραφο</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="dtitle">Τίτλος αντιγράφου</Label>
          <Input
            id="dtitle"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Άκυρο
          </Button>
          <Button onClick={submit} disabled={busy || !title.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Δημιουργία
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusPill({ status }: { status: Project["status"] }) {
  const map: Record<Project["status"], { label: string; cls: string }> = {
    draft: { label: "Πρόχειρο", cls: "bg-muted text-muted-foreground" },
    active_collab: { label: "Συνεργασία", cls: "bg-primary/10 text-primary" },
    submitted: {
      label: "Υποβλήθηκε",
      cls: "bg-[color:var(--warning)]/15 text-[color:var(--warning)]",
    },
    returned: {
      label: "Επιστράφηκε",
      cls: "bg-[color:var(--success)]/15 text-[color:var(--success)]",
    },
    archived: { label: "Αρχείο", cls: "bg-muted text-muted-foreground" },
  };
  const v = map[status];
  return <span className={`pill ${v.cls}`}>{v.label}</span>;
}

function NewProjectButton() {
  const { user, profile } = useAuth();
  const navigate = useNavigate();
  const presence = usePresence();

  // Step: "pick-mode" | "solo" | "collab"
  const [step, setStep] = useState<"pick-mode" | "solo" | "collab">("pick-mode");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  // Collab: selected user uids
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const reset = () => {
    setStep("pick-mode");
    setTitle("");
    setSelected(new Set());
    setLoading(false);
  };

  const onOpenChange = (v: boolean) => {
    setOpen(v);
    if (!v) reset();
  };

  // Online users excluding self
  const onlineOthers = Object.entries(presence).filter(
    ([uid, p]) => uid !== user?.uid && p.state === "online",
  );

  const toggleUser = (uid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(uid) ? next.delete(uid) : next.add(uid);
      return next;
    });
  };

  // Create solo project
  const submitSolo = async () => {
    if (!user || !title.trim()) return;
    setLoading(true);
    try {
      const id = await createProject(user.uid, title.trim());
      toast.success("Το έργο δημιουργήθηκε");
      onOpenChange(false);
      navigate({ to: "/project/$projectId", params: { projectId: id } });
    } catch (e) {
      console.error(e);
      toast.error("Δεν ήταν δυνατή η δημιουργία");
    } finally {
      setLoading(false);
    }
  };

  // Create a lightweight collaborative project and invite selected users.
  // Deliberately does NOT use createLiveSession — that's reserved for
  // teacher-run classroom lessons and enforces "one active session per
  // teacher", which is wrong here: any number of different people should
  // be able to run their own simultaneous ad-hoc collaborations.
  const submitCollab = async () => {
    if (!user || !profile) return;
    const finalTitle = title.trim() || `Συνεργασία — ${profile.displayName}`;
    setLoading(true);
    try {
      const projectId = await createProject(user.uid, finalTitle, "collaborative", "free-drawing");
      await startCollabProject(projectId, user.uid);
      await Promise.all(
        Array.from(selected).map((uid) =>
          sendCollabProjectInvitation({
            projectId,
            projectTitle: finalTitle,
            fromUserId: user.uid,
            fromUserName: profile.displayName,
            toUserId: uid,
          }),
        ),
      );
      if (selected.size > 0) {
        toast.success(`Προσκλήσεις στάλθηκαν σε ${selected.size} άτομα`);
      }
      onOpenChange(false);
      navigate({ to: "/project/$projectId", params: { projectId } });
    } catch (e) {
      console.error(e);
      const msg = e instanceof Error ? e.message : "Δεν ήταν δυνατή η δημιουργία";
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus className="h-4 w-4 mr-1.5" />
          Νέο σχέδιο
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-md">
        {/* Step 1: pick mode */}
        {step === "pick-mode" && (
          <>
            <DialogHeader>
              <DialogTitle>Νέο σχέδιο</DialogTitle>
              <DialogDescription>Επιλέξτε τον τύπο σχεδίου</DialogDescription>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3 py-4">
              <button
                onClick={() => setStep("solo")}
                className="flex flex-col items-center gap-3 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 p-6 transition-all text-center"
              >
                <User className="h-8 w-8 text-primary" />
                <div>
                  <p className="font-semibold text-sm">Ατομικό σχέδιο</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Μόνο εσείς</p>
                </div>
              </button>
              <button
                onClick={() => setStep("collab")}
                className="flex flex-col items-center gap-3 rounded-xl border-2 border-border hover:border-primary hover:bg-primary/5 p-6 transition-all text-center"
              >
                <Users className="h-8 w-8 text-primary" />
                <div>
                  <p className="font-semibold text-sm">Συνεργατικό</p>
                  <p className="text-xs text-muted-foreground mt-0.5">Με άλλους online</p>
                </div>
              </button>
            </div>
          </>
        )}

        {/* Step 2a: solo */}
        {step === "solo" && (
          <>
            <DialogHeader>
              <DialogTitle>Ατομικό σχέδιο</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <Label htmlFor="solo-title">Τίτλος</Label>
              <Input
                id="solo-title"
                value={title}
                autoFocus
                onChange={(e) => setTitle(e.target.value)}
                placeholder="π.χ. Κύκλος του νερού"
                onKeyDown={(e) => { if (e.key === "Enter") submitSolo(); }}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep("pick-mode")}>Πίσω</Button>
              <Button onClick={submitSolo} disabled={loading || !title.trim()}>
                {loading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Δημιουργία
              </Button>
            </DialogFooter>
          </>
        )}

        {/* Step 2b: collab */}
        {step === "collab" && (
          <>
            <DialogHeader>
              <DialogTitle>Συνεργατικό σχέδιο</DialogTitle>
              <DialogDescription>
                Θα δημιουργηθεί ζωντανή συνεδρία και θα σταλούν προσκλήσεις.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="collab-title">Τίτλος</Label>
                <Input
                  id="collab-title"
                  value={title}
                  autoFocus
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="π.χ. Ομαδική εργασία (προαιρετικό)"
                />
              </div>

              {/* Online users list */}
              <div>
                <Label className="mb-2 block">
                  Online χρήστες ({onlineOthers.length})
                </Label>
                {onlineOthers.length === 0 ? (
                  <p className="text-xs text-muted-foreground py-2">
                    Κανένας άλλος δεν είναι online αυτή τη στιγμή.
                  </p>
                ) : (
                  <ul className="space-y-1 max-h-48 overflow-y-auto rounded-lg border border-border p-1">
                    {onlineOthers.map(([uid, p]) => {
                      const isSelected = selected.has(uid);
                      return (
                        <li key={uid}>
                          <button
                            onClick={() => toggleUser(uid)}
                            className={`w-full flex items-center gap-3 rounded-md px-3 py-2 text-left transition-colors ${isSelected ? "bg-primary/10 text-primary" : "hover:bg-muted"}`}
                          >
                            <span className="h-2 w-2 rounded-full bg-[color:var(--success)] shrink-0" />
                            <span className="flex-1 text-sm truncate">
                              {p.displayName || uid.slice(0, 8)}
                            </span>
                            {isSelected && <Check className="h-4 w-4 shrink-0" />}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {selected.size > 0 && (
                <p className="text-xs text-muted-foreground">
                  Θα σταλεί πρόσκληση σε {selected.size} άτομο{selected.size !== 1 ? "α" : ""}.
                </p>
              )}
            </div>

            <DialogFooter className="gap-2">
              <Button variant="outline" onClick={() => setStep("pick-mode")}>Πίσω</Button>
              <Button
                onClick={submitCollab}
                disabled={loading}
                className="gap-2"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                <Radio className="h-4 w-4" />
                {selected.size > 0
                  ? `Έναρξη & Πρόσκληση (${selected.size})`
                  : "Έναρξη συνεργασίας"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewFolderButton() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!user || !name.trim()) return;
    setBusy(true);
    try {
      await createFolder(user.uid, name);
      toast.success("Ο φάκελος δημιουργήθηκε");
      setOpen(false);
      setName("");
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία δημιουργίας");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <FolderPlus className="h-4 w-4 mr-1.5" />
          Νέος φάκελος
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Νέος φάκελος</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <Label htmlFor="newf">Όνομα φακέλου</Label>
          <Input
            id="newf"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder="π.χ. Τάξη Δ' — Ιστορία"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Άκυρο
          </Button>
          <Button onClick={submit} disabled={busy || !name.trim()}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
            Δημιουργία
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({
  icon,
  title,
  description,
  cta,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  cta?: React.ReactNode;
}) {
  return (
    <Card className="panel-soft p-12 flex flex-col items-center text-center">
      <div className="h-14 w-14 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground mb-4">
        {icon}
      </div>
      <h3 className="font-medium">{title}</h3>
      <p className="text-sm text-muted-foreground mt-1 max-w-sm">{description}</p>
      {cta && <div className="mt-5">{cta}</div>}
    </Card>
  );
}

function WorkspaceRoomsLobby() {
  return <WorkspaceRoomsPanel />;
}

function ReceivedDesignsList() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [designs, setDesigns] = useState<ReceivedDesign[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    return subscribeReceivedDesigns(user.uid, (d) => {
      setDesigns(d);
      setLoading(false);
    });
  }, [user]);

  const saveToLibrary = async (design: ReceivedDesign) => {
    if (!user) return;
    setSavingId(design.id);
    try {
      const { duplicateProject } = await import("@/lib/projects");
      const newId = await duplicateProject(
        user.uid,
        design.sourceProjectId,
        `${design.title} (από ${design.fromUserName})`,
      );
      await markDesignSaved(design.id);
      toast.success("Αποθηκεύτηκε στη βιβλιοθήκη σας");
      navigate({ to: "/project/$projectId", params: { projectId: newId } });
    } catch (e) {
      console.error(e);
      toast.error("Αποτυχία αποθήκευσης");
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Φόρτωση…
      </div>
    );
  }
  if (designs.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Mail className="h-10 w-10 mx-auto mb-3 opacity-30" />
        <p className="text-sm">Κανένας δεν σας έχει στείλει σχέδιο ακόμη.</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {designs.map((d) => (
        <Card key={d.id} className="panel-soft p-4 flex flex-col gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{d.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Από {d.fromUserName}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              className="flex-1 gap-1.5"
              disabled={savingId === d.id}
              onClick={() => saveToLibrary(d)}
            >
              {savingId === d.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
              Αποθήκευση
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function ComingSoon({ label }: { label: string }) {
  return (
    <EmptyState
      icon={<LibraryBig className="h-6 w-6" />}
      title={`${label} — έρχεται σύντομα`}
      description="Αυτή η ενότητα θα ενεργοποιηθεί στο επόμενο στάδιο ανάπτυξης."
    />
  );
}

function LibraryComing() {
  return <TemplatePicker />;
}

function TemplatePicker() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);

  const onPick = async (id: import("@/lib/canvas/templates").TemplateId, title: string) => {
    if (!user) return;
    setBusy(id);
    try {
      const { createProject } = await import("@/lib/projects");
      const { buildTemplate } = await import("@/lib/canvas/templates");
      const { mapStore } = await import("@/lib/canvas/storage");
      const projectId = await createProject(user.uid, title);
      await mapStore.save(projectId, buildTemplate(id));
      toast.success("Πρότυπο φορτώθηκε");
      navigate({ to: "/project/$projectId", params: { projectId } });
    } catch (e) {
      console.error(e);
      toast.error("Δεν ήταν δυνατή η δημιουργία από πρότυπο");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {[
        { id: "timeline", t: "Χρονογραμμή", d: "Διαδοχικά γεγονότα σε άξονα" },
        { id: "cause-effect", t: "Αιτία — Αποτέλεσμα", d: "Διάγραμμα αιτιότητας" },
        { id: "comparison", t: "Σύγκριση", d: "Πίνακας αντιπαραβολής" },
        { id: "emotion-wheel", t: "Τροχός συναισθημάτων", d: "Χάρτης για θεραπευτική χρήση" },
        { id: "mind-map", t: "Mind Map", d: "Κεντρική ιδέα με διακλαδώσεις" },
        { id: "blank", t: "Κενός καμβάς", d: "Ξεκινήστε από το μηδέν" },
      ].map((tpl) => (
        <button
          key={tpl.id}
          type="button"
          disabled={busy !== null}
          onClick={() => onPick(tpl.id as import("@/lib/canvas/templates").TemplateId, tpl.t)}
          className="text-left"
        >
          <Card className="panel-soft p-5 hover:shadow-[var(--shadow-lift)] cursor-pointer transition-shadow">
            <div className="aspect-video canvas-dotgrid rounded-lg border border-border mb-3 flex items-center justify-center">
              {busy === tpl.id ? (
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              ) : null}
            </div>
            <h3 className="text-sm font-medium">{tpl.t}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">{tpl.d}</p>
          </Card>
        </button>
      ))}
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} className="panel-soft p-0 overflow-hidden">
          <div className="aspect-[4/3] bg-muted animate-pulse" />
          <div className="p-4 space-y-2">
            <div className="h-4 bg-muted animate-pulse rounded w-2/3" />
            <div className="h-3 bg-muted animate-pulse rounded w-1/3" />
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Συνεργατικά Σχέδια ──────────────────────────────────────────────
// Source of truth for collaborative projects: liveSessions where the
// signed-in user is a participant. Each session contributes its
// mainBoardId (and any group room boards I'm a member of). We resolve
// each board's Project doc once on mount — no N+1 onSnapshot loop. The
// "owned vs joined" split is derived from session.teacherId === uid.
// Status badge ("Ενεργή" vs "Ολοκληρωμένη") comes from project.mode.
function CollabProjectsList() {
  const { user } = useAuth();
  type Row = {
    project: Project;
    sessionTitle: string;
    ownerName: string;
    isOwner: boolean;
    mode: "live" | "collaborativeFinal" | "solo" | undefined;
    memberCount: number;
  };
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    if (!user) return;
    let alive = true;
    let cancelLoad: (() => void) | null = null;
    const unsub = subscribeMySessions(user.uid, (sessions) => {
      cancelLoad?.();
      let cancelled = false;
      cancelLoad = () => {
        cancelled = true;
      };
      (async () => {
        const out: Row[] = [];
        for (const s of sessions) {
          const isOwner = s.teacherId === user.uid;
          const p = await getProject(s.mainBoardId).catch(() => null);
          if (!p) continue;
          out.push({
            project: p,
            sessionTitle: s.title,
            ownerName: s.teacherName,
            isOwner,
            mode: (p.mode as Row["mode"]) ?? undefined,
            memberCount: s.participantIds?.length ?? 1,
          });
        }
        if (!cancelled && alive) {
          out.sort((a, b) => {
            const at =
              (a.project.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
            const bt =
              (b.project.updatedAt as { toMillis?: () => number } | undefined)?.toMillis?.() ?? 0;
            return bt - at;
          });
          setRows(out);
        }
      })();
    });
    return () => {
      alive = false;
      cancelLoad?.();
      unsub();
    };
  }, [user]);

  if (rows === null) return <SkeletonGrid />;
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={<Users className="h-6 w-6" />}
        title="Δεν έχετε συνεργατικά έργα"
        description="Όταν σας προσκαλέσει ένας εκπαιδευτικός σε ζωντανή συνεδρία ή σε ομαδικό πίνακα, θα εμφανιστούν εδώ."
      />
    );
  }

  const owned = rows.filter((r) => r.isOwner);
  const joined = rows.filter((r) => !r.isOwner);
  return (
    <div className="space-y-8">
      {owned.length > 0 && <CollabSection title="Έργα που μοιράζομαι" rows={owned} />}
      {joined.length > 0 && <CollabSection title="Έργα στα οποία συμμετέχω" rows={joined} />}
    </div>
  );
}

function CollabSection({
  title,
  rows,
}: {
  title: string;
  rows: Array<{
    project: Project;
    sessionTitle: string;
    ownerName: string;
    isOwner: boolean;
    mode: "live" | "collaborativeFinal" | "solo" | undefined;
    memberCount: number;
  }>;
}) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
        {title}
      </h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
        {rows.map((r) => (
          <Link
            key={r.project.id}
            to="/project/$projectId"
            params={{ projectId: r.project.id }}
            className="block"
          >
            <Card className="panel-soft p-0 overflow-hidden hover:shadow-[var(--shadow-lift)] transition-shadow">
              <div className="aspect-[4/3] canvas-dotgrid border-b border-border flex items-center justify-center">
                <Users className="h-8 w-8 text-muted-foreground/40" />
              </div>
              <div className="p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium truncate">{r.project.title}</h3>
                  <CollabModeBadge mode={r.mode} />
                </div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div className="truncate">Από: {r.ownerName}</div>
                  <div className="flex items-center justify-between">
                    <span>{r.memberCount} συμμετέχοντες</span>
                    <span>
                      {(() => {
                        const ts = (
                          r.project.updatedAt as { toDate?: () => Date } | undefined
                        )?.toDate?.();
                        return ts ? formatDistanceToNow(ts, { addSuffix: true, locale: el }) : "—";
                      })()}
                    </span>
                  </div>
                </div>
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </section>
  );
}

function CollabModeBadge({ mode }: { mode: "live" | "collaborativeFinal" | "solo" | undefined }) {
  if (mode === "live") {
    return <span className="pill bg-primary/10 text-primary">Ενεργή</span>;
  }
  if (mode === "collaborativeFinal") {
    return (
      <span className="pill bg-[color:var(--success)]/15 text-[color:var(--success)]">
        Ολοκληρωμένη
      </span>
    );
  }
  return <span className="pill bg-muted text-muted-foreground">—</span>;
}
