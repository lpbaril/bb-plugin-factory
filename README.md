# Software Factory for bb

Run a team of AI agents on your repository inside [bb](https://getbb.app). You
talk to a Lead coordinator, which routes complex requests to a Planner and starts specialists.
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

- **Agents**: one line per agent (Lead, Planner, Builder, QA, Designer, Reviewer 1,
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
- **Run a nightly check** (on by default): see [Nightly check](#nightly-check).

Requires bb 0.47 or newer. New workers explicitly report their outcomes to the
Lead; shadow reviewers have parent notifications turned off. Existing threads
retain their current notification settings.

Each agent also gets a short statement of its role with every turn, so its rules
survive when a long conversation is compacted.

## Planning and coordination

The Lead coordinates assignments and reports decisions. For a new feature,
ambiguous requirements, migrations or cross-cutting work, it first records the
original request on a task and assigns `bb factory assign APP-12 --role plan`.
Small, explicit fixes can go directly to a Builder.

The Planner defaults to Claude Opus 5.5 at high effort; it has its own model
picker. Existing Lead and specialist choices are preserved. It reads the project
checkout without editing code or git state and saves the PRD, acceptance criteria,
implementation steps, dependencies and open questions as a durable task comment.
Only that task's current Planner may mark its complete comment ready with
`bb factory plan-ready APP-12 --comment <comment-id>`.

Once planning is assigned, Factory rejects new Builder assignments for that task
until the plan is ready. Reassigning a Planner invalidates the old sign-off.
Builders receive the canonical comment reference, accessible from their worktree.
This gate does not stop an already-running Builder; the Lead must pause or steer
it when replanning. Child tasks need explicit references to their parent plan.

The Lead escalates technical disputes and substantive replanning to the Planner,
and product decisions to you. It cannot waive review gates. New PR reviewers
send parent notifications only when stuck; Factory reports the complete review
round and alerts when a reviewer finishes without recording a verdict. Existing
reviewer threads retain their notification settings.

## Run ledger

Factory records every finished turn of every factory agent: its task, role,
provider, model, reasoning level, outcome and duration, plus token use. Open
**Runs** on the Factory page, or run `bb factory runs APP [--task APP-12] [--json]`.
The report groups turns by role and model, and joins review verdicts to the model
that gave them, so you can compare reviewers on real results.

- **Tokens, not money.** The ledger stores tokens because none of the Claude Code,
  Codex and Cursor threads checked while building it reported a cost. "New input"
  is total minus cached and output, because providers count cached input differently;
  it is the number that compares across providers.
- **Token accounting.** Providers report running totals that restart with each
  session. Factory reads every usage event bb still has, adds across restarts, and
  credits each event to the turn and model running when it was reported. A turn with
  no usage event shows no tokens, and providers that report no usage show zero.
- **Older threads are a lower bound.** New turns are read as they finish, but bb
  drops older usage events, so tokens from before the ledger was installed can be
  far too low. Turn counts, outcomes, durations and verdicts don't depend on those
  events. The nightly check reads threads older than the ledger, or you can run
  `bb factory runs APP --sync`.
- **Storage.** The rows live in the plugin database and are never pruned while the
  factory exists. Deleting a factory deletes its ledger.

## Recurring review findings

When a reviewer blocks on something a repository rule would have prevented, it
records a lesson with `bb factory lesson APP-12 --rule "..."`, or `--same-as <id>`
if `bb factory lessons APP` already lists it. Only that task's Reviewer 1, Reviewer 2
or Security thread can do this.

When the same lesson appears on a second task, the factory tells the Lead once. The
Lead creates a task and assigns the Planner, who checks the rule against the cited
PRs and names the document and wording. A Builder makes the docs-only PR, which goes
through normal review, and you decide whether to merge it. The rule never reaches
the repository without that PR.

## Nightly check

At 3:00 server time, for each factory that isn't archived, Factory reads new turns
into the ledger, moves tasks with merged PRs to Done, and looks for In-Progress
tasks with no live worker and READY plans waiting for a Builder. It runs only while
bb is running, and a failure shows in `bb plugin list`.

The Lead is woken only when one of those findings is new since the last check, and
it is told to report rather than start agents. A finding that stays unresolved does
not wake it again until it clears and comes back.

## Storage and recovery

Factory keeps only a fixed-size locator in each `factory:<PREFIX>` KV entry.
The plugin database stores metadata plus individual rows for each task's agent
assignments, PRs, reviews, scans and planning comment references. Current and
retired shadow trial runs are database rows too. Task statuses and comments
remain owned by Tasks.

On the first load after upgrading, Factory backs up the original KV JSON in
`factory_legacy_backups`, writes all records in a database transaction, then
replaces KV with the locator. Restarting after an interrupted cutover resumes
from the database. No history is pruned, including Done and merged tasks.
Back up both the plugin database and KV when moving or restoring an installation;
older plugin versions cannot read the new locator format.

If an older assignment spawned a thread but failed to save it, reattach that
existing thread with `bb factory recover-agent APP-12 --thread <id>`. Factory
checks its project, plugin ownership and task metadata; it never starts or
messages another thread.

`bb factory assign APP-12 --role review1 --pr 81` can now discover an untracked
open PR whose branch matches that task's builder. Add `--track-only` to save and
validate the link without starting a reviewer or writing to GitHub. The watcher
resumes missing reviewers when automatic reviews are enabled.

For local recovery without automatic GitHub actions, run
`bb factory reviews pause APP`. Assignments and verdict recording stay available;
`bb factory reviews resume APP` resumes automatic reviewers, scans and ready gates.

## Develop

```sh
npm install
npx tsc --noEmit -p .
node --test factory-storage.test.mjs server.test.mjs host.test.mjs
bb plugin install .   # registers this directory in place
bb plugin dev         # rebuilds and reloads on save
```

- `factory-storage.ts`: transactional database storage, legacy KV migration, the
  run ledger and lessons.
- `server.ts`: the `bb factory` CLI, the page's RPC, the board
  change feed, and the pull request flow (watcher, verdicts, Rafter, ready gate,
  shadow trial), the per-turn role instructions, the failed-turn supervisor, the
  run ledger, lessons and the nightly check.
  Tasks are read and moved through the built-in Tasks plugin's RPC.
- `host.ts` and `host-contract.ts`: the host worker that runs the allowlisted
  `gh pr` commands and saves Rafter reports.
- `roles.ts`: the Lead and specialist prompts, and the short standing rules
  re-supplied every turn.
- `app.tsx`: the Factory page.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The role
prompts are adapted from [OpenRig](https://github.com/mvschwarz/openrig).
