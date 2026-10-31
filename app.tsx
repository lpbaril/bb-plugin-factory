// bb-plugin-factory frontend: the Factory page in the left navigation rail.
//
// One page per factory (/plugins/factory/factory/<PREFIX>): the agents strip
// on top, with live status from the host's own thread cache, and the board
// below, read from the server and refetched on its "board-changed" signal.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent, FormEvent, ReactNode } from "react";
import {
  Markdown,
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useProviders,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { ExperimentalProviderModelPickerValue, PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type {
  Agent,
  AgentExec,
  AgentsView,
  BoardTask,
  Column,
  FactoryDoctorReport,
  FactorySummary,
  PrSummary,
  TaskComment,
  rpcContract,
} from "./server";
import type { RepoInspection } from "./host-contract";
import { ROLES, WORKER_ROLE_IDS, type AssignableRoleId, type ProjectMode } from "./roles";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const PANEL_PATH = "factory";

const COLUMNS: { id: Column; label: string; dot: string }[] = [
  { id: "backlog", label: "Backlog", dot: "bg-muted-foreground/50" },
  { id: "todo", label: "To do", dot: "bg-sky-500" },
  { id: "in_progress", label: "In progress", dot: "bg-amber-500" },
  { id: "in_review", label: "In review", dot: "bg-violet-500" },
  { id: "done", label: "Done", dot: "bg-emerald-500" },
  { id: "blocked", label: "Blocked", dot: "bg-red-500" },
];

const PRIORITY_STYLE: Record<string, string> = {
  urgent: "text-red-600 dark:text-red-400",
  high: "text-orange-600 dark:text-orange-400",
  medium: "text-amber-600 dark:text-amber-400",
  low: "text-muted-foreground",
};

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

// ---------- Agent status ----------

type AgentState = { label: string; tone: "working" | "attention" | "error" | "idle" };

function agentState(thread: PluginSidebarThread): AgentState {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input") {
    return { label: "Needs you", tone: "attention" };
  }
  if (thread.status === "error" || thread.runtimeStatus === "error" || thread.indicator === "unread-error") {
    return { label: "Error", tone: "error" };
  }
  if (
    thread.status === "active" ||
    thread.status === "starting" ||
    thread.status === "pending" ||
    thread.runtimeStatus === "provisioning"
  ) {
    return { label: "Working", tone: "working" };
  }
  if (thread.indicator === "unread-success") return { label: "Finished", tone: "idle" };
  return { label: "Idle", tone: "idle" };
}

const TONE_TEXT: Record<AgentState["tone"], string> = {
  working: "text-sky-600 dark:text-sky-400",
  attention: "text-amber-600 dark:text-amber-400",
  error: "text-destructive",
  idle: "text-muted-foreground",
};

/** Factory agents that are still in the sidebar (not archived), with their live thread. */
function useLiveAgents(agents: Agent[]) {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    return agents
      .map((agent) => ({ agent, thread: byId.get(agent.threadId) }))
      .filter((entry): entry is { agent: Agent; thread: PluginSidebarThread } => entry.thread !== undefined);
  }, [agents, threads]);
}
type LiveAgent = ReturnType<typeof useLiveAgents>[number];

// ---------- Pull request chips ----------

const VERDICT_STYLE: Record<PrSummary["checks"][number]["verdict"], { mark: string; className: string }> = {
  approve: { mark: "✓", className: "text-emerald-600 dark:text-emerald-400" },
  changes: { mark: "✗", className: "text-destructive" },
  pending: { mark: "…", className: "text-muted-foreground" },
  dismissed: { mark: "–", className: "text-muted-foreground" },
};

/** The latest verdict per role, in a fixed order. */
function latestChecks(pr: PrSummary) {
  const byRole = new Map<string, PrSummary["checks"][number]>();
  for (const check of pr.checks) byRole.set(check.role, check);
  return ["review1", "review2", "security", "shadow"].flatMap((role) => byRole.get(role) ?? []);
}

function PrChips({ pr }: { pr: PrSummary }) {
  const navigate = useBbNavigate();
  const state = pr.state === "merged" ? "merged" : pr.state === "closed" ? "closed" : pr.isDraft ? "draft" : "ready";
  return (
    <div className="flex flex-wrap items-center gap-1 text-[10px]">
      <span
        role="link"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          navigate.openUrl(pr.url);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.stopPropagation();
            navigate.openUrl(pr.url);
          }
        }}
        className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-medium hover:bg-state-hover"
        title={pr.url}
      >
        <Icon name="GitPullRequest" fallback="Link" className="size-3" />#{pr.number}
        <span className="text-muted-foreground">{state}</span>
      </span>
      {latestChecks(pr).map((check) => (
        <span key={check.role} className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5" title={`${check.label}: ${check.verdict}`}>
          {check.role === "shadow" ? "Shadow" : check.label === "Security" ? "Sec" : check.label.replace("Reviewer ", "R")}
          <span className={VERDICT_STYLE[check.verdict].className}>{VERDICT_STYLE[check.verdict].mark}</span>
        </span>
      ))}
      {pr.scan === null ? null : (
        <span
          className={cn(
            "rounded border border-border px-1.5 py-0.5",
            pr.scan === "failed" ? "text-destructive" : pr.scan === "running" ? "text-muted-foreground" : "",
          )}
          title={`Rafter scan ${pr.scan}`}
        >
          Rafter {pr.scan === "running" ? "…" : pr.scan === "failed" ? "✗" : "✓"}
        </span>
      )}
    </div>
  );
}

// ---------- Data ----------

