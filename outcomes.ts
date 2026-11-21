// Outcome signals: what became of a factory PR after it merged. A revert, CI failing on the base
// branch at its merge commit, or a problem the person records. They're counted against the PR's
// merge-risk rating, so the rating can be checked before it ever decides anything.

export const OUTCOME_KINDS = ["revert", "ci-failure", "bug", "incident"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];
/** Kinds only the person records, with `bb factory outcome`. */
export const MANUAL_OUTCOME_KINDS = ["bug", "incident", "revert"] as const;
/** How long after a merge a signal counts against the PR. */
export const OUTCOME_WINDOW_DAYS = 14;
export const OUTCOME_WINDOW_MS = OUTCOME_WINDOW_DAYS * 24 * 60 * 60 * 1000;
/** With no CI run at the merge commit after this long, the repo runs none there, and the check ends. */
export const CI_NO_RUNS_MS = 2 * 60 * 60 * 1000;
/** A failure is watched this long for a rerun that passes, then it stands. */
export const CI_RERUN_WATCH_MS = 24 * 60 * 60 * 1000;
export const OUTCOME_NOTE_MAX = 300;

/** A merged PR GitHub lists, as `gh pr list --json number,title,body,mergedAt,url` gives it. */
export type MergedPr = { number: number; title: string; body: string; mergedAt: string | null; url: string };

/**
 * The PR numbers a revert PR undoes. GitHub's Revert button writes "Reverts owner/name#123" in the
 * body; only this repo's references count. When the body says nothing, a title like
 * `Revert "APP-12: Fix the thing"` is passed to matchTitle, which names the PRs it could mean.
 */
export function revertedPrNumbers(revert: Pick<MergedPr, "title" | "body">, repo: string, matchTitle: (quoted: string) => number[]): number[] {
  if (!/^revert\b/i.test(revert.title.trim())) return [];
  const found = new Set<number>();
  const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const reference = new RegExp(`\\bReverts\\s+${escaped}#(\\d+)\\b`, "gi");
  for (const match of revert.body.matchAll(reference)) found.add(Number(match[1]));
  if (found.size === 0) {
    const quoted = /^revert\s+"(.+)"\s*$/i.exec(revert.title.trim())?.[1];
    if (quoted !== undefined) for (const number of matchTitle(quoted)) found.add(number);
  }
  return [...found];
}

/** A workflow run, as `gh run list --json name,workflowName,status,conclusion,createdAt,databaseId` gives it. */
export type CiRun = { name?: string | null; workflowName?: string | null; status?: string | null; conclusion?: string | null; createdAt?: string | null; databaseId?: number | null };
const FAILED = ["failure", "timed_out", "startup_failure", "action_required"];

/**
 * What CI says about a merge commit: still running, no runs at all, green, or the workflows whose
 * latest run failed. Only the latest run of each workflow counts, so a rerun that passes clears a
 * failure, as on GitHub. A cancelled or skipped run isn't a failure.
 */
export function ciVerdict(runs: readonly CiRun[]): { state: "running" | "none" | "passed" } | { state: "failed"; workflows: string[] } {
  if (runs.length === 0) return { state: "none" };
  const latest = new Map<string, CiRun>();
  for (const run of runs) {
    const key = `${run.workflowName ?? ""}\u0000${run.name ?? ""}`;
    const previous = latest.get(key);
    const at = (entry: CiRun) => Date.parse(entry.createdAt ?? "") || 0;
    if (previous === undefined || at(run) > at(previous) || (at(run) === at(previous) && (run.databaseId ?? 0) > (previous.databaseId ?? 0))) latest.set(key, run);
  }
  const current = [...latest.values()];
  if (current.some((run) => (run.status ?? "").toLowerCase() !== "completed")) return { state: "running" };
  const failed = current.filter((run) => FAILED.includes((run.conclusion ?? "").toLowerCase()));
  if (failed.length === 0) return { state: "passed" };
  return { state: "failed", workflows: [...new Set(failed.map((run) => (run.workflowName ?? run.name ?? "unnamed").slice(0, 100)))] };
}

/** A note from the person: one line, capped. */
export function cleanOutcomeNote(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > OUTCOME_NOTE_MAX ? `${line.slice(0, OUTCOME_NOTE_MAX - 1)}…` : line;
}

export type OutcomeSignal = { kind: OutcomeKind; at: string; clearedAt: string | null };
export type OutcomePr = {
  state: string;
  mergedAt: string | null;
  riskLevel: "low" | "medium" | "high" | null;
  signals: readonly OutcomeSignal[];
};
export type OutcomeBucket = { merged: number; withOutcome: number };
export type OutcomeHealth = {
  /** PRs merged in the window, by their merge-risk level, and how many had a signal within 14 days. */
  byRisk: Record<"low" | "medium" | "high" | "unrated", OutcomeBucket>;
  /** Signals counted, by kind. */
  kinds: Record<OutcomeKind, number>;
  /** Merged PRs whose 14 days aren't over yet, so their count may still grow. */
  watching: number;
};

/**
 * The calibration: of the PRs rated low, medium or high, how many had a revert, a CI failure on
 * their merge commit or a recorded problem within 14 days of merging. A CI failure a passing rerun
 * cleared doesn't count. PRs are counted by when they merged, in [from, until).
 */
export function computeOutcomeHealth(prs: readonly OutcomePr[], from: number | null, until: number | null, now = Date.now()): OutcomeHealth {
  const bucket = (): OutcomeBucket => ({ merged: 0, withOutcome: 0 });
  const health: OutcomeHealth = {
    byRisk: { low: bucket(), medium: bucket(), high: bucket(), unrated: bucket() },
    kinds: { revert: 0, "ci-failure": 0, bug: 0, incident: 0 },
    watching: 0,
  };
  for (const pr of prs) {
    if (pr.state !== "merged" || pr.mergedAt === null) continue;
    const merged = Date.parse(pr.mergedAt);
    if (!Number.isFinite(merged) || (from !== null && !(merged >= from)) || (until !== null && !(merged < until))) continue;
    const counted = pr.signals.filter((signal) => signal.clearedAt === null && Date.parse(signal.at) - merged <= OUTCOME_WINDOW_MS);
    const entry = health.byRisk[pr.riskLevel ?? "unrated"];
    entry.merged += 1;
    if (counted.length > 0) entry.withOutcome += 1;
    for (const signal of counted) health.kinds[signal.kind] += 1;
    if (now - merged < OUTCOME_WINDOW_MS) health.watching += 1;
  }
  return health;
}

/** Health's line for outcomes. */
export function outcomeHealthLine(health: OutcomeHealth): string {
  const levels = (["low", "medium", "high", "unrated"] as const).filter((level) => health.byRisk[level].merged > 0);
  if (levels.length === 0) return "Outcomes after merge: no merged PRs";
  const parts = levels.map((level) => `${level} ${health.byRisk[level].withOutcome} of ${health.byRisk[level].merged}`);
  const kinds = (Object.entries(health.kinds) as [OutcomeKind, number][]).filter(([, count]) => count > 0).map(([kind, count]) => `${count} ${kind === "ci-failure" ? "CI failure" : kind}${count === 1 ? "" : "s"}`);
  return `Outcomes within ${OUTCOME_WINDOW_DAYS} days of merge, by merge risk: ${parts.join(", ")}${kinds.length === 0 ? "" : ` (${kinds.join(", ")})`}${health.watching === 0 ? "" : `; ${health.watching} still inside their ${OUTCOME_WINDOW_DAYS} days`}`;
}
