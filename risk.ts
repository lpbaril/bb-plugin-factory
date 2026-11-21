// Merge risk: a summary for the person who merges, adapted from Warp's merge-risk skill
// (warp.dev/learn, "Add verification and merge risk"). The factory works out what it can from the
// diff and the evidence it holds. When a fact is flagged, a Risk reviewer judges the rest. It's
// informational: it doesn't change who may merge.

export const RISK_LEVELS = ["low", "medium", "high"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const RISK_CATEGORIES = ["impact", "rollback", "verification", "errors"] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];
export const RISK_CATEGORY_LABELS: Record<RiskCategory, string> = {
  impact: "Impact",
  rollback: "Rollback",
  verification: "Verification",
  errors: "Error detection",
};
/** Warp's weights: what a change touches and how well it was checked count most. */
const RISK_WEIGHTS: Record<RiskCategory, number> = { impact: 2, verification: 2, rollback: 1.5, errors: 1 };
const LEVEL_SCORE: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3 };
/** How long the merge card waits for a Risk reviewer before it shows the facts alone. */
export const RISK_REVIEW_WAIT_MS = 15 * 60 * 1000;
/** The longest reason kept from a Risk reviewer: it's shown on a phone and posted on GitHub. */
export const RISK_REASON_MAX = 200;

/**
 * Words that make a path security-sensitive: auth, secrets, permissions, payments. They're matched as
 * whole words of the path, so `urls.py`, `author.ts` and `tokenizer.ts` aren't. Migrations and config
 * are counted on their own.
 */
const SECURITY_WORDS = new Set([
  "auth", "authn", "authz", "authenticate", "authentication", "authorize", "authorization", "oauth", "oidc", "sso", "saml",
  "login", "logout", "signin", "session", "sessions", "secret", "secrets", "credential", "credentials", "password", "passwords",
  "passwd", "crypto", "encrypt", "encryption", "decrypt", "permission", "permissions", "rbac", "acl", "rls", "jwt",
  "payment", "payments", "billing", "stripe", "apikey",
]);
/** Two-word names that are sensitive although each word alone isn't, like `accessToken` or `api_key`. */
const SECURITY_PAIRS = new Set(["access token", "refresh token", "auth token", "id token", "api key", "api token", "private key", "sign in"]);

/** A path's words: split on punctuation and camelCase, lower case. */
function pathWords(path: string): string[] {
  return path.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((word) => word !== "");
}
export function isSecurityPath(path: string): boolean {
  const words = pathWords(path);
  return words.some((word, index) => SECURITY_WORDS.has(word) || (index > 0 && SECURITY_PAIRS.has(`${words[index - 1]} ${word}`)));
}
/**
 * Paths whose changes are hard to undo once merged: a schema or data migration. SQL counts only in a
 * migration folder or as a schema dump, not as a seed, a query or a test fixture.
 */
const MIGRATION_PATH = /(^|\/)(migrations?|alembic|migrate|db\/schema)(\/|$)|(^|\/)(schema|structure)\.(sql|prisma|rb)$|(^|\/)drizzle\//i;
/** Dependency manifests and lock files. */
const DEPENDENCY_PATH = /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Pipfile(\.lock)?|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?|composer\.(json|lock)|Podfile(\.lock)?|build\.gradle(\.kts)?|pom\.xml)$/i;
/** CI, build, deploy and infrastructure configuration. */
const CONFIG_PATH = /(^|\/)(\.github\/workflows\/|\.circleci\/|\.gitlab-ci\.yml$|Dockerfile[^/]*$|docker-compose[^/]*$|compose\.ya?ml$|terraform\/|k8s\/|helm\/|[^/]*\.tf$|vercel\.json$|netlify\.toml$|wrangler\.toml$|fly\.toml$|Procfile$|nginx[^/]*\.conf$|\.env\.example$)/i;
/** Test files, so a change that adds code without tests shows. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e)\/|\.(test|spec)\.[a-z0-9]+$|_test\.(go|py|rb)$|(^|\/)test_[^/]+\.py$/i;
/** Files that aren't code: a change made only of these needs no tests. */
const NON_CODE_PATH = /\.(md|mdx|txt|rst|png|jpe?g|gif|svg|webp|ico)$|(^|\/)(docs?|\.specify)\//i;