function useFactories() {
  const rpc = useRpc<typeof rpcContract>();
  const [factories, setFactories] = useState<FactorySummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("factories_list").then(
      (result) => {
        setFactories(result.factories);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("board-changed", refetch);
  return { factories, error, refetch };
}

type BoardData = { agents: Agent[]; tasks: BoardTask[]; factory: FactorySummary };

function useBoard(prefix: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [board, setBoard] = useState<BoardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("factory_board", { prefix }).then(
      (result) => {
        setBoard(result);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc, prefix]);
  // Clear the board only when switching factories; a new rpc client must not blank the page.
  useEffect(() => {
    setBoard(null);
  }, [prefix]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("board-changed", (payload) => {
    const changed = (payload as { prefix?: string } | null)?.prefix;
    if (changed === undefined || changed === prefix) refetch();
  });
  return { board, setBoard, error, setError, refetch };
}

function useDoctor(prefix: string) {
  const rpc = useRpc<typeof rpcContract>();
  const [doctor, setDoctor] = useState<FactoryDoctorReport | null>(null);
  const refetchDoctor = useCallback(() => {
    rpc.call("factory_doctor", { prefix }).then(
      (result) => setDoctor(result),
      () => undefined,
    );
  }, [rpc, prefix]);
  useEffect(() => {
    setDoctor(null);
  }, [prefix]);
  useEffect(() => {
    refetchDoctor();
  }, [refetchDoctor]);
  useRealtime("board-changed", (payload) => {
    const changed = (payload as { prefix?: string } | null)?.prefix;
    if (changed === undefined || changed === prefix) refetchDoctor();
  });
  return { doctor, setDoctor, refetchDoctor };
}

// ---------- Page ----------

function FactoryPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const { factories: all, error, refetch } = useFactories();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [deleting, setDeleting] = useState<FactorySummary | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const factories = useMemo(() => all?.filter((factory) => factory.archivedAt === null) ?? null, [all]);
  const archived = useMemo(() => all?.filter((factory) => factory.archivedAt !== null) ?? [], [all]);
  const selected = subPath.split("/")[0]?.toUpperCase() ?? "";
  const first = factories?.[0]?.prefix ?? null;
  const known = factories?.some((factory) => factory.prefix === selected) ?? false;

  const setArchived = (factory: FactorySummary, archive: boolean) => {
    setActionError(null);
    rpc.call(archive ? "factory_archive" : "factory_restore", { prefix: factory.prefix }).then(
      () => {
        refetch();
        if (!archive) {
          setShowArchived(false);
          navigate.toPluginPanel(PANEL_PATH, { subPath: factory.prefix });
        }
      },
      (cause) => setActionError(errorText(cause)),
    );
  };
  const dialogs = (
    <>
      <ArchivedDialog
        open={showArchived}
        factories={archived}
        onClose={() => setShowArchived(false)}
        onRestore={(factory) => setArchived(factory, false)}
        onDelete={(factory) => {
          setShowArchived(false);
          setDeleting(factory);
        }}
      />
      <DeleteFactoryDialog factory={deleting} onClose={() => setDeleting(null)} onDeleted={refetch} />
    </>
  );
  const archivedButton =
    archived.length === 0 ? null : (
      <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowArchived(true)}>
        <Icon name="Archive" fallback="Folder" className="size-4" />
        Archived ({archived.length})
      </Button>
    );

  useEffect(() => {
    if (first !== null && !known) navigate.toPluginPanel(PANEL_PATH, { subPath: first, replace: true });
  }, [first, known, navigate]);

  if (error !== null && factories === null) {
    return (
      <Frame>
        <Alert>{error}</Alert>
      </Frame>
    );
  }
  if (factories === null) {
    return (
      <Frame>
        <EmptyState>Loading factories…</EmptyState>
      </Frame>
    );
  }
  if (factories.length === 0 || creating) {
    return (
      <Frame>
        <CreateFactory
          onCreated={(prefix) => {
            setCreating(false);
            navigate.toPluginPanel(PANEL_PATH, { subPath: prefix });
          }}
          onCancel={factories.length === 0 ? null : () => setCreating(false)}
        />
        {factories.length === 0 ? archivedButton : null}
        {actionError === null ? null : <Alert>{actionError}</Alert>}
        {dialogs}
      </Frame>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-4 py-2 md:px-5">
        {factories.map((factory) => (
          <ContextMenu key={factory.prefix}>
            <ContextMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                aria-pressed={factory.prefix === selected}
                onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: factory.prefix })}
              >
                {factory.name}
                <span className="font-mono text-[10px] text-muted-foreground">{factory.prefix}</span>
              </Button>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => setArchived(factory, true)}>
                <Icon name="Archive" fallback="Folder" />
                Archive factory
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setDeleting(factory)}
              >
                <Icon name="Trash2" fallback="X" />
                Delete factory…
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ))}
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setCreating(true)}>
          <Icon name="Plus" className="size-4" />
          New factory
        </Button>
        <span className="ml-auto" />
        {archivedButton}
      </div>
      {actionError === null ? null : (
        <div className="px-4 pt-2 md:px-5">
          <Alert>{actionError}</Alert>
        </div>
      )}
      {known ? <FactoryView key={selected} prefix={selected} /> : null}
      {dialogs}
    </div>
  );
}

