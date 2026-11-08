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
] as const;

/**
 * The only branches the host worker will delete: an Explorer's, named by bb as
 * bb/<prefix>-<number>-explorer-<title>-<thread>. The role comes right after the
 * task number, so a Builder's branch never matches, even with "explorer" in its
 * title. The branch must also end with the Explorer's own thread id, and git
 * itself refuses a branch that is still checked out.
 */
export const EXPLORER_BRANCH = /^bb\/[a-z][a-z0-9]*-[0-9]+-explorer-[a-z0-9-]*thr_[a-z0-9]+$/;
export function isExplorerBranch(branch: string, threadId: string): boolean {
  return EXPLORER_BRANCH.test(branch) && /^thr_[a-z0-9]+$/.test(threadId) && branch.endsWith(`-${threadId}`);
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
      /** The Explorer's thread, which bb puts at the end of its branch name. */
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
