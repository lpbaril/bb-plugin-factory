// bb-plugin-factory: a software factory of bb agent threads.
//
// A factory ties one bb project to one Tasks tracker project. Its Lead thread
// shapes work into tasks and assigns them with `bb factory assign`, which
// spawns a specialist (builder, QA, designer, reviewers) as the Lead's child
// thread. The Factory page shows the agents and the tracker as a kanban board.
//
// Tasks are owned by the built-in Tasks plugin; this plugin reads and moves
// them through its RPC. Factories and their agent roster live in kv.
import {
  PluginCliError,
  cliCommand,
  defineCli,
  defineRpcContract,
  type BbPluginApi,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  ROLES,
  ROLE_IDS,
  WORKER_ROLE_IDS,
  leadPrompt,
  workerPrompt,
  type RoleId,
  type WorkerRoleId,
} from "./roles";

// ---------- Tasks plugin wire shapes (the subset this plugin reads) ----------

const TASK_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done", "canceled"] as const;
type TaskStatus = (typeof TASK_STATUSES)[number];

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.enum(TASK_STATUSES),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]),
  position: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  labelIds: z.array(z.string()),
});
type Task = z.infer<typeof taskSchema>;

const taskResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task: taskSchema }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);
const trackerProjectSchema = z.object({ id: z.string(), name: z.string(), prefix: z.string() });
const labelSchema = z.object({ id: z.string(), name: z.string(), color: z.string() });
const commentSchema = z.object({
  id: z.string(),
  kind: z.enum(["user", "agent", "system"]),
  authorName: z.string(),
  threadId: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
});
export type TaskComment = z.infer<typeof commentSchema>;

// ---------- Factory state ----------

export const COLUMNS = ["backlog", "todo", "in_progress", "in_review", "done", "blocked"] as const;
export type Column = (typeof COLUMNS)[number];

const agentSchema = z.object({
  threadId: z.string(),
  role: z.enum(ROLE_IDS),
  taskKey: z.string().nullable(),
  providerId: z.string(),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

const factorySchema = z.object({
  /** The tracker prefix, which is also the factory's id. */
  prefix: z.string(),
  name: z.string(),
  bbProjectId: z.string(),
  trackerProjectId: z.string(),
  blockedLabelId: z.string(),
  leadThreadId: z.string().nullable(),
  agents: z.array(agentSchema),
  createdAt: z.string(),
});
type Factory = z.infer<typeof factorySchema>;

const boardTaskSchema = z.object({
  id: z.string(),
  key: z.string(),
  title: z.string(),
  status: z.enum(TASK_STATUSES),
  column: z.enum(COLUMNS),
  priority: z.string(),
  updatedAt: z.string(),
});
export type BoardTask = z.infer<typeof boardTaskSchema>;

const factorySummarySchema = factorySchema.omit({ agents: true }).extend({
  bbProjectName: z.string(),
});
export type FactorySummary = z.infer<typeof factorySummarySchema>;

const prefixSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{0,9}$/, "Prefix: 1-10 letters or digits, starting with a letter");

export const rpcContract = defineRpcContract({
  factories_list: {
    input: z.null(),
    output: z.object({ factories: z.array(factorySummarySchema) }),
  },
  projects_list: {
    input: z.null(),
    output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string() })) }),
  },
  factory_create: {
    input: z.object({
      bbProjectId: z.string().startsWith("proj_"),
      prefix: prefixSchema,
      name: z.string().trim().min(1).max(80),
    }),
    output: factorySummarySchema,
  },
  factory_board: {
    input: z.object({ prefix: z.string() }),
    output: z.object({
      factory: factorySummarySchema,
      agents: z.array(agentSchema),
      tasks: z.array(boardTaskSchema),
    }),
  },
  lead_start: {
    input: z.object({ prefix: z.string(), goal: z.string().trim().max(4000).nullable() }),
    output: z.object({ threadId: z.string() }),
  },
  task_create: {
    input: z.object({ prefix: z.string(), title: z.string().trim().min(1).max(200) }),
    output: boardTaskSchema,
  },
  task_move: {
    input: z.object({ prefix: z.string(), taskId: z.string(), column: z.enum(COLUMNS) }),
    output: boardTaskSchema,
  },
  task_detail: {
    input: z.object({ taskId: z.string() }),
    output: z.object({ description: z.string(), comments: z.array(commentSchema) }),
  },
  task_assign: {
    input: z.object({
      taskKey: z.string(),
      role: z.enum(WORKER_ROLE_IDS),
      instructions: z.string().trim().max(4000).nullable(),
    }),
    output: z.object({ threadId: z.string() }),
  },
});