export type RiskFile = { path: string; additions: number; deletions: number };
/** What the factory knows about a PR's head commit when it looks at its risk. */
export type RiskEvidence = {
  /** Large or sensitive, as decided for Reviewer 2. */
  deep: boolean;
  qa: "pass" | "carried" | "skipped" | "fail" | "none";
  /** Whether the factory runs QA as a gate for this PR. */
  qaGate: boolean;
};
export type RiskFacts = {
  files: number;
  lines: number;
  sensitive: number;
  migrations: number;
  dependencies: number;
  config: number;
  tests: number;
  code: number;
  deep: boolean;
  qa: RiskEvidence["qa"];
  qaGate: boolean;
};

export function riskFacts(files: readonly RiskFile[], evidence: RiskEvidence): RiskFacts {
  const count = (pattern: RegExp) => files.filter((file) => pattern.test(file.path)).length;
  const tests = count(TEST_PATH);
  return {
    files: files.length,
    lines: files.reduce((total, file) => total + file.additions + file.deletions, 0),
    // A test of auth code isn't itself sensitive.
    sensitive: files.filter((file) => isSecurityPath(file.path) && !TEST_PATH.test(file.path)).length,
    migrations: count(MIGRATION_PATH),
    dependencies: count(DEPENDENCY_PATH),
    config: count(CONFIG_PATH),
    tests,
    code: files.filter((file) => !TEST_PATH.test(file.path) && !NON_CODE_PATH.test(file.path)).length,
    deep: evidence.deep,
    qa: evidence.qa,
    qaGate: evidence.qaGate,
  };
}

