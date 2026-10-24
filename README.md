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

Settings → Plugins → Factory, or `bb plugin config factory`:

- **Agents**: one line per agent (Lead, Builder, QA, Designer, Reviewer 1,
  Reviewer 2, Security, Shadow security, and the reviewer-trial comparison),
  each with bb's provider, model and reasoning picker. Until you pick, an agent
  uses the provider's catalog defaults, exactly as shown (never the level a
  project used last); **Use defaults** goes back to them. The shadow
  reviewer also takes a **custom model id**, sent as-is, for a model the picker
  doesn't list, such as Codex's `gpt-daybreak-blue-latest`. From the command
  line: `bb factory agents` shows them, and `bb factory agents set <agent>
  --provider … --model … --reasoning …` changes one (`--custom-model` for the
  shadow). Upgrading from 0.1.2 copies the old per-role provider settings and
  the shadow model into Agents once.
- **Agent permissions**: `auto` (default) asks you before commands outside the
  sandbox. `full` removes all approvals.
- **Review factory pull requests automatically**, and the changed-line threshold
  that adds Reviewer 2.
- **Rafter API key** and an optional GitHub token for Rafter (both secret).
- **When the shadow security reviewer runs**: off, the next N PRs, or every
  sensitive PR.
- **Retry a failed agent once** (off by default): retry an interrupted agent
  once for failures outside bb's Provider retry policy; if it fails again,
  mark its task Blocked and tell the Lead. Overloads, rate limits, server errors
  and connection failures belong exclusively to bb's Provider retry plugin,
  including when its retry budget is exhausted or that plugin is disabled.

Requires bb 0.47 or newer. New workers explicitly report their outcomes to the
Lead; shadow reviewers have parent notifications turned off. Existing threads
retain their current notification settings.

Each agent also gets a short statement of its role with every turn, so its rules
survive when a long conversation is compacted.

## Develop

```sh
npm install
npx tsc --noEmit -p .
bb plugin install .   # registers this directory in place
bb plugin dev         # rebuilds and reloads on save
```

- `server.ts`: factory storage, the `bb factory` CLI, the page's RPC, the board
  change feed, and the pull request flow (watcher, verdicts, Rafter, ready gate,
  shadow trial), the per-turn role instructions and the failed-turn supervisor.
  Tasks are read and moved through the built-in Tasks plugin's RPC.
- `host.ts` and `host-contract.ts`: the host worker that runs the allowlisted
  `gh pr` commands and saves Rafter reports.
- `roles.ts`: the Lead and specialist prompts, and the short standing rules
  re-supplied every turn.
- `app.tsx`: the Factory page.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The role
prompts are adapted from [OpenRig](https://github.com/mvschwarz/openrig).