function ArchivedDialog({
  open,
  factories,
  onClose,
  onRestore,
  onDelete,
}: {
  open: boolean;
  factories: FactorySummary[];
  onClose: () => void;
  onRestore: (factory: FactorySummary) => void;
  onDelete: (factory: FactorySummary) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Archived factories</DialogTitle>
          <DialogDescription>
            Archived factories keep their tasks and agents but take no new work and get no automatic PR reviews.
          </DialogDescription>
        </DialogHeader>
        {factories.length === 0 ? (
          <EmptyState>No archived factories.</EmptyState>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {factories.map((factory) => (
              <li key={factory.prefix} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium">{factory.name}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{factory.prefix}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {factory.archivedAt === null ? "" : `archived ${new Date(factory.archivedAt).toLocaleDateString()}`}
                </span>
                <span className="ml-auto flex shrink-0 gap-1">
                  <Button size="sm" variant="outline" onClick={() => onRestore(factory)}>
                    Restore
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => onDelete(factory)}
                  >
                    Delete…
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteFactoryDialog({
  factory,
  onClose,
  onDeleted,
}: {
  factory: FactorySummary | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [deleteTasks, setDeleteTasks] = useState(true);
  const [archiveThreads, setArchiveThreads] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefix = factory?.prefix ?? null;

  useEffect(() => {
    setDeleteTasks(true);
    setArchiveThreads(false);
    setError(null);
  }, [prefix]);

  const remove = async () => {
    if (factory === null) return;
    setPending(true);
    setError(null);
    try {
      await rpc.call("factory_delete", { prefix: factory.prefix, deleteTasks, archiveThreads });
      onDeleted();
      onClose();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={factory !== null} onOpenChange={(open) => (open || pending ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        {factory === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle>Delete {factory.name}?</DialogTitle>
              <DialogDescription>
                This removes the factory {factory.prefix} for good; it can't be restored. To keep it for later, archive
                it instead. The bb project {factory.bbProjectName} and its files are not touched.
              </DialogDescription>
            </DialogHeader>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={deleteTasks} onCheckedChange={(value) => setDeleteTasks(value === true)} />
              <span>
                Also delete its task board
                <span className="block text-xs text-muted-foreground">
                  The {factory.prefix} tracker in Tasks, with every task and comment.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={archiveThreads} onCheckedChange={(value) => setArchiveThreads(value === true)} />
              <span>
                Also archive its agent threads
                <span className="block text-xs text-muted-foreground">The Lead and specialists still in the sidebar.</span>
              </span>
            </label>
            {error === null ? null : <Alert>{error}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={pending}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => void remove()} disabled={pending}>
                {pending ? "Deleting…" : `Delete ${factory.prefix}`}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function FactoryView({ prefix }: { prefix: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { board, setBoard, error, setError, refetch } = useBoard(prefix);
  const { doctor, setDoctor, refetchDoctor } = useDoctor(prefix);
  const live = useLiveAgents(board?.agents ?? EMPTY_AGENTS);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);
  const [showAlignment, setShowAlignment] = useState(false);

  const move = useCallback(
    (taskId: string, column: Column) => {
      setBoard((current) =>
        current === null
          ? current
          : { ...current, tasks: current.tasks.map((task) => (task.id === taskId ? { ...task, column } : task)) },
      );
      rpc.call("task_move", { prefix, taskId, column }).then(refetch, (cause) => {
        setError(errorText(cause));
        refetch();
      });
    },
    [rpc, prefix, refetch, setBoard, setError],
  );

  if (board === null) {
    return <Frame>{error === null ? <EmptyState>Loading the board…</EmptyState> : <Alert>{error}</Alert>}</Frame>;
  }
  const openTask = board.tasks.find((task) => task.id === openTaskId) ?? null;
  const refreshAll = () => {
    refetch();
    refetchDoctor();
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="space-y-3 px-4 pt-4 md:px-5">
        <AgentsStrip factory={board.factory} doctor={doctor} live={live} onStarted={refreshAll} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Metrics tasks={board.tasks} live={live} />
          {doctor === null ? null : (
            <AlignmentBar doctor={doctor} onOpen={() => setShowAlignment(true)} />
          )}
        </div>
        {error === null ? null : <Alert>{error}</Alert>}
      </div>
      <Board
        prefix={prefix}
        tasks={board.tasks}
        live={live}
        onMove={move}
        onOpen={setOpenTaskId}
        onCreated={refreshAll}
      />
      <TaskDialog
        task={openTask}
        hasLead={board.factory.leadThreadId !== null}
        live={live.filter((entry) => openTask !== null && entry.agent.taskKey === openTask.key)}
        onMove={move}
        onClose={() => setOpenTaskId(null)}
      />
      <AlignmentDialog
        open={showAlignment}
        doctor={doctor}
        hasLead={board.factory.leadThreadId !== null}
        onClose={() => setShowAlignment(false)}
        onUpdated={(nextDoctor) => {
          setDoctor(nextDoctor);
          refetch();
        }}
      />
    </div>
  );
}
const EMPTY_AGENTS: Agent[] = [];

// ---------- Agents ----------

function AgentsStrip({
  factory,
  doctor,
  live,
  onStarted,
}: {
  factory: FactorySummary;
  doctor: FactoryDoctorReport | null;
  live: LiveAgent[];
  onStarted: () => void;
}) {
  const lead = live.find((entry) => entry.agent.threadId === factory.leadThreadId) ?? null;
  const workers = live
    .filter((entry) => entry.agent.role !== "lead")
    .sort((a, b) => b.thread.latestAttentionAt - a.thread.latestAttentionAt);
  return (
    <section aria-label="Agents" className="flex gap-2 overflow-x-auto pb-1">
      {lead === null ? <StartLead factory={factory} doctor={doctor} onStarted={onStarted} /> : <AgentCard entry={lead} />}
      {workers.map((entry) => (
        <AgentCard key={entry.agent.threadId} entry={entry} />
      ))}
      {workers.length === 0 && lead !== null ? (
        <div className="flex w-64 shrink-0 items-center rounded-lg border border-dashed border-border px-3 text-xs text-muted-foreground">
          No specialists yet. Ask the Lead for work, or assign a task from the board.
        </div>
      ) : null}
    </section>
  );
}

const AgentCard = memo(function AgentCard({ entry }: { entry: LiveAgent }) {
  const navigate = useBbNavigate();
  const { agent, thread } = entry;
  const state = agentState(thread);
  return (
    <button
      type="button"
      onClick={() => navigate.toThread(agent.threadId, { split: true })}
      className={cn(
        "flex w-56 shrink-0 flex-col gap-1.5 rounded-lg border bg-card px-3 py-2.5 text-left transition-colors hover:bg-state-hover",
        agent.role === "lead" ? "border-primary/40" : "border-border",
        state.tone === "attention" && "border-amber-500/60",
      )}
    >
      <div className="flex items-center gap-2">
        <AgentProviderIcon providerId={agent.providerId} />
        <span className="text-sm font-medium">{ROLES[agent.role].label}</span>
        {agent.taskKey === null ? null : (
          <span className="font-mono text-[11px] text-muted-foreground">{agent.taskKey}</span>
        )}
        <span className="ml-auto">
          <ThreadStatusGlyph indicator={thread.indicator} size="compact" />
        </span>
      </div>
      <div className="truncate text-xs text-muted-foreground">{thread.displayTitle}</div>
      <div className={cn("text-xs font-medium", TONE_TEXT[state.tone])}>{state.label}</div>
    </button>
  );
});

function AgentProviderIcon({ providerId }: { providerId: string }) {
  const { providers } = experimental_useProviders();
  const provider = providers.find((candidate) => candidate.id === providerId);
  return (
    <ProviderIcon
      providerKind="agent"
      provider={provider === undefined ? { id: providerId } : { id: provider.id, logoUrl: provider.logoUrl, icon: provider.icon ?? null, strings: provider.strings ?? null }}
      className="size-4"
      aria-label={provider?.displayName ?? providerId}
    />
  );
}

function StartLead({
  factory,
  doctor,
  onStarted,
}: {
  factory: FactorySummary;
  doctor: FactoryDoctorReport | null;
  onStarted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [goal, setGoal] = useState("");
  const [projectMode, setProjectMode] = useState<ProjectMode>(factory.projectMode ?? "auto");
  const missingAnySpec =
    doctor !== null &&
    (doctor.files.agentsMd === null ||
      doctor.files.constitution === null ||
      doctor.files.specs === null ||
      doctor.files.roadmap === null);
  const [initSpecs, setInitSpecs] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveMode =
    projectMode === "auto" ? (doctor?.detectedMode ?? "greenfield") : projectMode;

  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    try {
      const { threadId } = await rpc.call("lead_start", {
        prefix: factory.prefix,
        goal: goal.trim() || null,
        projectMode,
        initSpecs: initSpecs && (missingAnySpec || doctor === null),
      });
      onStarted();
      navigate.toThread(threadId, { split: true });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      onSubmit={start}
      className="flex w-full max-w-2xl shrink-0 flex-col gap-2.5 rounded-lg border border-primary/40 bg-card p-3.5"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm font-medium">Start the Lead · Guided Setup</div>
        {doctor === null ? null : (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-0.5 text-[11px] font-medium">
            <span
              className={cn(
                "size-1.5 rounded-full",
                effectiveMode === "greenfield" ? "bg-emerald-500" : "bg-sky-500",
              )}
            />
            {effectiveMode === "greenfield"
              ? "Greenfield (New Project)"
              : `Brownfield (${doctor.commitCount} commits)`}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {effectiveMode === "greenfield"
          ? `Greenfield mode: the Lead will help you lock the project Constitution, PRD, Architecture, and Milestone 1 tasks in ${factory.bbProjectName} before spawning Builders.`
          : `Brownfield mode: the Lead will audit existing docs and board state in ${factory.bbProjectName}, align agents on the Constitution, and report where we are at and the next step.`}
      </p>
      <div className="grid gap-2 sm:grid-cols-[13rem_1fr]">
        <label className="block space-y-1 text-xs">
          <span className="font-medium text-muted-foreground">Project type</span>
          <select
            value={projectMode}
            onChange={(event) => setProjectMode(event.target.value as ProjectMode)}
            className="h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs"
            aria-label="Project type"
          >
            <option value="auto">
              Auto-detect ({doctor?.detectedMode ?? "detecting…"})
            </option>
            <option value="greenfield">Greenfield — New project</option>
            <option value="brownfield">Brownfield — Existing codebase</option>
          </select>
        </label>
        {doctor === null ? null : (
          <div className="space-y-1 text-xs">
            <span className="font-medium text-muted-foreground">Spec-Driven alignment files</span>
            <div className="flex flex-wrap gap-1 pt-0.5">
              <SpecPill label="AGENTS.md" path={doctor.files.agentsMd} />
              <SpecPill label="Constitution" path={doctor.files.constitution} />
              <SpecPill label="Architecture/Spec" path={doctor.files.specs} />
              <SpecPill label="Roadmap" path={doctor.files.roadmap} />
            </div>
          </div>
        )}
      </div>
      {missingAnySpec ? (
        <label className="flex items-start gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-2 text-xs">
          <Checkbox checked={initSpecs} onCheckedChange={(value) => setInitSpecs(value === true)} />
          <span>
            Scaffold missing Spec-Driven files (<code className="font-mono">AGENTS.md</code>,{" "}
            <code className="font-mono">.specify/memory/constitution.md</code>,{" "}
            <code className="font-mono">docs/</code>) before starting (preserves all existing files)
          </span>
        </label>
      ) : null}
      <div className="flex gap-2">
        <Input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder={
            effectiveMode === "greenfield"
              ? "What are we building? (optional — the Lead will guide you)"
              : "What should the factory focus on next? (optional — leave blank for status & next-step audit)"
          }
          aria-label="First goal"
        />
        <Button type="submit" disabled={pending}>
          <Icon name="Play" className="size-4" />
          {pending ? "Starting…" : "Start"}
        </Button>
      </div>
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

function SpecPill({ label, path }: { label: string; path: string | null }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]",
        path !== null
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
      title={path !== null ? `Present: ${path}` : `${label} is missing`}
    >
      <span>{path !== null ? "✓" : "!"}</span>
      <span>{label}</span>
    </span>
  );
}

function AlignmentBar({ doctor, onOpen }: { doctor: FactoryDoctorReport; onOpen: () => void }) {
  const specCount = [
    doctor.files.agentsMd,
    doctor.files.constitution,
    doctor.files.specs,
    doctor.files.roadmap,
  ].filter((f) => f !== null).length;
  const boardIssues =
    doctor.boardHealth.mergedPrsStillOpenTasks.length +
    doctor.boardHealth.inProgressWithoutLiveWorker.length;
  const needsAttention = specCount < 4 || boardIssues > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-state-hover",
        needsAttention ? "border-amber-500/50 bg-amber-500/10 text-foreground" : "border-border bg-card text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          needsAttention ? "bg-amber-500" : "bg-emerald-500",
        )}
      />
      <span className="font-medium capitalize">{doctor.effectiveMode}</span>
      <span className="text-muted-foreground">·</span>
      <span>Specs {specCount}/4</span>
      {boardIssues > 0 ? (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="font-medium text-amber-600 dark:text-amber-400">
            {boardIssues} stalled/merged task{boardIssues === 1 ? "" : "s"}
          </span>
        </>
      ) : null}
    </button>
  );
}

function AlignmentDialog({
  open,
  doctor,
  hasLead,
  onClose,
  onUpdated,
}: {
  open: boolean;
  doctor: FactoryDoctorReport | null;
  hasLead: boolean;
  onClose: () => void;
  onUpdated: (doctor: FactoryDoctorReport) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setStatusNote(null);
      setError(null);
    }
  }, [open]);

  if (doctor === null) return null;

  const missingAnySpec =
    doctor.files.agentsMd === null ||
    doctor.files.constitution === null ||
    doctor.files.specs === null ||
    doctor.files.roadmap === null;

  const changeMode = async (projectMode: ProjectMode) => {
    setPendingAction("mode");
    setError(null);
    try {
      const updated = await rpc.call("factory_set_mode", { prefix: doctor.prefix, projectMode });
      onUpdated(updated);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const initSpecs = async () => {
    setPendingAction("init-specs");
    setError(null);
    try {
      const result = await rpc.call("factory_init_specs", { prefix: doctor.prefix });
      onUpdated(result.doctor);
      setStatusNote(
        result.created.length > 0
          ? `Created ${result.created.join(", ")} (existing files preserved).`
          : "All Spec-Driven alignment files are already present.",
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPendingAction(null);
    }
  };

  const reconcile = async (notifyLead: boolean) => {
    setPendingAction(notifyLead ? "reconcile-notify" : "reconcile");
    setError(null);
    try {
      const result = await rpc.call("factory_reconcile", { prefix: doctor.prefix, notifyLead });
      onUpdated(result.doctor);
      const parts: string[] = [];
      if (result.reconciledMoveToDone.length > 0) {
        parts.push(`Moved ${result.reconciledMoveToDone.join(", ")} to Done.`);
      } else {
        parts.push("No open tasks had already-merged PRs.");
      }
      if (result.leadNotified) {
        parts.push("Sent an alignment & status check-in to the Lead thread.");
      }
      setStatusNote(parts.join(" "));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Project Alignment & Factory Doctor · {doctor.factoryName} ({doctor.prefix})
          </DialogTitle>
          <DialogDescription>
            Spec-Driven Development guardrails, Greenfield/Brownfield mode, and board health diagnostics.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 rounded-md border border-border bg-muted/20 p-3 sm:grid-cols-2">
          <label className="block space-y-1 text-xs">
            <span className="font-medium text-muted-foreground">Project Mode</span>
            <select
              value={doctor.configuredMode}
              disabled={pendingAction !== null}
              onChange={(event) => void changeMode(event.target.value as ProjectMode)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs"
            >
              <option value="auto">
                Auto-detect ({doctor.detectedMode} · {doctor.commitCount} commits)
              </option>
              <option value="greenfield">Greenfield — New project</option>
              <option value="brownfield">Brownfield — Existing codebase</option>
            </select>
          </label>
          <div className="space-y-1 text-xs">
            <div className="font-medium text-muted-foreground">Checkout & Mode Summary</div>
            <div className="truncate font-mono text-[11px]">{doctor.projectPath ?? "No local path"}</div>
            <div className="text-muted-foreground">
              Effective mode: <strong className="capitalize text-foreground">{doctor.effectiveMode}</strong> ({doctor.commitCount} commits)
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">
              1. Spec-Driven Alignment Files (Living Repo Truth)
            </div>
            {missingAnySpec ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={pendingAction !== null}
                onClick={() => void initSpecs()}
              >
                {pendingAction === "init-specs" ? "Scaffolding…" : "Scaffold Missing Spec Files"}
              </Button>
            ) : null}
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <div className="rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between font-medium">
                <span>Agent Router (AGENTS.md)</span>
                <SpecPill label="AGENTS.md" path={doctor.files.agentsMd} />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Routes Lead, Planner, Builders, and Reviewers to the canonical specs and workflow rules.
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between font-medium">
                <span>Project Constitution</span>
                <SpecPill label="Constitution" path={doctor.files.constitution} />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Immutable architectural principles and Spec-Bound PR Review Convergence rules (<code className="font-mono">.specify/memory/constitution.md</code>).
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between font-medium">
                <span>Living Architecture & Specs</span>
                <SpecPill label="Specs" path={doctor.files.specs} />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Canonical system architecture and domain contracts (<code className="font-mono">{doctor.files.specs ?? "docs/architecture.md"}</code>).
              </p>
            </div>
            <div className="rounded-md border border-border p-2.5">
              <div className="flex items-center justify-between font-medium">
                <span>Milestone & Gate Roadmap</span>
                <SpecPill label="Roadmap" path={doctor.files.roadmap} />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Tracks active milestones, gates, and what comes next (<code className="font-mono">{doctor.files.roadmap ?? "docs/roadmap.md"}</code>).
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-muted-foreground">
              2. Board & Agent Health Diagnostics
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Button
                size="sm"
                variant="outline"
                disabled={pendingAction !== null}
                onClick={() => void reconcile(false)}
              >
                {pendingAction === "reconcile" ? "Reconciling…" : "Reconcile Merged PRs"}
              </Button>
              {hasLead ? (
                <Button
                  size="sm"
                  variant="default"
                  disabled={pendingAction !== null}
                  onClick={() => void reconcile(true)}
                >
                  {pendingAction === "reconcile-notify"
                    ? "Notifying Lead…"
                    : "Reconcile & Ask Lead for Status"}
                </Button>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5 rounded-md border border-border p-3 text-xs">
            <div>
              <span className="font-medium">Merged PRs still open on board: </span>
              {doctor.boardHealth.mergedPrsStillOpenTasks.length === 0 ? (
                <span className="text-emerald-600 dark:text-emerald-400">None ✓</span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">
                  {doctor.boardHealth.mergedPrsStillOpenTasks
                    .map((t) => `${t.taskKey} (PR #${t.pr})`)
                    .join(", ")}
                </span>
              )}
            </div>
            <div>
              <span className="font-medium">In-Progress tasks with no active worker thread: </span>
              {doctor.boardHealth.inProgressWithoutLiveWorker.length === 0 ? (
                <span className="text-emerald-600 dark:text-emerald-400">None ✓</span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">
                  {doctor.boardHealth.inProgressWithoutLiveWorker
                    .map((t) => `${t.taskKey} (${t.lastRoles.join("/") || "no agent"})`)
                    .join(", ")}
                </span>
              )}
            </div>
            <div>
              <span className="font-medium">READY plans awaiting Builder or completion: </span>
              {doctor.boardHealth.readyPlansAwaitingBuilder.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span>
                  {doctor.boardHealth.readyPlansAwaitingBuilder
                    .map((t) => `${t.taskKey} (${t.title})`)
                    .join(", ")}
                </span>
              )}
            </div>
            <div>
              <span className="font-medium">Open PRs in flight: </span>
              {doctor.boardHealth.openPrsAwaitingAction.length === 0 ? (
                <span className="text-muted-foreground">None</span>
              ) : (
                <span>
                  {doctor.boardHealth.openPrsAwaitingAction
                    .map((t) => `${t.taskKey} PR #${t.pr} (${t.summary})`)
                    .join(" · ")}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">3. Recommended Actions</div>
          {doctor.recommendedActions.map((action) => (
            <div key={action.id} className="rounded-md border border-border bg-muted/30 p-2.5 text-xs">
              <div className="font-medium">{action.title}</div>
              <p className="mt-0.5 text-muted-foreground">{action.detail}</p>
              {action.command === null ? null : (
                <code className="mt-1 block rounded bg-background px-2 py-1 font-mono text-[11px]">
                  {action.command}
                </code>
              )}
            </div>
          ))}
        </div>

        {statusNote === null ? null : (
          <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
            {statusNote}
          </p>
        )}
        {error === null ? null : <Alert>{error}</Alert>}
      </DialogContent>
    </Dialog>
  );
}

function Metrics({ tasks, live }: { tasks: BoardTask[]; live: LiveAgent[] }) {
  const working = live.filter((entry) => agentState(entry.thread).tone === "working").length;
  const needsYou = live.filter((entry) => agentState(entry.thread).tone === "attention").length;
  const count = (column: Column) => tasks.filter((task) => task.column === column).length;
  const items: { label: string; value: number; tone?: string }[] = [
    { label: "agents working", value: working, tone: working > 0 ? TONE_TEXT.working : undefined },
    { label: "need you", value: needsYou, tone: needsYou > 0 ? TONE_TEXT.attention : undefined },
    { label: "in flight", value: count("in_progress") + count("in_review") },
    { label: "blocked", value: count("blocked"), tone: count("blocked") > 0 ? "text-destructive" : undefined },
    { label: "done", value: count("done") },
  ];
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
      {items.map((item) => (
        <span key={item.label}>
          <span className={cn("mr-1 text-sm font-semibold tabular-nums text-foreground", item.tone)}>
            {item.value}
          </span>
          {item.label}
        </span>
      ))}
    </div>
  );
}

// ---------- Board ----------

function Board({
  prefix,
  tasks,
  live,
  onMove,
  onOpen,
  onCreated,
}: {
  prefix: string;
  tasks: BoardTask[];
  live: LiveAgent[];
  onMove: (taskId: string, column: Column) => void;
  onOpen: (taskId: string) => void;
  onCreated: () => void;
}) {
  const [dragOver, setDragOver] = useState<Column | null>(null);
  const agentsByTask = useMemo(() => {
    const map = new Map<string, LiveAgent[]>();
    for (const entry of live) {
      if (entry.agent.taskKey === null) continue;
      map.set(entry.agent.taskKey, [...(map.get(entry.agent.taskKey) ?? []), entry]);
    }
    return map;
  }, [live]);
  const drop = (column: Column) => (event: DragEvent) => {
    event.preventDefault();
    setDragOver(null);
    const taskId = event.dataTransfer.getData("text/x-factory-task");
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task !== undefined && task.column !== column) onMove(taskId, column);
  };
  return (
    <div className="mt-3 min-h-0 flex-1 overflow-x-auto overflow-y-hidden px-4 pb-4 md:px-5">
      <div className="grid h-full min-w-[1080px] grid-cols-6 gap-3">
        {COLUMNS.map((column) => {
          const inColumn = tasks.filter((task) => task.column === column.id);
          return (
            <section
              key={column.id}
              aria-label={column.label}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOver(column.id);
              }}
              onDragLeave={() => setDragOver((current) => (current === column.id ? null : current))}
              onDrop={drop(column.id)}
              className={cn(
                "flex min-h-0 flex-col rounded-lg border border-border bg-muted/30",
                dragOver === column.id && "border-primary/60 bg-primary/5",
              )}
            >
              <header className="flex items-center gap-2 px-3 py-2 text-xs font-medium">
                <span className={cn("size-2 rounded-full", column.dot)} />
                {column.label}
                <span className="ml-auto tabular-nums text-muted-foreground">{inColumn.length}</span>
              </header>
              <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
                {column.id === "backlog" ? <QuickAdd prefix={prefix} onCreated={onCreated} /> : null}
                {inColumn.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    agents={agentsByTask.get(task.key) ?? EMPTY_LIVE}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
const EMPTY_LIVE: LiveAgent[] = [];

const TaskCard = memo(function TaskCard({
  task,
  agents,
  onOpen,
}: {
  task: BoardTask;
  agents: LiveAgent[];
  onOpen: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("text/x-factory-task", task.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onClick={() => onOpen(task.id)}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-2.5 py-2 text-left shadow-sm transition-colors hover:bg-state-hover"
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-mono">{task.key}</span>
        {task.priority === "none" ? null : (
          <span className={cn("ml-auto capitalize", PRIORITY_STYLE[task.priority])}>{task.priority}</span>
        )}
      </div>
      <div className="line-clamp-3 text-sm leading-snug">{task.title}</div>
      {task.pr === null ? null : <PrChips pr={task.pr} />}
      {agents.length === 0 ? null : (
        <div className="flex flex-wrap gap-1">
          {agents.map(({ agent, thread }) => {
            const state = agentState(thread);
            return (
              <span
                key={agent.threadId}
                className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px]"
                title={`${ROLES[agent.role].label}: ${state.label}`}
              >
                <ThreadStatusGlyph indicator={thread.indicator} size="compact" />
                <span className={TONE_TEXT[state.tone]}>{ROLES[agent.role].label}</span>
              </span>
            );
          })}
        </div>
      )}
    </button>
  );
});

function QuickAdd({ prefix, onCreated }: { prefix: string; onCreated: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false);
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = title.trim();
    if (next === "" || pending) return;
    setPending(true);
    try {
      await rpc.call("task_create", { prefix, title: next });
      setTitle("");
      onCreated();
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={add}>
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="+ Add a task"
        aria-label="New task title"
        className="h-8 text-xs"
      />
    </form>
  );
}

// ---------- Task detail ----------

function TaskDialog({
  task,
  hasLead,
  live,
  onMove,
  onClose,
}: {
  task: BoardTask | null;
  hasLead: boolean;
  live: LiveAgent[];
  onMove: (taskId: string, column: Column) => void;
  onClose: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [detail, setDetail] = useState<{ description: string; comments: TaskComment[] } | null>(null);
  const [instructions, setInstructions] = useState("");
  const [pending, setPending] = useState<AssignableRoleId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const taskId = task?.id ?? null;
  const updatedAt = task?.updatedAt ?? null;

  useEffect(() => {
    setDetail(null);
    setError(null);
    setInstructions("");
  }, [taskId]);
  useEffect(() => {
    if (taskId === null) return;
    let cancelled = false;
    rpc.call("task_detail", { taskId }).then(
      (result) => {
        if (!cancelled) setDetail(result);
      },
      (cause) => {
        if (!cancelled) setError(errorText(cause));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, taskId, updatedAt]);

  const assign = async (role: AssignableRoleId) => {
    if (task === null) return;
    setPending(role);
    setError(null);
    try {
      const { threadId } = await rpc.call("task_assign", {
        taskKey: task.key,
        role,
        instructions: instructions.trim() || null,
      });
      setInstructions("");
      navigate.toThread(threadId, { split: true });
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog open={task !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        {task === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-baseline gap-2">
                <span className="font-mono text-sm text-muted-foreground">{task.key}</span>
                {task.title}
              </DialogTitle>
              <DialogDescription>
                {COLUMNS.find((column) => column.id === task.column)?.label}
                {task.priority === "none" ? "" : ` · ${task.priority} priority`}
              </DialogDescription>
            </DialogHeader>

            <div className="flex flex-wrap gap-1">
              {COLUMNS.map((column) => (
                <Button
                  key={column.id}
                  size="sm"
                  variant="outline"
                  aria-pressed={task.column === column.id}
                  disabled={task.column === column.id}
                  onClick={() => onMove(task.id, column.id)}
                >
                  <span className={cn("size-2 rounded-full", column.dot)} />
                  {column.label}
                </Button>
              ))}
            </div>

            <div className="rounded-md border border-border p-3 text-sm">
              {detail === null ? (
                <span className="text-muted-foreground">Loading…</span>
              ) : detail.description.trim() === "" ? (
                <span className="text-muted-foreground">No description.</span>
              ) : (
                <Markdown content={detail.description} />
              )}
            </div>

            {task.pr === null ? null : (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Pull request</div>
                <PrChips pr={task.pr} />
                {latestChecks(task.pr).some((check) => check.role === "shadow" && (check.verdict === "changes" || check.verdict === "pending")) ? (
                  <ShadowDismiss taskKey={task.key} />
                ) : null}
              </div>
            )}

            {live.length === 0 ? null : (
              <div className="space-y-1">
                <div className="text-xs font-medium text-muted-foreground">Agents on this task</div>
                {live.map(({ agent, thread }) => (
                  <button
                    key={agent.threadId}
                    type="button"
                    onClick={() => navigate.toThread(agent.threadId, { split: true })}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                  >
                    <ThreadStatusGlyph indicator={thread.indicator} size="compact" />
                    <span className="font-medium">{ROLES[agent.role].label}</span>
                    <span className="truncate text-muted-foreground">{thread.displayTitle}</span>
                    <span className={cn("ml-auto shrink-0 text-xs", TONE_TEXT[agentState(thread).tone])}>
                      {agentState(thread).label}
                    </span>
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Assign to a specialist</div>
              {hasLead ? (
                <>
                  <Input
                    value={instructions}
                    onChange={(event) => setInstructions(event.target.value)}
                    placeholder="Notes for the agent (optional)"
                    aria-label="Notes for the agent"
                  />
                  <div className="flex flex-wrap gap-1">
                    {WORKER_ROLE_IDS.map((role) => (
                      <Button
                        key={role}
                        size="sm"
                        variant="secondary"
                        disabled={pending !== null}
                        onClick={() => void assign(role)}
                      >
                        {pending === role ? "Starting…" : ROLES[role].label}
                      </Button>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    QA and reviewers work in the builder's worktree, so assign a Builder first.
                  </p>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Start the Lead first; specialists run as its child threads.
                </p>
              )}
            </div>

            {error === null ? null : <Alert>{error}</Alert>}

            {detail === null || detail.comments.length === 0 ? null : (
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Activity</div>
                {detail.comments
                  .slice()
                  .reverse()
                  .map((entry) => (
                    <div key={entry.id} className="rounded-md bg-muted/40 px-3 py-2 text-sm">
                      <div className="mb-1 text-[11px] text-muted-foreground">
                        {entry.authorName} · {new Date(entry.createdAt).toLocaleString()}
                      </div>
                      <Markdown content={entry.body} />
                    </div>
                  ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  onClose();
                  window.history.pushState(null, "", `/plugins/tasks/tasks/task/${encodeURIComponent(task.key)}`);
                  window.dispatchEvent(new PopStateEvent("popstate"));
                }}
              >
                Open in Tasks
                <Icon name="ExternalLink" className="size-3.5" />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The person's way to clear a shadow block they judge to be a false alarm. */
function ShadowDismiss({ taskKey }: { taskKey: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dismiss = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await rpc.call("shadow_dismiss", { taskKey, reason: reason.trim() });
      setReason("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={dismiss} className="mt-2 space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3">
      <p className="text-xs">
        The shadow Security reviewer requested changes or hasn't finished, so this PR stays in draft once the other
        reviewers approve. Fix its findings, wait for it, or dismiss it with a reason. Its review is in the task's
        activity.
      </p>
      <div className="flex gap-2">
        <Input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Why the findings don't hold"
          aria-label="Reason for dismissing"
        />
        <Button type="submit" variant="outline" disabled={pending || reason.trim().length < 3}>
          Dismiss
        </Button>
      </div>
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}

// ---------- Create a factory ----------

function CreateFactory({
  onCreated,
  onCancel,
}: {
  onCreated: (prefix: string) => void;
  onCancel: (() => void) | null;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [prefix, setPrefix] = useState("");
  const [name, setName] = useState("");
  const [projectMode, setProjectMode] = useState<ProjectMode>("auto");
  const [initSpecs, setInitSpecs] = useState(true);
  const [inspected, setInspected] = useState<(RepoInspection & { projectPath: string | null }) | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("projects_list").then(
      (result) => setProjects(result.projects),
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    setInspected(null);
    if (projectId === "") return;
    let cancelled = false;
    rpc.call("project_inspect", { bbProjectId: projectId }).then(
      (result) => {
        if (!cancelled) setInspected(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, projectId]);

  const project = projects?.find((candidate) => candidate.id === projectId) ?? null;
  const effectiveMode =
    projectMode === "auto" ? (inspected?.detectedMode ?? "greenfield") : projectMode;
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (project === null) return;
    setPending(true);
    setError(null);
    try {
      const created = await rpc.call("factory_create", {
        bbProjectId: project.id,
        prefix: prefix.trim().toUpperCase(),
        name: name.trim() || project.name,
        projectMode,
        initSpecs,
      });
      onCreated(created.prefix);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={create} className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">New software factory</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          A factory gives one project a Lead agent, specialist agents (planner, builder, QA, designer, reviewers),
          Spec-Driven alignment files, and its own task board.
        </p>
      </div>
      <label className="block space-y-1 text-sm">
        <span className="font-medium">Project</span>
        <select
          value={projectId}
          onChange={(event) => {
            const next = projects?.find((candidate) => candidate.id === event.target.value);
            setProjectId(event.target.value);
            if (next !== undefined && prefix === "") {
              setPrefix(next.name.replace(/[^a-zA-Z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 4).toUpperCase());
            }
          }}
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          required
        >
          <option value="" disabled>
            {projects === null ? "Loading projects…" : "Choose a project"}
          </option>
          {(projects ?? []).map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-[8rem_1fr] gap-3">
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Task prefix</span>
          <Input
            value={prefix}
            onChange={(event) => setPrefix(event.target.value.toUpperCase())}
            placeholder="APP"
            maxLength={10}
            required
          />
        </label>
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Name</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={project?.name ?? "Factory name"}
          />
        </label>
      </div>
      {project === null ? null : (
        <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3 text-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium">Project Alignment & Type</span>
            {inspected === null ? (
              <span className="text-xs text-muted-foreground">Inspecting repository…</span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-0.5 text-xs font-medium">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    effectiveMode === "greenfield" ? "bg-emerald-500" : "bg-sky-500",
                  )}
                />
                Detected: {inspected.detectedMode === "greenfield" ? "Greenfield" : `Brownfield (${inspected.commitCount} commits)`}
              </span>
            )}
          </div>
          <label className="block space-y-1 text-xs">
            <span className="font-medium text-muted-foreground">How should the Factory treat this project?</span>
            <select
              value={projectMode}
              onChange={(event) => setProjectMode(event.target.value as ProjectMode)}
              className="h-8 w-full rounded-md border border-input bg-background px-2.5 text-xs"
            >
              <option value="auto">
                Auto-detect ({inspected?.detectedMode ?? "greenfield"})
              </option>
              <option value="greenfield">Greenfield — New project (shape PRD, Constitution & Milestone 1 first)</option>
              <option value="brownfield">Brownfield — Existing codebase (audit current state, specs & board first)</option>
            </select>
          </label>
          {inspected === null ? null : (
            <div className="flex flex-wrap gap-1.5">
              <SpecPill label="AGENTS.md" path={inspected.files.agentsMd} />
              <SpecPill label="Constitution" path={inspected.files.constitution} />
              <SpecPill label="Architecture/Spec" path={inspected.files.specs} />
              <SpecPill label="Roadmap" path={inspected.files.roadmap} />
            </div>
          )}
          <label className="flex items-start gap-2 text-xs">
            <Checkbox checked={initSpecs} onCheckedChange={(value) => setInitSpecs(value === true)} />
            <span>
              Scaffold missing Spec-Driven alignment files (<code className="font-mono">AGENTS.md</code>,{" "}
              <code className="font-mono">.specify/memory/constitution.md</code>,{" "}
              <code className="font-mono">docs/architecture.md</code>,{" "}
              <code className="font-mono">docs/roadmap.md</code>) without overwriting existing files
            </span>
          </label>
        </div>
      )}
      {error === null ? null : <Alert>{error}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" disabled={pending || project === null || prefix.trim() === ""}>
          {pending ? "Creating…" : "Create factory"}
        </Button>
        {onCancel === null ? null : (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

// ---------- Settings: the Agents section ----------

type AgentRow = AgentsView["agents"][number];

/** Plugin settings section: one line per agent with bb's provider, model and reasoning picker. */
function AgentsSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [view, setView] = useState<AgentsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refetch = useCallback(() => {
    rpc.call("agents_get", null).then(setView, (cause) => setError(errorText(cause)));
  }, [rpc]);
  useEffect(refetch, [refetch]);
  useRealtime("agents-changed", refetch);

  const save = useCallback(
    async (input: Parameters<typeof rpc.call<"agent_set">>[1]) => {
      setError(null);
      try {
        setView(await rpc.call("agent_set", input));
      } catch (cause) {
        setError(errorText(cause));
        refetch();
      }
    },
    [rpc, refetch],
  );

  if (view === null) {
    return error === null ? <p className="text-sm text-muted-foreground">Loading agents…</p> : <Alert>{error}</Alert>;
  }
  return (
    <div className="space-y-3">
      <div className="divide-y divide-border">
        {view.agents.map((row) => (
          <AgentSettingRow
            key={row.key}
            row={row}
            customModel={row.key === "shadow" ? view.shadowCustomModel : null}
            onExec={(exec) => save({ kind: "exec", key: row.key, exec })}
            onCustomModel={(model) => save({ kind: "shadowCustomModel", model })}
          />
        ))}
      </div>
      {error === null ? null : <Alert>{error}</Alert>}
    </div>
  );
}

function AgentSettingRow({
  row,
  customModel,
  onExec,
  onCustomModel,
}: {
  row: AgentRow;
  customModel: string | null;
  onExec: (exec: AgentExec) => void;
  onCustomModel: (model: string | null) => void;
}) {
  const { exec, defaultModel, defaultReasoning } = row;
  const usesDefaults = exec.model === null && exec.reasoningLevel === null;
  const value: ExperimentalProviderModelPickerValue = {
    providerId: exec.providerId,
    model: exec.model ?? defaultModel ?? "",
    reasoningLevel: exec.reasoningLevel ?? defaultReasoning ?? "medium",
  };
  const onChange = (next: ExperimentalProviderModelPickerValue) => {
    const sameProvider = next.providerId === exec.providerId;
    // Keep "provider default" for a part the person didn't change.
    const changed: AgentExec = {
      providerId: next.providerId,
      model: sameProvider && exec.model === null && next.model === value.model ? null : next.model,
      reasoningLevel: sameProvider && exec.reasoningLevel === null && next.reasoningLevel === value.reasoningLevel ? null : next.reasoningLevel,
    };
    // The picker can re-emit the value it was given; only a real change is saved.
    if (changed.providerId === exec.providerId && changed.model === exec.model && changed.reasoningLevel === exec.reasoningLevel) return;
    onExec(changed);
  };
  return (
    <div className="py-2.5">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{row.label}</div>
          <div className="text-xs text-muted-foreground">
            {customModel !== null ? `Custom model ${customModel}` : usesDefaults ? "Provider defaults" : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ProviderModelPicker value={value} onChange={onChange} align="end" />
          {usesDefaults ? null : (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => onExec({ providerId: exec.providerId, model: null, reasoningLevel: null })}
            >
              Use defaults
            </Button>
          )}
        </div>
      </div>
      {row.key === "shadow" ? <CustomModelField value={customModel} onSave={onCustomModel} /> : null}
    </div>
  );
}

/** The shadow's model id sent as-is, for models the picker can't list (such as Codex's gpt-daybreak-blue-latest). */
function CustomModelField({ value, onSave }: { value: string | null; onSave: (model: string | null) => void }) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const commit = () => {
    const next = draft.trim() === "" ? null : draft.trim();
    if (next !== value) onSave(next);
  };
  return (
    <div className="mt-2 flex items-center justify-between gap-4">
      <p className="min-w-0 text-xs text-muted-foreground">
        Custom model id: sent as-is and overrides the picker's model, for a model the picker doesn't list. Leave empty to use the picker.
      </p>
      <Input
        className="h-8 w-64 shrink-0 text-sm"
        value={draft}
        placeholder="e.g. gpt-daybreak-blue-latest"
        aria-label="Shadow security reviewer custom model id"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </div>
  );
}

// ---------- Shared bits ----------

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 p-4 md:p-5">{children}</div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "agents",
    title: "Agents",
    description: "The provider, model and reasoning level each factory agent runs on.",
    component: AgentsSettings,
  });
  app.slots.navPanel({
    id: "factory",
    title: "Factory",
    icon: "factory/factory",
    path: PANEL_PATH,
    component: FactoryPage,
  });
});
