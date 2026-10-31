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
] as const;

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
