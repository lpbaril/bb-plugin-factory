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
  experimental_ThreadStatusGlyph as ThreadStatusGlyph,
  experimental_useProviders,
  experimental_useSidebarThreads,
  useBbNavigate,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { Agent, BoardTask, Column, FactorySummary, TaskComment, rpcContract } from "./server";
import { ROLES, WORKER_ROLE_IDS, type WorkerRoleId } from "./roles";
import { Button } from "@/components/ui/button";
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
  useEffect(() => {
    setBoard(null);
    refetch();
  }, [refetch]);
  useRealtime("board-changed", (payload) => {
    const changed = (payload as { prefix?: string } | null)?.prefix;
    if (changed === undefined || changed === prefix) refetch();
  });
  return { board, setBoard, error, setError, refetch };
}

// ---------- Page ----------

function FactoryPage({ subPath }: { subPath: string }) {
  const navigate = useBbNavigate();
  const { factories, error } = useFactories();
  const [creating, setCreating] = useState(false);
  const selected = subPath.split("/")[0]?.toUpperCase() ?? "";
  const first = factories?.[0]?.prefix ?? null;
  const known = factories?.some((factory) => factory.prefix === selected) ?? false;

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
      </Frame>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-4 py-2 md:px-5">
        {factories.map((factory) => (
          <Button
            key={factory.prefix}
            variant="ghost"
            size="sm"
            aria-pressed={factory.prefix === selected}
            onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: factory.prefix })}
          >
            {factory.name}
            <span className="font-mono text-[10px] text-muted-foreground">{factory.prefix}</span>
          </Button>
        ))}
        <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setCreating(true)}>
          <Icon name="Plus" className="size-4" />
          New factory
        </Button>
      </div>
      {known ? <FactoryView key={selected} prefix={selected} /> : null}
    </div>
  );
}

function FactoryView({ prefix }: { prefix: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { board, setBoard, error, setError, refetch } = useBoard(prefix);
  const live = useLiveAgents(board?.agents ?? EMPTY_AGENTS);
  const [openTaskId, setOpenTaskId] = useState<string | null>(null);

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
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="space-y-3 px-4 pt-4 md:px-5">
        <AgentsStrip factory={board.factory} live={live} onStarted={refetch} />
        <Metrics tasks={board.tasks} live={live} />
        {error === null ? null : <Alert>{error}</Alert>}
      </div>
      <Board
        prefix={prefix}
        tasks={board.tasks}
        live={live}
        onMove={move}
        onOpen={setOpenTaskId}
        onCreated={refetch}
      />
      <TaskDialog
        task={openTask}
        hasLead={board.factory.leadThreadId !== null}
        live={live.filter((entry) => openTask !== null && entry.agent.taskKey === openTask.key)}
        onMove={move}
        onClose={() => setOpenTaskId(null)}
      />
    </div>
  );
}
const EMPTY_AGENTS: Agent[] = [];

// ---------- Agents ----------

function AgentsStrip({
  factory,
  live,
  onStarted,
}: {
  factory: FactorySummary;
  live: LiveAgent[];
  onStarted: () => void;
}) {
  const lead = live.find((entry) => entry.agent.threadId === factory.leadThreadId) ?? null;
  const workers = live
    .filter((entry) => entry.agent.role !== "lead")
    .sort((a, b) => b.thread.latestAttentionAt - a.thread.latestAttentionAt);
  return (
    <section aria-label="Agents" className="flex gap-2 overflow-x-auto pb-1">
      {lead === null ? <StartLead factory={factory} onStarted={onStarted} /> : <AgentCard entry={lead} />}
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

function StartLead({ factory, onStarted }: { factory: FactorySummary; onStarted: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [goal, setGoal] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    try {
      const { threadId } = await rpc.call("lead_start", { prefix: factory.prefix, goal: goal.trim() || null });
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
      className="flex w-full max-w-xl shrink-0 flex-col gap-2 rounded-lg border border-primary/40 bg-card p-3"
    >
      <div className="text-sm font-medium">Start the Lead</div>
      <p className="text-xs text-muted-foreground">
        The Lead turns what you want into tasks and runs the specialists in {factory.bbProjectName}.
      </p>
      <div className="flex gap-2">
        <Input
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="What should the factory build first? (optional)"
          aria-label="First goal"
        />
        <Button type="submit" disabled={pending}>
          <Icon name="Play" className="size-4" />
          Start
        </Button>
      </div>
      {error === null ? null : <p className="text-xs text-destructive">{error}</p>}
    </form>
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
  const [pending, setPending] = useState<WorkerRoleId | null>(null);
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

  const assign = async (role: WorkerRoleId) => {
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
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("projects_list").then(
      (result) => setProjects(result.projects),
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);

  const project = projects?.find((candidate) => candidate.id === projectId) ?? null;
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
          A factory gives one project a Lead agent, specialist agents (builder, QA, designer, two reviewers) and its
          own task board.
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
  app.slots.navPanel({
    id: "factory",
    title: "Factory",
    icon: "factory/factory",
    path: PANEL_PATH,
    component: FactoryPage,
  });
});
