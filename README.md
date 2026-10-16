# Software Factory for bb

Run a team of AI agents on your repository inside [bb](https://getbb.app). You
talk to a Lead, which turns your requests into tasks and starts specialists.
Every pull request is reviewed by independent agents before you merge, and a
board in bb's left navigation rail shows who is working on what.

See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does and what it
needs, and [skills/software-factory/SKILL.md](skills/software-factory/SKILL.md)
for the `bb factory` commands agents use.

## Install

From bb's plugin marketplace, search for **Software Factory**. Or install
from Git:

```sh
bb plugin install git:https://github.com/lpbaril/bb-plugin-factory.git
```

Then open **Factory** in the left navigation rail, choose **New factory**, pick
a project and a task prefix, and start the Lead.

## Settings

`bb plugin config factory`, or Settings → Plugins → Factory:

- The provider for each role (Claude Code, Codex or Cursor), and a model for
  the shadow reviewer.
- **Agent permissions**: `auto` (default) asks you before commands outside the
  sandbox. `full` removes all approvals.
- **Review factory pull requests automatically**, and the changed-line threshold
  that adds Reviewer 2.
- **Rafter API key** and an optional GitHub token for Rafter (both secret).
- **When the shadow security reviewer runs**: off, the next N PRs, or every
  sensitive PR.

## Develop

```sh
npm install
npx tsc --noEmit -p .
bb plugin install .   # registers this directory in place
bb plugin dev         # rebuilds and reloads on save
```

- `server.ts`: factory storage, the `bb factory` CLI, the page's RPC, the board
  change feed, and the pull request flow (watcher, verdicts, Rafter, ready gate,
  shadow trial). Tasks are read and moved through the built-in Tasks plugin's RPC.
- `host.ts` and `host-contract.ts`: the host worker that runs the allowlisted
  `gh pr` commands and saves Rafter reports.
- `roles.ts`: the Lead and specialist prompts.
- `app.tsx`: the Factory page.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The role
prompts are adapted from [OpenRig](https://github.com/mvschwarz/openrig).
