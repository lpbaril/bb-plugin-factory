// Host worker: runs an allowlisted set of `gh pr` commands for the server.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk";
import { GH_ALLOWED, hostContract } from "./host-contract";

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
      return new Promise((resolve) => {
        const child = execFile(
          findGh(),
          args,
          { signal: ctx.signal, maxBuffer: 8 * 1024 * 1024, timeout: 120_000, env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" } },
          (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") });
          },
        );
        if (stdin !== null) child.stdin?.end(stdin);
        else child.stdin?.end();
      });
    },
  },
});
