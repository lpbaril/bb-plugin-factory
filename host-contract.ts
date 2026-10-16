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
});