/** Published whenever a factory's board or roster may have changed. */
const BOARD_CHANGED = "board-changed";
const POLL_MS = 4000;

export default async function plugin(bb: BbPluginApi) {
  const providerOptions = ["claude-code", "codex"];
  const settings = bb.settings.define({
    leadProvider: { type: "select", label: "Lead runs on", options: providerOptions, default: "claude-code" },
    buildProvider: { type: "select", label: "Builder runs on", options: providerOptions, default: "claude-code" },
    qaProvider: { type: "select", label: "QA runs on", options: providerOptions, default: "codex" },
    designProvider: { type: "select", label: "Designer runs on", options: providerOptions, default: "claude-code" },
    review1Provider: { type: "select", label: "Reviewer 1 runs on", options: providerOptions, default: "claude-code" },
    review2Provider: { type: "select", label: "Reviewer 2 runs on", options: providerOptions, default: "codex" },
    agentPermissions: {
      type: "select",
      label: "Agent permissions",
      description:
        "Permission mode for new factory agents. auto: commands outside the sandbox wait for your approval. accept-edits: file edits run, commands ask. full: no approvals at all; agents can run any command on this machine, so the factory can work while you're away.",
      options: ["auto", "accept-edits", "full"],
      default: "auto",
    },
  });
  async function permissionMode(): Promise<"auto" | "accept-edits" | "full"> {
    const { agentPermissions } = await settings.get();
    return agentPermissions === "full" || agentPermissions === "accept-edits" ? agentPermissions : "auto";
  }
  async function providerFor(role: RoleId): Promise<string> {
    const values = await settings.get();
    return values[`${role}Provider`];
  }

  // ----- Tasks plugin access -----

  function tasksRpc<T>(method: string, input: unknown, outputSchema: z.ZodType<T>): Promise<T> {
    return bb.sdk.plugins.callRpc({
      pluginId: "tasks",
      method,
      input: input as never,
      outputSchema,
    });
  }
  function unwrap(result: z.infer<typeof taskResultSchema>): Task {
    if (!result.ok) throw new Error(result.error.message);
    return result.task;
  }
  async function getTaskByKey(taskKey: string): Promise<Task> {
    const { task } = await tasksRpc(
      "getTaskByKey",
      { taskKey: taskKey.trim().toUpperCase() },
      z.object({ task: taskSchema.nullable() }),
    );
    if (task === null) {
      throw new PluginCliError(`No task ${taskKey}.`, {
        code: "task_not_found",
        hint: "Run `bb factory status` to see task keys.",
      });
    }
    return task;
  }
  async function getTask(taskId: string): Promise<Task> {
    const { task } = await tasksRpc("getTask", { taskId }, z.object({ task: taskSchema.nullable() }));
    if (task === null) throw new Error(`No task ${taskId}.`);
    return task;
  }
  async function listTasks(factory: Factory): Promise<Task[]> {
    const { tasks } = await tasksRpc(
      "listTasks",
      { projectId: factory.trackerProjectId, limit: 500 },
      z.object({ tasks: z.array(taskSchema) }),
    );
    return tasks;
  }
  function toBoardTask(factory: Factory, task: Task): BoardTask {
    const blocked =
      task.labelIds.includes(factory.blockedLabelId) && task.status !== "done" && task.status !== "canceled";
    return {
      id: task.id,
      key: task.key,
      title: task.title,
      status: task.status,
      column: blocked ? "blocked" : (task.status as Column),
      priority: task.priority,
      updatedAt: task.updatedAt,
    };
  }
  async function comment(taskId: string, body: string): Promise<void> {
    await tasksRpc("createComment", { taskId, body, notify: false }, z.object({ comment: commentSchema }));
  }

  // ----- Factory storage -----

  const KEY_PREFIX = "factory:";
  async function listFactories(): Promise<Factory[]> {
    const factories: Factory[] = [];
    for (const key of await bb.storage.kv.list(KEY_PREFIX)) {
      const parsed = factorySchema.safeParse(await bb.storage.kv.get(key));
      if (parsed.success) factories.push(parsed.data);
    }
    return factories.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async function findFactory(ref: string): Promise<Factory> {
    const prefix = ref.trim().toUpperCase();
    const parsed = factorySchema.safeParse(await bb.storage.kv.get(KEY_PREFIX + prefix));
    if (!parsed.success) {
      throw new PluginCliError(`No factory ${prefix}.`, {
        code: "factory_not_found",
        hint: "Run `bb factory list` to see factories.",
      });
    }
    return parsed.data;
  }
  function factoryForTaskKey(taskKey: string): Promise<Factory> {
    return findFactory(taskKey.split("-")[0] ?? "");
  }
  async function saveFactory(factory: Factory): Promise<void> {
    await bb.storage.kv.set(KEY_PREFIX + factory.prefix, factory);
    bb.realtime.publish(BOARD_CHANGED, { prefix: factory.prefix });
  }
  async function summarize(factory: Factory): Promise<FactorySummary> {
    let bbProjectName = factory.bbProjectId;
    try {
      bbProjectName = (await bb.sdk.projects.get({ projectId: factory.bbProjectId })).name;
    } catch {
      // A deleted project keeps its id as the name.
    }
    const { agents: _agents, ...rest } = factory;
    return { ...rest, bbProjectName };
  }

  async function createFactory(args: { bbProjectId: string; prefix: string; name: string }): Promise<Factory> {
    if ((await bb.storage.kv.get(KEY_PREFIX + args.prefix)) !== undefined) {
      throw new PluginCliError(`Factory ${args.prefix} already exists.`, { code: "factory_exists" });
    }
    await bb.sdk.projects.get({ projectId: args.bbProjectId });
    // Reuse a tracker project that already has this prefix; otherwise create one.
    const { projects } = await tasksRpc(
      "listProjects",
      {},
      z.object({ projects: z.array(trackerProjectSchema) }),
    );
    let tracker = projects.find((project) => project.prefix === args.prefix);
    if (tracker === undefined) {
      const created = await tasksRpc(
        "createProject",
        { name: args.name, prefix: args.prefix, color: "violet", folderId: null, linkedBbProjectId: args.bbProjectId },
        z.object({ project: trackerProjectSchema }),
      );
      tracker = created.project;
    }
    const { labels } = await tasksRpc(
      "listLabels",
      { projectId: tracker.id },
      z.object({ labels: z.array(labelSchema) }),
    );
    let blocked = labels.find((label) => label.name.toLowerCase() === "blocked");
    if (blocked === undefined) {
      const created = await tasksRpc(
        "createLabel",
        { projectId: tracker.id, name: "blocked", color: "red" },
        z.object({ label: labelSchema }),
      );
      blocked = created.label;
    }
    const factory: Factory = {
      prefix: args.prefix,
      name: args.name,
      bbProjectId: args.bbProjectId,
      trackerProjectId: tracker.id,
      blockedLabelId: blocked.id,
      leadThreadId: null,
      agents: [],
      createdAt: new Date().toISOString(),
    };
    await saveFactory(factory);
    return factory;
  }

  // ----- Agents -----

  async function startLead(factory: Factory, goal: string | null): Promise<string> {
    if (factory.leadThreadId !== null) {
      const existing = await bb.sdk.threads.get({ threadId: factory.leadThreadId }).catch(() => null);
      if (existing !== null && existing.archivedAt === null && existing.deletedAt === null) {
        throw new PluginCliError(`Factory ${factory.prefix} already has a Lead: ${factory.leadThreadId}.`, {
          code: "lead_exists",
          hint: `Talk to it with \`bb thread tell ${factory.leadThreadId} '<message>'\`, or archive it to start a new one.`,
        });
      }
    }
    const providerId = await providerFor("lead");
    const thread = await bb.sdk.threads.spawn({
      projectId: factory.bbProjectId,
      environment: { type: "project-default" },
      providerId,
      permissionMode: await permissionMode(),
      title: `${factory.name} · Lead`,
      pinned: true,
      prompt: leadPrompt({ factoryName: factory.name, prefix: factory.prefix, goal }),
      pluginMetadata: { factory: factory.prefix, role: "lead" },
    });
    factory.leadThreadId = thread.id;
    factory.agents.push({
      threadId: thread.id,
      role: "lead",
      taskKey: null,
      providerId,
      createdAt: new Date().toISOString(),
    });
    await saveFactory(factory);
    return thread.id;
  }

  /** The environment of the task's most recent builder, which QA and reviewers check. */
  async function builderEnvironment(
    factory: Factory,
    taskKey: string,
  ): Promise<{ environmentId: string; threadId: string } | null> {
    const builders = factory.agents.filter((agent) => agent.role === "build" && agent.taskKey === taskKey);
    for (const agent of builders.reverse()) {
      const thread = await bb.sdk.threads.get({ threadId: agent.threadId }).catch(() => null);
      if (thread !== null && thread.environmentId !== null && thread.deletedAt === null) {
        return { environmentId: thread.environmentId, threadId: agent.threadId };
      }
    }
    return null;
  }

  async function assign(args: {
    taskKey: string;
    role: WorkerRoleId;
    instructions: string | null;
  }): Promise<string> {
    const task = await getTaskByKey(args.taskKey);
    const factory = await factoryForTaskKey(task.key);
    if (factory.leadThreadId === null) {
      throw new PluginCliError(`Factory ${factory.prefix} has no Lead yet.`, {
        code: "no_lead",
        hint: `Run \`bb factory start ${factory.prefix}\` first.`,
      });
    }
    const role = ROLES[args.role];
    const builder = role.environment === "builder-worktree" ? await builderEnvironment(factory, task.key) : null;
    if (role.environment === "builder-worktree" && builder === null) {
      throw new PluginCliError(`${task.key} has no builder worktree for ${role.label} to check.`, {
        code: "no_builder",
        hint: `Assign a builder first: \`bb factory assign ${task.key} --role build\`.`,
      });
    }
    const providerId = await providerFor(args.role);
    const base = {
      projectId: factory.bbProjectId,
      providerId,
      permissionMode: await permissionMode(),
      parentThreadId: factory.leadThreadId,
      title: `${task.key} · ${role.label}: ${task.title}`.slice(0, 200),
      prompt: workerPrompt({
        role: args.role,
        factoryName: factory.name,
        prefix: factory.prefix,
        task,
        instructions: args.instructions,
        builderThreadId: builder?.threadId ?? null,
      }),
      pluginMetadata: { factory: factory.prefix, role: args.role, taskKey: task.key },
    };
    let thread;
    if (builder !== null) {
      thread = await bb.sdk.threads.spawn({
        ...base,
        environment: { type: "reuse", environmentId: builder.environmentId },
      });
    } else {
      try {
        thread = await bb.sdk.threads.spawn({
          ...base,
          environment: { type: "host", workspace: { type: "managed-worktree", baseBranch: { kind: "default" } } },
        });
      } catch (error) {
        // Not a Git project (or no commits yet): work in the project checkout.
        bb.log.warn(`worktree spawn failed; using the project checkout: ${String(error)}`);
        thread = await bb.sdk.threads.spawn({ ...base, environment: { type: "project-default" } });
      }
    }
    factory.agents.push({
      threadId: thread.id,
      role: args.role,
      taskKey: task.key,
      providerId,
      createdAt: new Date().toISOString(),
    });
    await saveFactory(factory);

    const order: TaskStatus[] = ["backlog", "todo", "in_progress", "in_review"];
    const target = role.movesTaskTo;
    if (target !== null && order.includes(task.status) && order.indexOf(task.status) < order.indexOf(target)) {
      unwrap(
        await tasksRpc("updateTask", { taskId: task.id, status: target, authorName: "Factory" }, taskResultSchema),
      );
    }
    await comment(task.id, `Assigned to **${role.label}** (${providerId}) · thread \`${thread.id}\``);
    return thread.id;
  }

  async function setBlocked(taskKey: string, blocked: boolean, reason: string | null): Promise<Task> {
    const task = await getTaskByKey(taskKey);
    const factory = await factoryForTaskKey(task.key);
    let updated = task;
    if (task.labelIds.includes(factory.blockedLabelId) !== blocked) {
      const labelIds = blocked
        ? [...task.labelIds, factory.blockedLabelId]
        : task.labelIds.filter((id) => id !== factory.blockedLabelId);
      updated = unwrap(
        await tasksRpc("updateTask", { taskId: task.id, labelIds, authorName: "Factory" }, taskResultSchema),
      );
    }
    if (reason !== null) await comment(task.id, `${blocked ? "**Blocked:**" : "**Unblocked:**"} ${reason}`);
    bb.realtime.publish(BOARD_CHANGED, { prefix: factory.prefix });
    return updated;
  }

  async function moveTask(factory: Factory, taskId: string, column: Column): Promise<Task> {
    const task = await getTask(taskId);
    if (task.projectId !== factory.trackerProjectId) {
      throw new Error(`Task ${task.key} is not in factory ${factory.prefix}.`);
    }
    const isBlocked = task.labelIds.includes(factory.blockedLabelId);
    if (column === "blocked") {
      if (isBlocked) return task;
      const labelIds = [...task.labelIds, factory.blockedLabelId];
      return unwrap(await tasksRpc("updateTask", { taskId, labelIds, authorName: "You" }, taskResultSchema));
    }
    let current = task;
    if (isBlocked) {
      const labelIds = task.labelIds.filter((id) => id !== factory.blockedLabelId);
      current = unwrap(await tasksRpc("updateTask", { taskId, labelIds, authorName: "You" }, taskResultSchema));
    }
    if (current.status === column) return current;
    return unwrap(await tasksRpc("boardMove", { taskId, status: column, authorName: "You" }, taskResultSchema));
  }

  // ----- RPC for the Factory page -----

  bb.rpc.register(rpcContract, {
    factories_list: async () => ({ factories: await Promise.all((await listFactories()).map(summarize)) }),
    projects_list: async () => ({
      projects: (await bb.sdk.projects.list()).map((project) => ({ id: project.id, name: project.name })),
    }),
    factory_create: async (input) => summarize(await createFactory(input)),
    factory_board: async ({ prefix }) => {
      const factory = await findFactory(prefix);
      const tasks = await listTasks(factory);
      return {
        factory: await summarize(factory),
        agents: factory.agents,
        tasks: tasks.filter((task) => task.status !== "canceled").map((task) => toBoardTask(factory, task)),
      };
    },
    lead_start: async ({ prefix, goal }) => ({ threadId: await startLead(await findFactory(prefix), goal) }),
    task_create: async ({ prefix, title }) => {
      const factory = await findFactory(prefix);
      const task = unwrap(
        await tasksRpc(
          "createTask",
          { projectId: factory.trackerProjectId, title, status: "backlog" },
          taskResultSchema,
        ),
      );
      bb.realtime.publish(BOARD_CHANGED, { prefix: factory.prefix });
      return toBoardTask(factory, task);
    },
    task_move: async ({ prefix, taskId, column }) => {
      const factory = await findFactory(prefix);
      const task = await moveTask(factory, taskId, column);
      bb.realtime.publish(BOARD_CHANGED, { prefix: factory.prefix });
      return toBoardTask(factory, task);
    },
    task_detail: async ({ taskId }) => {
      const task = await getTask(taskId);
      const { comments } = await tasksRpc(
        "listComments",
        { taskId },
        z.object({ comments: z.array(commentSchema) }),
      );
      return { description: task.description, comments: comments.slice(-30) };
    },
    task_assign: async (input) => ({ threadId: await assign(input) }),
  });

  // ----- Change feed: agents move tasks with `bb tasks`, outside this plugin -----

  const signatures = new Map<string, string>();
  bb.background.service("board-watch", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          for (const factory of await listFactories()) {
            const tasks = await listTasks(factory);
            const signature = tasks
              .map((task) => `${task.id}:${task.status}:${task.updatedAt}:${task.labelIds.join(",")}`)
              .join("|");
            const previous = signatures.get(factory.prefix);
            if (previous !== undefined && previous !== signature) {
              bb.realtime.publish(BOARD_CHANGED, { prefix: factory.prefix });
            }
            signatures.set(factory.prefix, signature);
          }
        } catch (error) {
          bb.log.warn(`board watch failed: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, POLL_MS);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  // ----- `bb factory` CLI -----

  const json = { type: "boolean", description: "Emit machine-readable JSON" } as const;
  const COLUMN_LABELS: Record<Column, string> = {
    backlog: "Backlog",
    todo: "To do",
    in_progress: "In progress",
    in_review: "In review",
    done: "Done",
    blocked: "Blocked",
  };

  bb.cli.register(
    defineCli({
      name: "factory",
      summary: "Run a software factory: a Lead agent, specialist agents, and a task board",
      commands: {
        list: cliCommand({
          summary: "List factories",
          options: { json },
          async run(input) {
            const factories = await Promise.all((await listFactories()).map(summarize));
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(factories) };
            if (factories.length === 0) {
              return { exitCode: 0, stdout: "No factories. Create one with `bb factory create`." };
            }
            const lines = factories.map(
              (f) => `${f.prefix}  ${f.name}  (project ${f.bbProjectName}, lead ${f.leadThreadId ?? "not started"})`,
            );
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        create: cliCommand({
          summary: "Create a factory for a bb project, with its own Tasks tracker",
          options: {
            project: {
              type: "string",
              description: "bb project id (proj_...); defaults to the current thread's project",
            },
            prefix: {
              type: "string",
              required: true,
              description: "Task key prefix, such as APP (1-10 letters or digits)",
            },
            name: { type: "string", description: "Factory name; defaults to the project name" },
            json,
          },
          async run(input, ctx) {
            const bbProjectId = input.options.project ?? ctx.projectId;
            if (bbProjectId === undefined) {
              throw new PluginCliError("Pass the bb project.", {
                code: "missing_project",
                hint: "Add --project <proj_...>; `bb project list` shows ids.",
              });
            }
            const prefix = prefixSchema.safeParse(input.options.prefix);
            if (!prefix.success) {
              throw new PluginCliError(prefix.error.issues[0]?.message ?? "Invalid prefix", {
                code: "invalid_prefix",
              });
            }
            const name = input.options.name ?? (await bb.sdk.projects.get({ projectId: bbProjectId })).name;
            const factory = await createFactory({ bbProjectId, prefix: prefix.data, name });
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(await summarize(factory)) };
            return {
              exitCode: 0,
              stdout: `Created factory ${factory.prefix} (${factory.name}). Start its Lead with \`bb factory start ${factory.prefix}\`.`,
            };
          },
        }),
        start: cliCommand({
          summary: "Start the factory's Lead agent",
          positionals: [{ name: "factory", description: "Factory prefix", required: true }],
          options: {
            goal: { type: "string", description: "What the factory should build first" },
            json,
          },
          async run(input) {
            const factory = await findFactory(input.positionals.factory);
            const threadId = await startLead(factory, input.options.goal ?? null);
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify({ threadId }) : `Started the Lead: ${threadId}`,
            };
          },
        }),
        assign: cliCommand({
          summary: "Assign a task to a specialist agent, spawned as the Lead's child thread",
          positionals: [{ name: "task", description: "Task key, such as APP-12", required: true }],
          options: {
            role: {
              type: "enum",
              values: WORKER_ROLE_IDS,
              required: true,
              description: "build, qa, design, review1 or review2",
            },
            instructions: { type: "string", description: "Extra context for the agent" },
            json,
          },
          async run(input) {
            const role = input.options.role as WorkerRoleId;
            const threadId = await assign({
              taskKey: input.positionals.task,
              role,
              instructions: input.options.instructions ?? null,
            });
            return {
              exitCode: 0,
              stdout: input.options.json
                ? JSON.stringify({ threadId })
                : `Assigned ${input.positionals.task.toUpperCase()} to ${ROLES[role].label}: ${threadId}`,
            };
          },
        }),
        block: cliCommand({
          summary: "Mark a task Blocked, with the reason",
          positionals: [{ name: "task", description: "Task key", required: true }],
          options: { reason: { type: "string", required: true, description: "What is needed to continue" } },
          async run(input) {
            const task = await setBlocked(input.positionals.task, true, input.options.reason);
            return { exitCode: 0, stdout: `${task.key} is Blocked.` };
          },
        }),
        unblock: cliCommand({
          summary: "Clear a task's Blocked mark",
          positionals: [{ name: "task", description: "Task key", required: true }],
          options: { note: { type: "string", description: "How it was resolved" } },
          async run(input) {
            const task = await setBlocked(input.positionals.task, false, input.options.note ?? null);
            return { exitCode: 0, stdout: `${task.key} is no longer Blocked.` };
          },
        }),
        status: cliCommand({
          summary: "Show a factory's board and agents",
          positionals: [{ name: "factory", description: "Factory prefix; defaults to the only factory" }],
          options: { json },
          async run(input) {
            let factory: Factory;
            if (input.positionals.factory !== undefined) {
              factory = await findFactory(input.positionals.factory);
            } else {
              const all = await listFactories();
              if (all.length !== 1 || all[0] === undefined) {
                throw new PluginCliError("Name the factory.", {
                  code: "factory_required",
                  hint: "Run `bb factory list`.",
                });
              }
              factory = all[0];
            }
            const tasks = (await listTasks(factory))
              .filter((task) => task.status !== "canceled")
              .map((task) => toBoardTask(factory, task));
            if (input.options.json) {
              const value = { factory: await summarize(factory), agents: factory.agents, tasks };
              return { exitCode: 0, stdout: JSON.stringify(value) };
            }
            const lines = [`Factory ${factory.prefix} · ${factory.name} · Lead ${factory.leadThreadId ?? "not started"}`];
            for (const column of COLUMNS) {
              const inColumn = tasks.filter((task) => task.column === column);
              lines.push("", `${COLUMN_LABELS[column]} (${inColumn.length})`);
              for (const task of inColumn) {
                const agents = factory.agents
                  .filter((agent) => agent.taskKey === task.key)
                  .map((agent) => `${ROLES[agent.role].label} ${agent.threadId}`);
                lines.push(`  ${task.key}  ${task.title}${agents.length > 0 ? `  [${agents.join(", ")}]` : ""}`);
              }
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
      },
    }),
  );
}
