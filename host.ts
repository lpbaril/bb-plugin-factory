// Host worker: runs an allowlisted set of `gh pr` commands and inspects/scaffolds
// Spec-Driven Development alignment files in the project checkout.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { GH_ALLOWED, hostContract, type RepoInspection } from "./host-contract";

/** The daemon's PATH may not include user-level installs such as ~/.local/bin or Homebrew. */
function findGh(): string {
  const candidates = [
    join(homedir(), ".local/bin/gh"),
    "/home/linuxbrew/.linuxbrew/bin/gh",
    "/opt/homebrew/bin/gh",
    "/usr/local/bin/gh",
    "/usr/bin/gh",
  ];
  return candidates.find((path) => existsSync(path)) ?? "gh";
}

const KNOWN_SOURCE_DIRS = new Set([
  "src",
  "app",
  "crates",
  "engine",
  "packages",
  "lib",
  "web",
  "website",
  "server",
  "client",
  "cmd",
  "internal",
  "components",
  "pages",
  "api",
  "eval",
  "services",
]);

function countGitCommits(projectPath: string, signal?: AbortSignal): Promise<{ isGitRepo: boolean; commitCount: number }> {
  return new Promise((resolvePromise) => {
    execFile(
      "git",
      ["-C", projectPath, "rev-list", "--count", "HEAD"],
      { signal, timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout, stderr) => {
        if (error === null) {
          const parsed = Number.parseInt(String(stdout).trim(), 10);
          resolvePromise({ isGitRepo: true, commitCount: Number.isFinite(parsed) ? parsed : 0 });
          return;
        }
        const errText = String(stderr || error.message || "");
        const isGit = existsSync(join(projectPath, ".git")) || !/not a git repository/i.test(errText);
        resolvePromise({ isGitRepo: isGit, commitCount: 0 });
      },
    );
  });
}

function firstExisting(root: string, candidates: readonly string[]): string | null {
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) return rel;
  }
  return null;
}

async function listMarkdownDocs(root: string): Promise<string[]> {
  const found: string[] = [];
  const rootCandidates = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONSTITUTION.md",
    "ARCHITECTURE.md",
    "PRD.md",
    "ROADMAP.md",
    "README.md",
    "CONTRIBUTING.md",
  ];
  for (const file of rootCandidates) {
    if (existsSync(join(root, file))) found.push(file);
  }
  for (const sub of [".specify/memory", ".specify/specs", "openspec/specs", "docs", "docs/adr", "docs/plans"]) {
    const dir = join(root, sub);
    if (!existsSync(dir)) continue;
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.(md|txt|ya?ml|json)$/i.test(entry.name)) {
          found.push(`${sub}/${entry.name}`);
        } else if (entry.isDirectory() && (sub === ".specify/specs" || sub === "openspec/specs")) {
          found.push(`${sub}/${entry.name}/`);
        }
        if (found.length >= 35) break;
      }
    } catch {
      // Ignore unreadable directories.
    }
    if (found.length >= 35) break;
  }
  return found;
}

async function inspectRepo(projectPath: string, signal?: AbortSignal): Promise<RepoInspection> {
  const normalized = resolve(projectPath);
  if (!isAbsolute(projectPath) || !existsSync(normalized)) {
    return {
      exists: false,
      isGitRepo: false,
      commitCount: 0,
      sourceDirs: [],
      detectedMode: "greenfield",
      files: { agentsMd: null, constitution: null, specs: null, roadmap: null },
      existingDocs: [],
    };
  }
  let isDir = false;
  try {
    isDir = statSync(normalized).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    return {
      exists: false,
      isGitRepo: false,
      commitCount: 0,
      sourceDirs: [],
      detectedMode: "greenfield",
      files: { agentsMd: null, constitution: null, specs: null, roadmap: null },
      existingDocs: [],
    };
  }
  const { isGitRepo, commitCount } = await countGitCommits(normalized, signal);
  const sourceDirs: string[] = [];
  try {
    const entries = await readdir(normalized, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && KNOWN_SOURCE_DIRS.has(entry.name)) {
        sourceDirs.push(entry.name);
      }
    }
  } catch {
    // Ignore directory read errors.
  }
  const agentsMd = firstExisting(normalized, ["AGENTS.md", "CLAUDE.md"]);
  const constitution = firstExisting(normalized, [
    ".specify/memory/constitution.md",
    "docs/constitution.md",
    "CONSTITUTION.md",
  ]);
  const specs = firstExisting(normalized, [
    "docs/architecture.md",
    "ARCHITECTURE.md",
    "openspec/specs",
    ".specify/specs",
    "docs/PRD.md",
    "PRD.md",
  ]);
  const roadmap = firstExisting(normalized, [
    "docs/roadmap.md",
    "ROADMAP.md",
    "docs/m2-plan.md",
    "docs/plans",
  ]);
  const existingDocs = await listMarkdownDocs(normalized);
  const detectedMode = commitCount > 3 || sourceDirs.length > 0 ? "brownfield" : "greenfield";
  return {
    exists: true,
    isGitRepo,
    commitCount,
    sourceDirs,
    detectedMode,
    files: { agentsMd, constitution, specs, roadmap },
    existingDocs,
  };
}

