import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Factory } from "./server";

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
  return { read, write, remove, readTrial, writeTrial, retireTrial, prefixes };
}
