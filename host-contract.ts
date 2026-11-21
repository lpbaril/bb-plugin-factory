// The contract between server.ts and the host worker (host.ts), which runs
// `gh` on the machine that holds the project checkout.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The only `gh` subcommands the host worker will run. */
export const GH_ALLOWED = [
  ["pr", "list"],
  ["pr", "view"],
  ["pr", "ready"],
  ["pr", "comment"],
  ["pr", "merge"],
  ["pr", "checks"],
  ["run", "list"],
] as const;

/** The fields `gh run list` may ask for: enough to tell a failed run from a passing one. */
export const RUN_LIST_FIELDS = ["name", "workflowName", "status", "conclusion", "headSha", "createdAt", "databaseId", "event"] as const;
/**
 * `gh run list` is read-only, but only one form is allowed: the runs of one commit, as JSON, with
 * named fields and a limit. `--repo`, `--commit`, `--json` and `--limit` each once, nothing else.
 */
export function runListArgsAllowed(args: readonly string[]): boolean {
  if (args[0] !== "run" || args[1] !== "list") return false;
  const rest = args.slice(2);
  if (rest.length !== 8) return false;
  const seen = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index]!;
    const value = rest[index + 1]!;
    if (seen.has(flag)) return false;
    seen.set(flag, value);
  }
  const repo = seen.get("--repo");
  const commit = seen.get("--commit");
  const json = seen.get("--json");
  const limit = seen.get("--limit");
  if (seen.size !== 4 || repo === undefined || commit === undefined || json === undefined || limit === undefined) return false;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return false;
  if (!/^[0-9a-f]{40}$/.test(commit)) return false;
  if (!/^[1-9][0-9]?$/.test(limit)) return false;
  return json.split(",").every((field) => (RUN_LIST_FIELDS as readonly string[]).includes(field));
}

/**
 * The only branches the host worker will delete: an Explorer's or a design reviewer's,
 * named by bb as bb/<prefix>-<number>-<role>-<title>-<thread>. Neither ships code. The
 * role comes right after the task number, so a Builder's branch never matches, even with
 * "explorer" in its title. The branch must also end with that agent's own thread id, and
 * git itself refuses a branch that is still checked out.
 */
export const DISPOSABLE_BRANCH = /^bb\/[a-z][a-z0-9]*-[0-9]+-(?:explorer|design-review)-[a-z0-9-]*thr_[a-z0-9]+$/;
export function isDisposableBranch(branch: string, threadId: string): boolean {
  return DISPOSABLE_BRANCH.test(branch) && /^thr_[a-z0-9]+$/.test(threadId) && branch.endsWith(`-${threadId}`);
}

export const repoInspectionSchema = z.object({
  exists: z.boolean(),
  isGitRepo: z.boolean(),
  commitCount: z.number(),
  sourceDirs: z.array(z.string()),
  detectedMode: z.enum(["greenfield", "brownfield"]),
  files: z.object({
    agentsMd: z.string().nullable(),
    constitution: z.string().nullable(),
    specs: z.string().nullable(),
    roadmap: z.string().nullable(),
  }),
  existingDocs: z.array(z.string()),
});
export type RepoInspection = z.infer<typeof repoInspectionSchema>;

export const hostContract = defineRpcContract({
  save_report: {
    input: z.object({
      /** File name only, such as rafter-<scan id>.json. */
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/),
      content: z.string().max(50_000_000),
    }),
    output: z.object({ path: z.string() }),
  },
  gh: {
    input: z.object({
      args: z.array(z.string().max(20_000)).min(2).max(30),
      /** Text piped to stdin, for `--body-file -`. */
      stdin: z.string().max(60_000).nullable(),
    }),
    output: z.object({ code: z.number(), stdout: z.string(), stderr: z.string() }),
  },
  delete_explorer_branch: {
    input: z.object({
      projectPath: z.string().min(1).max(4096),
      branch: z.string().min(1).max(250),
      /** The agent's thread, which bb puts at the end of its branch name. */
      threadId: z.string().min(1).max(100),
    }),
    /** missing: there was no such branch, which needs nothing more. */
    output: z.object({ deleted: z.boolean(), missing: z.boolean(), error: z.string().nullable() }),
  },
  inspect_repo: {
    input: z.object({
      projectPath: z.string().min(1).max(4096),
    }),
    output: repoInspectionSchema,
  },
  scaffold_specs: {
    input: z.object({
      projectPath: z.string().min(1).max(4096),
      factoryName: z.string().min(1).max(120),
      prefix: z.string().min(1).max(20),
      mode: z.enum(["greenfield", "brownfield"]),
    }),
    output: z.object({
      created: z.array(z.string()),
      existing: z.array(z.string()),
    }),
  },
});
