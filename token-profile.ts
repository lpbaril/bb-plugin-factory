// Where a factory's tokens go, from the run ledger. Pure, so the server and the Health dialog share
// one definition of each number, label and percentage.
import { roleName } from "./roster";

export const TOKEN_OUTCOMES = ["merged", "closed", "open", "no-pr", "no-task"] as const;
export type TokenOutcome = (typeof TOKEN_OUTCOMES)[number];
export const TOKEN_OUTCOME_LABELS: Record<TokenOutcome, { label: string; note: string }> = {
  merged: { label: "Merged", note: "Tasks with a merged PR" },
  closed: { label: "Closed without merging", note: "Every PR closed, none merged" },
  open: { label: "PR still open", note: "Work in progress" },
  "no-pr": { label: "No PR", note: "Plans, explorations, or work that never reached a PR" },
  "no-task": { label: "Not tied to a task", note: "Mostly the Lead coordinating" },
};

/**
 * One turn as the profile reads it. `fresh` (new input and output) and `cached` (input read again
 * from the provider's cache) are computed once, in the ledger's query, and are null when the turn
 * has no token counts.
 */
export type TokenTurn = {
  threadId: string;
  role: string;
  taskKey: string | null;
  outcome: "completed" | "failed" | "interrupted";
  startedAt: number;
  fresh: number | null;
  cached: number | null;
};
type TokenSplit = { turns: number; fresh: number; cached: number };
export type TokenProfile = {
  turns: number;
  unmeasured: number;
  fresh: number;
  cached: number;
  byRole: (TokenSplit & { role: string; label: string; failed: number; interrupted: number; cachedPerTurn: number | null })[];
  byOutcome: (TokenSplit & { outcome: TokenOutcome; tasks: number })[];
  failedTurns: TokenSplit;
  leadGrowth: { threads: number; turns: number; firstQuarter: number; lastQuarter: number } | null;
};

/** A Lead thread needs this many measured turns before its first and last quarter mean anything. */
export const LEAD_GROWTH_MIN_TURNS = 8;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

/** A part of a whole as a whole percentage, or a dash when there's no whole. */
export function sharePercent(part: number, whole: number): string {
  return whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`;
}

/** A share bar's width: none for nothing, and at least a sliver for anything, so a small share still shows. */
export function shareBarWidth(part: number, whole: number): string {
  return part <= 0 || whole <= 0 ? "0%" : `${Math.max(1, Math.min(100, (part / whole) * 100))}%`;
}

const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** Token counts written short: 1.6M, 733.1K. */
export function compactTokens(value: number): string {
  return COMPACT.format(Math.round(value));
}

/**
 * Where tokens go: by role, by what became of the task, in failed turns, and whether a Lead's
 * cached tokens per turn grow. Cached tokens per turn grow with both the context and the number of
 * steps in a turn, so they're a sign of context growth, not a measure of it. Providers count
 * cached input differently, so compare roles on one provider.
 */
export function computeTokenProfile(turns: readonly TokenTurn[], prs: readonly { taskKey: string; state: "open" | "merged" | "closed" }[]): TokenProfile {
  const split = (rows: readonly TokenTurn[]): TokenSplit => ({
    turns: rows.length,
    fresh: rows.reduce((sum, turn) => sum + (turn.fresh ?? 0), 0),
    cached: rows.reduce((sum, turn) => sum + (turn.cached ?? 0), 0),
  });
  const measuredCached = (rows: readonly TokenTurn[]) => rows.flatMap((turn) => (turn.cached === null ? [] : [turn.cached]));
  const roles = [...new Set(turns.map((turn) => turn.role))];
  const byRole = roles.map((role) => {
    const rows = turns.filter((turn) => turn.role === role);
    return {
      role,
      label: roleName(role),
      ...split(rows),
      failed: rows.filter((turn) => turn.outcome === "failed").length,
      interrupted: rows.filter((turn) => turn.outcome === "interrupted").length,
      cachedPerTurn: median(measuredCached(rows)),
    };
  }).sort((a, b) => b.fresh + b.cached - (a.fresh + a.cached));

  const states = new Map<string, Set<string>>();
  for (const pr of prs) {
    let seen = states.get(pr.taskKey);
    if (seen === undefined) states.set(pr.taskKey, (seen = new Set()));
    seen.add(pr.state);
  }
  const outcomeOf = (taskKey: string | null): TokenOutcome => {
    if (taskKey === null) return "no-task";
    const seen = states.get(taskKey);
    if (seen === undefined) return "no-pr";
    return seen.has("merged") ? "merged" : seen.has("open") ? "open" : "closed";
  };
  const byOutcome = TOKEN_OUTCOMES.map((outcome) => {
    const rows = turns.filter((turn) => outcomeOf(turn.taskKey) === outcome);
    return { outcome, tasks: new Set(rows.flatMap((turn) => (turn.taskKey === null ? [] : [turn.taskKey]))).size, ...split(rows) };
  }).filter((entry) => entry.turns > 0);

  // Each Lead thread on its own: a replaced Lead starts with a fresh context, so pooling threads in
  // time order would put one thread's start next to another's end.
  const leadThreads = new Map<string, TokenTurn[]>();
  for (const turn of turns) {
    if (turn.role !== "lead" || turn.cached === null) continue;
    let rows = leadThreads.get(turn.threadId);
    if (rows === undefined) leadThreads.set(turn.threadId, (rows = []));
    rows.push(turn);
  }
  const first: number[] = [];
  const last: number[] = [];
  let leadTurns = 0;
  let threads = 0;
  for (const rows of leadThreads.values()) {
    if (rows.length < LEAD_GROWTH_MIN_TURNS) continue;
    rows.sort((a, b) => a.startedAt - b.startedAt);
    const quarter = Math.floor(rows.length / 4);
    first.push(...measuredCached(rows.slice(0, quarter)));
    last.push(...measuredCached(rows.slice(-quarter)));
    leadTurns += rows.length;
    threads += 1;
  }

  const total = split(turns);
  return {
    turns: turns.length,
    unmeasured: turns.filter((turn) => turn.cached === null).length,
    fresh: total.fresh,
    cached: total.cached,
    byRole,
    byOutcome,
    failedTurns: split(turns.filter((turn) => turn.outcome !== "completed")),
    leadGrowth: threads === 0 ? null : { threads, turns: leadTurns, firstQuarter: median(first)!, lastQuarter: median(last)! },
  };
}