function buildConstitutionTemplate(factoryName: string, prefix: string): string {
  return `# ${factoryName} (${prefix}) — Project Constitution

> **Purpose:** Non-negotiable engineering principles, architectural boundaries, and verification rules shared by every agent (Lead, Planner, Builder, QA, Designer, Reviewer 1/2, Security) in the **${factoryName}** software factory.

## 1. Core Principles

- **Quality and correctness over speed.** A smaller, verified change beats a speculative rewrite.
- **Evidence-backed claims.** Every completion report, QA check, and PR review finding must cite exact \`file:line\` references and command outputs.
- **Living repository truth.** Task comments (\`Factory plan: READY\`) capture per-task execution plans, while \`docs/architecture.md\`, \`docs/PRD.md\`, and \`docs/roadmap.md\` hold the living system truth. When a task alters architecture, contracts, or milestone state, update the living docs in the same PR.

## 2. Architectural & Stack Boundaries

- **Respect module ownership.** Keep domain logic, runtime/engine adapters, and UI/presentation layers cleanly separated as documented in \`docs/architecture.md\`.
- **No silent fallbacks or hidden state.** Fail loudly with actionable diagnostics rather than papering over errors.
- **Minimal diff footprint.** Builders must make the smallest coherent change that satisfies the task's Acceptance Criteria.

## 3. Verification & Definition of Done

- **Local green before PR.** Builders must run the relevant test suite, type checks, and build locally before pushing a branch for draft PR creation.
- **Deterministic checks first.** Prefer automated tests and static checks over subjective style debates.

## 4. Spec-Bound Review Convergence Contract

- **What blocks a PR (\`REQUEST CHANGES\`):**
  1. Unmet **Acceptance Criteria** from the task's canonical \`Factory plan: READY\` comment.
  2. Direct violations of this **Constitution** or documented architectural contracts.
  3. Concrete correctness, security, data-loss, or concurrency defects with \`file:line\` evidence.
- **What never blocks a PR:**
  - Out-of-scope feature requests or subjective stylistic preferences not grounded in this Constitution.
  - On re-review rounds (Round 2+), reviewers check only whether prior blocking findings were resolved and whether the new delta introduced regressions—never invent new redesign requests on untouched Round 1 code.
`;
}

function buildAgentsMdTemplate(
  factoryName: string,
  prefix: string,
  mode: "greenfield" | "brownfield",
  existingDocs: string[],
): string {
  const docList =
    existingDocs.length > 0
      ? existingDocs.map((doc) => `- \`${doc}\``).join("\n")
      : "- `.specify/memory/constitution.md`\n- `docs/architecture.md`\n- `docs/roadmap.md`";
  return `# AGENTS.md — ${factoryName} (${prefix})

This repository is managed with the **BB Software Factory** (\`bb factory\`) using **Spec-Driven Development (SDD)**.
Every coding agent (Lead, Planner, Builder, QA, Designer, Reviewer 1/2, Security) must read this router before acting.

## 1. Canonical Source-of-Truth Documents

Before planning, writing code, or reviewing a pull request, consult:
- **Constitution (Immutable Rules & Review Contract):** \`.specify/memory/constitution.md\`
- **System Architecture & Boundaries:** \`docs/architecture.md\`
- **Product Roadmap & Active Milestone Gates:** \`docs/roadmap.md\`

### Discovered Repository Docs
${docList}

## 2. How Work Flows Across Roles (${mode === "greenfield" ? "Greenfield Mode" : "Brownfield Mode"})

1. **Lead (\`lead\`):** Coordinates the \`${prefix}\` board, keeps \`docs/roadmap.md\` aligned with reality, delegates ambiguity/architecture to the **Planner**, and opens draft PRs when Builders finish. Never writes product code directly.
2. **Planner (\`plan\`):** Reads \`.specify/memory/constitution.md\`, \`docs/architecture.md\`, and the codebase. Publishes a \`Factory plan: READY\` task comment with \`## Problem and scope\`, \`## Acceptance criteria\`, \`## Implementation plan\`, \`## Dependencies\`, and \`## Open questions\`, then runs \`bb factory plan-ready <KEY> --comment <id>\`. Names any living docs (\`docs/architecture.md\`, \`docs/roadmap.md\`, ADRs) that the Builder must update.
3. **Builder (\`build\`):** Works in an isolated Git worktree. Reads the canonical \`Factory plan: READY\` comment and \`.specify/memory/constitution.md\`. Implements the smallest coherent change, updates living docs when contracts change, runs local verification suites, and pushes the branch.
4. **QA (\`qa\`) & PR Reviewers (\`review1\`, \`review2\`, \`security\`):** Grade the diff strictly against the task's **Acceptance Criteria** and \`.specify/memory/constitution.md\`. Do not invent out-of-scope redesigns on re-review rounds.
`;
}

