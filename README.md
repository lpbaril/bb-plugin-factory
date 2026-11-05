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
  line: `bb factory agents` shows them, with a warning if the Builder, Reviewer 1
  and Security share a provider or a seat's provider isn't available, and `bb factory agents set <agent>
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

## Merge policy

Each factory has one written rule for who may merge, and only you can change it,
from outside an agent thread: `bb factory merge-policy APP [person|when-green]`.

- **`person`** (the default): the Lead tells you when a PR is ready, and you merge.
- **`when-green`**: the Lead merges with `bb factory merge APP-12`, then reports it.
  Large or sensitive PRs, the ones that need Reviewer 2, stay with you.

`bb factory merge` squash-merges only when the PR is open and not a draft, GitHub
reports it mergeable, every required reviewer approved the exact head, any shadow
block is cleared, no Rafter scan is running, and CI on the head reports checks that
all passed. It pins the merge to that head and records who ran it. You can run it
too under either policy, or merge on GitHub yourself.

**Merge card.** When a PR is ready for you to merge, with CI green and no conflict on GitHub, the factory shows a card in the
Lead's chat and sends a notification to your phone and desktop. The card lists the
reviewers' approvals, QA, CI, the final scan, any overlap with other open PRs, and
the changed files, with a link to the full diff on GitHub. Tap **Merge** to run the
same checks as `bb factory merge` for that exact commit, or **Not now** to close it.
While the card waits, it takes the place of the chat's message box. One card shows at
a time per factory, a new commit takes it back, and `bb factory merge-card APP-12`
shows it again. Turn it off with the **Offer a merge card in the Lead's chat** setting.
Answering the card some other way never merges, and Merge only works while a card
for that exact PR and commit is showing. Still, the card isn't a lock: while it shows,
an agent could make the same call.

**This is not a security boundary.** Agents use your `gh` login, so an agent could
still run `gh pr merge` directly, and a merge may happen overnight under `when-green`.
The policy replaces conflicting instructions with one rule; it doesn't stop an agent
determined to ignore it.

## Evidence contract

New factories run with a stricter contract for what counts as done. Existing factories
keep working as before until you turn it on, from outside an agent thread:
`bb factory evidence-contract APP on` (or `off`, or no argument to show it).

- **Evidence.** Every role gets a table of what proves a claim, and every report ends with
  "Not checked:". Another agent's word for it doesn't count.
- **QA can block.** QA records `bb factory qa APP-12 --verdict pass|fail --sha <commit>`. A PR
  can't be marked ready or merged with `bb factory merge` until QA passes. If a change doesn't
  need QA, the Lead records why with `bb factory qa-skip APP-12 --reason "..."`, once the PR is
  open. A skip covers that commit only, so a new commit needs a new skip or a QA run. Only you can
  skip QA once it's been assigned on the task, including on a later PR. Only the task's latest QA thread can record a
  verdict, and assigning QA again clears the results on all the task's open PRs, so with several open, ask the running thread to record on each rather than assigning again. A pass is recorded with its commit, and
  the PR's later fix commits don't require another QA run. The ready message and PR
  comment say which commit QA passed and how many came after, so whoever merges can decide. A result belongs to one PR, so another
  PR on the same task needs its own. If a task has several open PRs, one QA thread can record
  on each, and `--pr` says which on `qa` or `qa-skip`.
- **File coverage.** An approval must account for each file in the PR, as `reviewed <path>` or
  `skipped <path> -- <reason>`, passed with `--coverage`. Reviewers 1 and 2 and Security are
  covered, and the shadow isn't. Blocking needs no coverage, but what's given is kept. On a
  re-review, only files that reviewer thread hasn't accounted for yet need listing. It's checked
  against the PR's latest file list, and a file stays covered after later commits change it, so
  treat it as an account of what was looked at, not proof. If GitHub lists fewer files than the PR
  has, the approval still goes through, and the task notes how many weren't checked.
- **Findings.** A blocking finding needs a concrete failing case. Other concerns go under "Design
  notes (not blocking)" in the reviewer's PR comment.
- **Shortcuts.** Builders mark a deliberate shortcut with `shortcut: <the limit>, <when to
  upgrade>`, reviewers treat it as a decision, and `git grep "shortcut:"` lists them.
- **Fix loops.** After 3 rounds of requested changes, the Lead is told to involve the Planner.
  After 5, it's told to bring the PR to you instead of sending it back to the builder. This is
  guidance to the Lead, not a hard stop.

- **Ready means ready.** If a PR the factory marked ready gets new commits, requested changes or a
  hold, the factory puts it back to draft and says why on the PR, then marks it ready again once
  that's resolved. This is a signal rather than a lock: anyone can still mark it ready and merge it
  on GitHub, and a PR you marked ready by hand is left alone. Only `bb factory merge` checks the
  gates. To enforce them on GitHub, use branch protection.

Turning it on affects open PRs too: an approved PR without QA is held until QA passes or is
skipped, and the Lead is told.

## Health

Open **Health** on the Factory page, or run `bb factory health APP [--json]`, to see how
much rework PRs take: review rounds per merged PR, how often changes are requested, time
from open to ready, tokens per merged task excluding cached input, and PRs closed without
merging. Each number shows its sample size, because a small history can swing on one PR.
PRs from before this view estimate time to ready from their last approval on the head.

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
into the ledger, moves tasks with merged PRs to Done, and looks for stalled tasks
and READY plans waiting for a Builder. It runs only while bb is running, and a
failure also shows in `bb plugin list`.

**It never messages an agent**, so nothing starts while nobody is watching. Findings
wait for you in a notice on the Factory page and in `bb factory nightly [APP]`.
Dismissing the notice keeps it hidden until a later run finds something different.

A task counts as stalled only if a worker other than the Planner was assigned. A task
with no agents is treated as yours, and one with only a Planner as coordination. A
Planner-only task with a READY plan still shows as waiting for a Builder, so mark a
long-running task with `bb factory task-kind APP-88 coordination` or `person` to stop
reporting it, and `work` to undo that. The Lead or you can set this.

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
