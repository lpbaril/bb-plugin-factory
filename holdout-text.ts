// How holdout scenario counts read, shared by the server (status, the merge card, QA's comment, Health)
// and the Factory page, so the two never drift apart. Counts only: never a scenario's text.

export type HoldoutSummary = {
  /** writing: a writer is at work and none are saved; none: no writer at work and none saved. */
  state: "writing" | "none" | "ready";
  version: number;
  total: number;
  pass: number;
  fail: number;
  invalid: number;
  notRun: number;
  /** The commit the counts are about: the one asked for, or else the latest QA ran them at. */
  sha: string | null;
  /** Who saved the current version. page: the Factory page, which can't tell the person from an agent. */
  savedBy: "writer" | "person" | "page" | null;
};

/** QA's first run of each task's holdout scenarios. */
export type HoldoutHealth = { tasks: number; scenarios: number; passed: number; failed: number; invalid: number };

/** The counts in words, such as "4/5 pass at abc1234 (1 failed)". */
export function holdoutCounts(summary: HoldoutSummary): string {
  if (summary.state === "writing") return "being written";
  if (summary.state === "none") return "none written";
  if (summary.sha === null) return `${summary.total} written, not run yet`;
  const extra = [
    summary.fail > 0 ? `${summary.fail} failed` : null,
    summary.invalid > 0 ? `${summary.invalid} invalid` : null,
    summary.notRun > 0 ? `${summary.notRun} not run` : null,
  ].filter((part) => part !== null);
  return `${summary.pass}/${summary.total} pass at ${summary.sha.slice(0, 7)}${extra.length === 0 ? "" : ` (${extra.join(", ")})`}`;
}

/** One line for status, the merge card and QA's verdict comment. */
export function holdoutLine(summary: HoldoutSummary): string {
  return `Holdouts: ${holdoutCounts(summary)}`;
}

/** The share of scenarios that passed on QA's first run, as a whole percent; invalid ones count neither way. */
export function holdoutPassRate(health: HoldoutHealth): number | null {
  const judged = health.passed + health.failed;
  return judged === 0 ? null : Math.round((health.passed / judged) * 100);
}

/** Health's line for holdouts. */
export function holdoutHealthLine(health: HoldoutHealth): string {
  const rate = holdoutPassRate(health);
  const passed = rate === null ? "none passed or failed" : `${health.passed} of ${health.passed + health.failed} passed (${rate}%)`;
  return `Holdout scenarios on QA's first run: ${passed}, on ${health.tasks} task${health.tasks === 1 ? "" : "s"}${health.invalid === 0 ? "" : `; ${health.invalid} marked invalid`}`;
}
