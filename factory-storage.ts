import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Factory } from "./server";

/** One finished agent turn. Tokens are the thread's growth since the previous row, so they sum correctly. */
export type RunRow = {
  threadId: string;
  endSeq: number;
  prefix: string;
  taskKey: string | null;
  role: string;
  providerId: string;
  model: string | null;
  reasoning: string | null;
  outcome: "completed" | "failed" | "interrupted";
  error: string | null;
  startedAt: number;
  endedAt: number;
  tokensTotal: number | null;
  tokensCached: number | null;
  tokensOutput: number | null;
};
/** How far a thread has been read, and its cumulative tokens at that point. */
export type RunCursor = { lastSeq: number; tokensTotal: number; tokensCached: number; tokensOutput: number };
export type RunGroup = {
  role: string;
  providerId: string;
  model: string | null;
  runs: number;
  failed: number;
  interrupted: number;
  durationMs: number;
  tokensTotal: number;
  tokensCached: number;
  tokensOutput: number;
};
export type Lesson = { id: number; rule: string; createdAt: string; notifiedAt: string | null; tasks: string[] };

/** KV is only a fixed-size locator. Histories grow as rows, never as KV values
 * (or as a task-sized JSON blob). Array positions preserve the original order. */
export function createFactoryStorage(storage: BbPluginApi["storage"], parse: (value: unknown) => Factory) {
  const db = storage.database();
  storage.migrate(db, [
    `CREATE TABLE factory_metadata (prefix TEXT PRIMARY KEY, payload TEXT NOT NULL);
     CREATE TABLE factory_records (
       prefix TEXT NOT NULL, kind TEXT NOT NULL, position INTEGER NOT NULL,
       parent INTEGER NOT NULL DEFAULT -1, task_key TEXT, payload TEXT NOT NULL,
       PRIMARY KEY (prefix, kind, parent, position));
     CREATE INDEX factory_records_task ON factory_records(prefix, task_key);
     CREATE TABLE factory_legacy_backups (prefix TEXT PRIMARY KEY, payload TEXT NOT NULL, migrated_at TEXT NOT NULL);`,
    `CREATE TABLE factory_trials (id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
     CREATE TABLE factory_trial_runs (trial_id INTEGER NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL,
       PRIMARY KEY (trial_id, position));`,
    `CREATE TABLE factory_runs (
       thread_id TEXT NOT NULL, end_seq INTEGER NOT NULL, prefix TEXT NOT NULL, task_key TEXT, role TEXT NOT NULL,
       provider_id TEXT NOT NULL, model TEXT, reasoning TEXT, outcome TEXT NOT NULL, error TEXT,
       started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL,
       tokens_total INTEGER, tokens_cached INTEGER, tokens_output INTEGER,
       PRIMARY KEY (thread_id, end_seq));
     CREATE INDEX factory_runs_prefix ON factory_runs(prefix, ended_at);
     CREATE TABLE factory_run_cursors (
       thread_id TEXT PRIMARY KEY, last_seq INTEGER NOT NULL,
       tokens_total INTEGER NOT NULL, tokens_cached INTEGER NOT NULL, tokens_output INTEGER NOT NULL);
     CREATE TABLE factory_lessons (
       id INTEGER PRIMARY KEY AUTOINCREMENT, prefix TEXT NOT NULL, rule TEXT NOT NULL,
       created_at TEXT NOT NULL, notified_at TEXT);
     CREATE INDEX factory_lessons_prefix ON factory_lessons(prefix);
     CREATE TABLE factory_lesson_hits (
       lesson_id INTEGER NOT NULL REFERENCES factory_lessons(id) ON DELETE CASCADE, task_key TEXT NOT NULL,
       thread_id TEXT NOT NULL, created_at TEXT NOT NULL,
       PRIMARY KEY (lesson_id, task_key));`,
  ]);
  const metadata = db.prepare("SELECT payload FROM factory_metadata WHERE prefix = ?");
  const records = db.prepare("SELECT kind, position, parent, payload FROM factory_records WHERE prefix = ? ORDER BY parent, position");
  const putMetadata = db.prepare("INSERT INTO factory_metadata VALUES (?, ?) ON CONFLICT(prefix) DO UPDATE SET payload=excluded.payload");
  const putRecord = db.prepare("INSERT INTO factory_records VALUES (?, ?, ?, ?, ?, ?)");
  const clearRecords = db.prepare("DELETE FROM factory_records WHERE prefix = ?");
  const backup = db.prepare("INSERT OR IGNORE INTO factory_legacy_backups VALUES (?, ?, ?)");
  const pointer = (prefix: string) => ({ storageVersion: 2, prefix });
  const isPointer = (value: unknown, prefix: string) =>
    typeof value === "object" && value !== null && "storageVersion" in value && value.storageVersion === 2 &&
    "prefix" in value && value.prefix === prefix;

  const writeRows = db.transaction((factory: Factory, legacy?: unknown) => {
    if (legacy !== undefined) backup.run(factory.prefix, JSON.stringify(legacy), new Date().toISOString());
    const { agents, prs, plans, ...rest } = factory;
    putMetadata.run(factory.prefix, JSON.stringify(rest));
    clearRecords.run(factory.prefix);
    const add = (kind: string, position: number, taskKey: string | null, value: unknown, parent = -1) =>
      putRecord.run(factory.prefix, kind, position, parent, taskKey, JSON.stringify(value));
    agents.forEach((agent, i) => add("agent", i, agent.taskKey, agent));
    plans.forEach((plan, i) => add("plan", i, plan.taskKey, plan));
    prs.forEach(({ reviews, scans, ...pr }, i) => {
      add("pr", i, pr.taskKey, pr);
      reviews.forEach((review, j) => add("review", j, pr.taskKey, review, i));
      scans.forEach((scan, j) => add("scan", j, pr.taskKey, scan, i));
    });
  });

  function readRows(prefix: string): Factory | undefined {
    const meta = metadata.get(prefix) as { payload: string } | undefined;
    if (meta === undefined) return undefined;
    const factory = { ...JSON.parse(meta.payload), agents: [], prs: [], plans: [] } as Factory;
    for (const row of records.all(prefix) as { kind: string; position: number; parent: number; payload: string }[]) {
      const value = JSON.parse(row.payload);
      switch (row.kind) {
        case "agent": factory.agents[row.position] = value; break;
        case "plan": factory.plans[row.position] = value; break;
        case "pr": factory.prs[row.position] = { ...value, reviews: [], scans: [] }; break;
        case "review": factory.prs[row.parent].reviews[row.position] = value; break;
        case "scan": factory.prs[row.parent].scans[row.position] = value; break;
        default: throw new Error(`Unknown factory record kind: ${row.kind}`);
      }
    }
    return parse(factory);
  }

  // KV and the plugin DB cannot share a transaction. Commit all rows + backup
  // first; a crash/failed KV write is recoverable because DB is authoritative.
  async function read(prefix: string): Promise<Factory | undefined> {
    const legacy = await storage.kv.get("factory:" + prefix);
    const stored = readRows(prefix);
    if (stored !== undefined) {
      if (!isPointer(legacy, prefix)) await storage.kv.set("factory:" + prefix, pointer(prefix));
      return stored;
    }
    if (legacy === undefined) return undefined;
    if (isPointer(legacy, prefix)) throw new Error(`Factory ${prefix} database is missing; restore its backup before continuing.`);
    const factory = parse(legacy);
    writeRows(factory, legacy);
    await storage.kv.set("factory:" + prefix, pointer(prefix));
    return readRows(prefix);
  }
  async function write(factory: Factory): Promise<void> {
    // Existing locators never need another KV write, so growing histories
    // cannot fail at the KV limit.
    const key = "factory:" + factory.prefix;
    const current = await storage.kv.get(key);
    if (current !== undefined && !isPointer(current, factory.prefix)) await read(factory.prefix);
    writeRows(factory);
    if (current === undefined) await storage.kv.set(key, pointer(factory.prefix));
  }
  async function remove(prefix: string): Promise<void> {
    await storage.kv.delete("factory:" + prefix);
    db.transaction(() => {
      clearRecords.run(prefix);
      db.prepare("DELETE FROM factory_metadata WHERE prefix = ?").run(prefix);
      db.prepare("DELETE FROM factory_run_cursors WHERE thread_id IN (SELECT thread_id FROM factory_runs WHERE prefix = ?)").run(prefix);
      db.prepare("DELETE FROM factory_runs WHERE prefix = ?").run(prefix);
      db.prepare("DELETE FROM factory_lesson_hits WHERE lesson_id IN (SELECT id FROM factory_lessons WHERE prefix = ?)").run(prefix);
      db.prepare("DELETE FROM factory_lessons WHERE prefix = ?").run(prefix);
    })();
    // Immutable pre-migration backups are deliberately retained.
  }
  // The optional shadow trial had two more unbounded KV arrays. Keep each run
  // as a row, including retired model comparisons; never discard their history.
  type Trial = { runs: unknown[]; comparisonThreadId: string | null; comparedRuns?: number };
  const putTrial = db.transaction((id: number, trial: Trial) => {
    const { runs, ...rest } = trial;
    db.prepare("INSERT INTO factory_trials VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload").run(id, JSON.stringify(rest));
    db.prepare("DELETE FROM factory_trial_runs WHERE trial_id=?").run(id);
    const insert = db.prepare("INSERT INTO factory_trial_runs VALUES (?, ?, ?)");
    runs.forEach((run, i) => insert.run(id, i, JSON.stringify(run)));
  });
  let trialMigration: Promise<void> | undefined;
  function ensureTrials(): Promise<void> {
    return trialMigration ??= (async () => {
      if (!db.prepare("SELECT 1 FROM factory_trials WHERE id=0").get()) {
        const current = await storage.kv.get<Trial>("shadow-trial");
        const history = await storage.kv.get<Trial[]>("shadow-trial-history");
        db.transaction(() => {
          if (current !== undefined) backup.run("shadow-trial", JSON.stringify(current), new Date().toISOString());
          if (history !== undefined) backup.run("shadow-trial-history", JSON.stringify(history), new Date().toISOString());
          putTrial(0, current ?? { runs: [], comparisonThreadId: null });
          (history ?? []).forEach((trial, i) => putTrial(i + 1, trial));
        })();
      }
      for (const key of ["shadow-trial", "shadow-trial-history"]) {
        const value = await storage.kv.get(key);
        if (!isPointer(value, key)) await storage.kv.set(key, pointer(key));
      }
    })().catch(error => { trialMigration = undefined; throw error; });
  }
  async function readTrial(): Promise<unknown> {
    await ensureTrials();
    const row = db.prepare("SELECT payload FROM factory_trials WHERE id=0").get() as { payload: string };
    const runs = db.prepare("SELECT payload FROM factory_trial_runs WHERE trial_id=0 ORDER BY position").all() as { payload: string }[];
    return { ...JSON.parse(row.payload), runs: runs.map(run => JSON.parse(run.payload)) };
  }
  async function writeTrial(trial: Trial, retired: Trial | null = null): Promise<void> {
    await ensureTrials();
    db.transaction(() => {
      if (retired !== null) {
        const { id } = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM factory_trials").get() as { id: number };
        putTrial(id, retired);
      }
      putTrial(0, trial);
    })();
  }
  async function retireTrial(trial: Trial): Promise<void> {
    await ensureTrials();
    db.transaction(() => {
      const { id } = db.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM factory_trials").get() as { id: number };
      putTrial(id, trial);
    })();
  }
  function prefixes(): string[] {
    return (db.prepare("SELECT prefix FROM factory_metadata").all() as { prefix: string }[]).map(row => row.prefix);
  }

  // ----- Run ledger: append-only, and separate from the factory rows that writeRows rewrites. -----
  function runCursor(threadId: string): RunCursor {
    const row = db.prepare("SELECT last_seq, tokens_total, tokens_cached, tokens_output FROM factory_run_cursors WHERE thread_id = ?").get(threadId) as
      | { last_seq: number; tokens_total: number; tokens_cached: number; tokens_output: number }
      | undefined;
    return row === undefined
      ? { lastSeq: 0, tokensTotal: 0, tokensCached: 0, tokensOutput: 0 }
      : { lastSeq: row.last_seq, tokensTotal: row.tokens_total, tokensCached: row.tokens_cached, tokensOutput: row.tokens_output };
  }
  /** Rows and the cursor commit together, so a crash can neither lose nor double-count a turn. */
  const appendRuns = db.transaction((threadId: string, rows: RunRow[], cursor: RunCursor) => {
    const insert = db.prepare("INSERT OR IGNORE INTO factory_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const r of rows) {
      insert.run(r.threadId, r.endSeq, r.prefix, r.taskKey, r.role, r.providerId, r.model, r.reasoning, r.outcome, r.error, r.startedAt, r.endedAt, r.tokensTotal, r.tokensCached, r.tokensOutput);
    }
    db.prepare(
      `INSERT INTO factory_run_cursors VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET last_seq=excluded.last_seq, tokens_total=excluded.tokens_total,
         tokens_cached=excluded.tokens_cached, tokens_output=excluded.tokens_output`,
    ).run(threadId, cursor.lastSeq, cursor.tokensTotal, cursor.tokensCached, cursor.tokensOutput);
  });
  function runGroups(prefix: string, taskKey: string | null): RunGroup[] {
    return db.prepare(
      `SELECT role, provider_id AS providerId, model, COUNT(*) AS runs,
         SUM(outcome = 'failed') AS failed, SUM(outcome = 'interrupted') AS interrupted,
         SUM(ended_at - started_at) AS durationMs,
         COALESCE(SUM(tokens_total), 0) AS tokensTotal, COALESCE(SUM(tokens_cached), 0) AS tokensCached, COALESCE(SUM(tokens_output), 0) AS tokensOutput
       FROM factory_runs WHERE prefix = @prefix AND (@taskKey IS NULL OR task_key = @taskKey)
       GROUP BY role, provider_id, model ORDER BY tokensTotal DESC`,
    ).all({ prefix, taskKey }) as RunGroup[];
  }
  function recentRuns(prefix: string, taskKey: string | null, limit: number): RunRow[] {
    return db.prepare(
      `SELECT thread_id AS threadId, end_seq AS endSeq, prefix, task_key AS taskKey, role, provider_id AS providerId, model, reasoning, outcome, error,
         started_at AS startedAt, ended_at AS endedAt, tokens_total AS tokensTotal, tokens_cached AS tokensCached, tokens_output AS tokensOutput
       FROM factory_runs WHERE prefix = @prefix AND (@taskKey IS NULL OR task_key = @taskKey)
       ORDER BY ended_at DESC, end_seq DESC LIMIT @limit`,
    ).all({ prefix, taskKey, limit }) as RunRow[];
  }
  /** The model each review thread last ran on, to join verdicts to models. */
  function threadModels(prefix: string): Map<string, string | null> {
    const rows = db.prepare("SELECT thread_id AS threadId, model FROM factory_runs WHERE prefix = ? ORDER BY ended_at, end_seq").all(prefix) as { threadId: string; model: string | null }[];
    return new Map(rows.map((row) => [row.threadId, row.model]));
  }

  // ----- Recurring review findings -----
  function lessons(prefix: string): Lesson[] {
    const rows = db.prepare("SELECT id, rule, created_at AS createdAt, notified_at AS notifiedAt FROM factory_lessons WHERE prefix = ? ORDER BY id").all(prefix) as Omit<Lesson, "tasks">[];
    const hits = db.prepare("SELECT task_key AS taskKey FROM factory_lesson_hits WHERE lesson_id = ? ORDER BY created_at, task_key");
    return rows.map((row) => ({ ...row, tasks: (hits.all(row.id) as { taskKey: string }[]).map((hit) => hit.taskKey) }));
  }
  /** Adds a task to a lesson (new when `lesson` has a rule). A task counts once, however many reviewers flag it. */
  const recordLesson = db.transaction((prefix: string, lesson: { rule: string } | { id: number }, taskKey: string, threadId: string): Lesson | null => {
    const now = new Date().toISOString();
    const id = "rule" in lesson
      ? Number(db.prepare("INSERT INTO factory_lessons (prefix, rule, created_at) VALUES (?, ?, ?)").run(prefix, lesson.rule, now).lastInsertRowid)
      : lesson.id;
    if (!db.prepare("SELECT 1 FROM factory_lessons WHERE id = ? AND prefix = ?").get(id, prefix)) return null;
    db.prepare("INSERT OR IGNORE INTO factory_lesson_hits VALUES (?, ?, ?, ?)").run(id, taskKey, threadId, now);
    return lessons(prefix).find((entry) => entry.id === id) ?? null;
  });
  function markLessonNotified(id: number): void {
    db.prepare("UPDATE factory_lessons SET notified_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  return {
    read, write, remove, readTrial, writeTrial, retireTrial, prefixes,
    runCursor, appendRuns, runGroups, recentRuns, threadModels,
    lessons, recordLesson, markLessonNotified,
  };
}