function buildArchitectureTemplate(factoryName: string, prefix: string, mode: "greenfield" | "brownfield"): string {
  return `# ${factoryName} (${prefix}) — System Architecture & Living Spec

> **Status:** ${mode === "greenfield" ? "Greenfield — Initial Architecture Blueprint" : "Brownfield — Living System Map (keep updated as PRs merge)"}

## 1. System Overview & Goals

_Describe the core runtime components, data flow, and primary user surfaces._

## 2. Module & Directory Boundaries

| Path / Module | Responsibility | Allowed Dependencies |
| --- | --- | --- |
| \`src/\` or \`crates/\` | Core application logic | Internal domain modules only |
| \`docs/\` & \`.specify/\` | Living specs, ADRs, Constitution | Referenced by all agents |

## 3. Key Invariants & Contracts

- Document state machines, IPC/API schemas, performance budgets, and platform constraints here so Planners and Builders share one mental model.
`;
}

function buildRoadmapTemplate(factoryName: string, prefix: string, mode: "greenfield" | "brownfield"): string {
  return `# ${factoryName} (${prefix}) — Milestone & Gate Roadmap

> **Purpose:** Single source of truth for where the project is at, what milestone gate is active, and what comes next.

## Current Project State (${mode === "greenfield" ? "Greenfield Kickoff" : "Brownfield Alignment"})

- **Active Milestone:** M1 — Foundation & Core Workflow
- **Current Gate:** Establish constitution, architecture baseline, and ready task queue on board \`${prefix}\`.

## Milestones

### M1: Foundation & Core Verification
- [ ] Lock \`.specify/memory/constitution.md\` and \`AGENTS.md\`
- [ ] Baseline \`docs/architecture.md\` and acceptance criteria
- [ ] Complete initial task wave on \`${prefix}\`

### Next Steps (Updated by Lead)
- Run \`bb factory status ${prefix}\` and \`bb factory doctor ${prefix}\` to inspect active workstreams and pending gates.
`;
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    save_report: async ({ name, content }, ctx) => {
      const dir = join(ctx.experimental_paths.dataDir, "rafter");
      await mkdir(dir, { recursive: true });
      const path = join(dir, name);
      await writeFile(path, content, { mode: 0o600 });
      return { path };
    },
    gh: ({ args, stdin }, ctx) => {
      const allowed = GH_ALLOWED.some(([group, command]) => args[0] === group && args[1] === command);
      if (!allowed) {
        return { code: 126, stdout: "", stderr: `gh ${args.slice(0, 2).join(" ")} is not allowed` };
      }
      return new Promise((resolvePromise) => {
        const child = execFile(
          findGh(),
          args,
          { signal: ctx.signal, maxBuffer: 8 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
            resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") });
          },
        );
        if (stdin !== null) child.stdin?.end(stdin);
        else child.stdin?.end();
      });
    },
    inspect_repo: async ({ projectPath }, ctx) => {
      return inspectRepo(projectPath, ctx.signal);
    },
    scaffold_specs: async ({ projectPath, factoryName, prefix, mode }, ctx) => {
      const normalized = resolve(projectPath);
      if (!isAbsolute(projectPath) || !existsSync(normalized) || !statSync(normalized).isDirectory()) {
        throw new Error(`Project path is not an accessible directory: ${projectPath}`);
      }
      const inspection = await inspectRepo(normalized, ctx.signal);
      const created: string[] = [];
      const existing: string[] = [];

      const ensureFile = async (relPath: string, existingMatch: string | null, content: string) => {
        if (existingMatch !== null) {
          existing.push(existingMatch);
          return;
        }
        const target = join(normalized, relPath);
        if (existsSync(target)) {
          existing.push(relPath);
          return;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content, { encoding: "utf8", flag: "wx" });
        created.push(relPath);
      };

      await ensureFile(
        ".specify/memory/constitution.md",
        inspection.files.constitution,
        buildConstitutionTemplate(factoryName, prefix),
      );
      await ensureFile(
        "docs/architecture.md",
        inspection.files.specs,
        buildArchitectureTemplate(factoryName, prefix, mode),
      );
      await ensureFile(
        "docs/roadmap.md",
        inspection.files.roadmap,
        buildRoadmapTemplate(factoryName, prefix, mode),
      );
      const refreshedDocs = await listMarkdownDocs(normalized);
      await ensureFile(
        "AGENTS.md",
        inspection.files.agentsMd,
        buildAgentsMdTemplate(factoryName, prefix, mode, refreshedDocs),
      );

      return { created, existing };
    },
  },
});