/** What makes a PR worth a Risk reviewer's judgment. None: the facts are enough. */
export function riskFlags(facts: RiskFacts): string[] {
  const flags: string[] = [];
  if (facts.sensitive > 0) flags.push(`${plural(facts.sensitive, "sensitive path")}`);
  if (facts.migrations > 0) flags.push(`${plural(facts.migrations, "migration or schema file")}`);
  if (facts.dependencies > 0) flags.push(`${plural(facts.dependencies, "dependency file")}`);
  if (facts.config > 0) flags.push(`${plural(facts.config, "CI, build or infrastructure file")}`);
  if (facts.deep && facts.sensitive === 0) flags.push("a large diff");
  return flags;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export type RiskRating = { level: RiskLevel; reason: string };
/** A Risk reviewer's three judgments. Verification always comes from the factory's evidence. */
export type RiskReview = Record<"impact" | "rollback" | "errors", RiskRating>;
export type RiskLine = { category: RiskCategory; label: string; level: RiskLevel | null; reason: string };
export type RiskSummary = {
  overall: RiskLevel;
  lines: RiskLine[];
  /** review: a Risk reviewer judged it. facts: nothing was flagged. unfinished: flagged, but no rating came back: it ran out of time, ended without one, or couldn't start. */
  source: "review" | "facts" | "unfinished";
};

/** Verification from evidence, never opinion: QA at this commit, and whether code came with tests. */
export function verificationRating(facts: RiskFacts): RiskRating {
  const testsNote = facts.code === 0 ? "no code changed" : facts.tests > 0 ? `tests changed in ${plural(facts.tests, "file")}` : "no test files changed";
  const testsOk = facts.code === 0 || facts.tests > 0;
  switch (facts.qa) {
    case "pass":
      return { level: testsOk ? "low" : "medium", reason: `QA passed at this commit; ${testsNote}` };
    case "carried":
      return { level: "medium", reason: `QA passed on an earlier commit; ${testsNote}` };
    case "skipped":
      return { level: "medium", reason: `QA was skipped for this commit, with a recorded reason; ${testsNote}` };
    case "fail":
      return { level: "high", reason: `QA failed; ${testsNote}` };
    case "none":
      return facts.qaGate || !testsOk
        ? { level: "high", reason: `no QA result; ${testsNote}` }
        : { level: "medium", reason: `no QA run; ${testsNote}` };
  }
}

/** What the facts alone say, for a PR no Risk reviewer judged. */
function factImpact(facts: RiskFacts): RiskRating {
  if (facts.sensitive > 0) return { level: "high", reason: `touches ${plural(facts.sensitive, "sensitive path")}` };
  if (facts.deep || facts.dependencies > 0 || facts.config > 0 || facts.migrations > 0) {
    return { level: "medium", reason: [facts.deep ? "a large diff" : null, facts.dependencies > 0 ? plural(facts.dependencies, "dependency file") : null, facts.config > 0 ? plural(facts.config, "CI or infrastructure file") : null, facts.migrations > 0 ? plural(facts.migrations, "migration file") : null].filter((part) => part !== null).join(", ") };
  }
  return { level: "low", reason: `${plural(facts.files, "file")}, ${facts.lines} lines, nothing sensitive` };
}
function factRollback(facts: RiskFacts): RiskRating {
  if (facts.migrations > 0) return { level: "high", reason: `${plural(facts.migrations, "migration or schema file")}: a revert may not undo it` };
  if (facts.dependencies > 0 || facts.config > 0) return { level: "medium", reason: "dependency or deploy changes: a revert needs a rebuild or redeploy" };
  return { level: "low", reason: "no migration, dependency or config change: a revert undoes it" };
}

/**
 * The summary the person sees. Weighted as Warp does (Impact and Verification 2, Rollback 1.5, Errors
 * 1) over the categories that were judged. One change from Warp: a High anywhere makes the PR at least
 * Medium overall, so a one-way door never reads as low risk.
 */
export function riskSummary(facts: RiskFacts, review: RiskReview | null, waited: boolean): RiskSummary {
  const flagged = riskFlags(facts).length > 0;
  const verification = verificationRating(facts);
  const impact = review?.impact ?? factImpact(facts);
  const rollback = review?.rollback ?? factRollback(facts);
  const errors: RiskRating | null = review?.errors ?? null;
  const source = review !== null ? "review" : flagged && waited ? "unfinished" : "facts";
  const lines: RiskLine[] = [
    { category: "impact", label: RISK_CATEGORY_LABELS.impact, level: impact.level, reason: impact.reason },
    { category: "rollback", label: RISK_CATEGORY_LABELS.rollback, level: rollback.level, reason: rollback.reason },
    { category: "verification", label: RISK_CATEGORY_LABELS.verification, level: verification.level, reason: verification.reason },
    {
      category: "errors",
      label: RISK_CATEGORY_LABELS.errors,
      level: errors?.level ?? null,
      // With no level, every view prints "not judged" before the reason, so it isn't stored here.
      reason: errors?.reason ?? (source === "unfinished" ? "no rating came back from the Risk reviewer" : "nothing was flagged for a Risk reviewer"),
    },
  ];
  return { overall: overallRisk(lines), lines, source };
}

export function overallRisk(lines: readonly Pick<RiskLine, "category" | "level">[]): RiskLevel {
  let total = 0;
  let weights = 0;
  for (const line of lines) {
    if (line.level === null) continue;
    total += LEVEL_SCORE[line.level] * RISK_WEIGHTS[line.category];
    weights += RISK_WEIGHTS[line.category];
  }
  const score = weights === 0 ? 1 : total / weights;
  const level: RiskLevel = score >= 2.25 ? "high" : score >= 1.5 ? "medium" : "low";
  return level === "low" && lines.some((line) => line.level === "high") ? "medium" : level;
}

/**
 * A Risk reviewer's reason, as the person and GitHub see it: one line, capped, with @-mentions broken
 * so a reason can't notify anyone. It's the reviewer's text, which may echo the PR's.
 */
export function cleanRiskReason(text: string): string {
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().replace(/@/g, "@​");
  return line.length > RISK_REASON_MAX ? `${line.slice(0, RISK_REASON_MAX - 1)}…` : line;
}

const LEVEL_WORDS: Record<RiskLevel, string> = { low: "Low", medium: "Medium", high: "High" };
export function riskLevelWord(level: RiskLevel): string {
  return LEVEL_WORDS[level];
}

/** The PR comment. Reasons are plain text inside a list, so no markdown in them is needed. */
export function riskComment(summary: RiskSummary, sha: string, updated = false): string {
  const lines = summary.lines.map((line) => `- **${line.label}:** ${line.level === null ? "not judged" : LEVEL_WORDS[line.level]}: ${escapeMarkdown(line.reason)}`);
  const source = summary.source === "review" ? "The Risk reviewer judged Impact, Rollback and Error detection; Verification comes from the factory's evidence."
    : summary.source === "unfinished" ? "Something was flagged, but no rating came back from the Risk reviewer in time, so this is from the diff and the evidence alone."
    : "Nothing was flagged, so this is from the diff and the evidence alone.";
  return `**Factory merge risk: ${LEVEL_WORDS[summary.overall]}** at \`${sha.slice(0, 7)}\`${updated ? ", updated after QA reported on this commit" : ""}\n\n${lines.join("\n")}\n\n${source} It's informational: it doesn't change who may merge.`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_[\]<>|])/g, "\\$1");
}
