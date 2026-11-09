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

- **Agents**: one line per agent (Lead, Planner, Explorer, Builder, QA, Designer,
  Reviewer 1, Reviewer 2, Security, Design reviewer, Shadow security, and the
  reviewer-trial comparison),
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
- **Presets**: above the agents, **Balanced**, **Lower cost** and **Maximum
  depth** each propose a provider and reasoning level for every seat, with why,
  for you to tick and apply. Nothing changes until you choose **Apply**.
  - **Balanced** keeps each seat as you set it, except that it moves Reviewer 1
    to a provider other than the Builder's, design reviewers to one other than
    the Planner's, and any seat off a provider that isn't available.
  - **Lower cost** is Balanced with the lowest reasoning level on the seats that read
    more than they write: Lead, QA, Explorer and Design reviewer.
  - **Maximum depth** is Balanced with the highest reasoning level on the Planner,
    the design reviewers and the PR reviewers, and Reviewer 2 on a third
    provider when there is one.
  - **What a preset keeps:** the model and reasoning level you picked, when the seat
    stays on the same provider and the preset doesn't target its level. A seat
    that moves starts from that provider's defaults. Maximum depth never lowers a
    level, such as ultra, and Lower cost never raises one, such as none. A level is left alone
    when the model's levels can't be read. It proposes only
    providers available on this machine, preferring ones the roster already
    uses, and never touches the shadow or the trial comparison.
  - **Reviewer seats** (Reviewer 1, Reviewer 2 and Security) are shown but
    unticked: tick them yourself to apply them.
  - **From the command line:** `bb factory agents preset balanced|lower-cost|max-depth`
    previews, and `--apply` applies the ticked seats, or only those named with
    `--seats review1,plan`. Applying is refused from an agent thread, and when
    the roster or the providers changed since the preview.
- **Agent permissions**: `auto` (default) asks you before commands outside the
  sandbox. `full` removes all approvals.
- **Review factory pull requests automatically**, and the changed-line threshold
  that adds Reviewer 2.
- **Compact the Lead's context above this many tokens** (300,000 by default; 0 turns it off).
  - **Why:** every Lead turn re-reads its whole conversation, and providers only compact
    near the end of the model's window, which is 967K of 1M on Claude.
  - **When:** while the Lead is idle, the factory asks bb to compact it, after checking it's
    still idle. It waits while a merge card or a question waits for you, and compacts at most
    once every 30 minutes. After a failed attempt it waits 30 minutes, doubling with each
    failure in a row up to a day, so a provider that can't compact isn't asked every turn.
  - **What stays:** the Lead's standing rules come from the plugin, so they survive.
  - **Checking it:** `bb factory lead-context APP` shows how full the Lead's context is and
    when the factory last compacted it. Health's **Where tokens go** shows the effect on
    the Lead's cached tokens per turn.
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

## Tracks and exploration

Each task gets a track that decides its path before the production line. The Lead
picks it when it takes the task, with `bb factory track APP-12 direct|plan|explore`,
and you can change it from the task on the Factory page. Assigning a role also picks
one: the Planner makes a task plan, an Explorer makes it explore, and a Builder makes
a task with no track yet direct.

- **direct:** a small, explicit change. It goes straight to a Builder.
- **plan:** the Planner's READY plan comes first. The factory refuses a Builder until
  the plan is marked ready.
- **explore:** nobody knows yet which approach works, or whether the task is worth
  doing. `bb factory assign APP-12 --role explore` starts an Explorer in its own
  worktree with a 45-minute time box. It opens no PR and ends with a report, a task
  comment recorded with `bb factory explore-report`: hypothesis, what was tried, what
  was learned, a recommendation (build, plan, explore more or close) and what wasn't
  checked. The factory reminds it near the end of the time box, and tells the Lead if
  it runs past. An Explorer that finishes or is stopped without a report is given up
  on after twice its time box, and the comparison lists it as stopped without one. Once it has reported and finished, the factory archives its thread
  and deletes its worktree and local branch. The host worker deletes only a branch
  named as an Explorer's, never one still checked out, and a branch an Explorer
  pushed anyway stays on GitHub. A Builder
  isn't started on an explore task: you decide what comes next, and the Lead records
  it by changing the track.

One Explorer is the default. To compare approaches, ask for up to 3 candidates:
`--candidates 2 --instructions "1. ... 2. ..."` on separate lines, one numbered
approach for each. Each candidate tries only its own. When all have reported, the
Lead gets them side by side, and the task on the Factory page shows them in columns.

A Planner can also end without a plan: NEEDS SPIKE moves the task to explore, and
RECOMMEND CLOSE, like an Explorer's close recommendation, marks the task "Close
advised" until a track is chosen, a new Planner or Explorer starts, or a plan is
READY. Only you close a task on an agent's advice.

Turning tracks on in an existing factory keeps a Planner's gate: a task that already
has a Planner counts as plan, so no Builder starts until its plan is READY.

Tracks are on for new factories. Existing factories keep working as before until you
turn them on, from outside an agent thread: `bb factory tracks APP on`.

## Design review

When a Planner marks a plan READY, fresh design reviewers read it before any Builder
starts. They haven't seen the Planner's reasoning: each reads only the plan and the code
it names, read-only in the project checkout, one thread per lens. This is adapted from
Google's [Elephant & Goldfish Model](https://github.com/google/elephant-goldfish-model)
(Apache-2.0).

- **Core lenses:** Zoom Out (simplicity, YAGNI, reuse of existing code), Comprehension
  (a naive reader: undefined terms and assumed context) and Codebase Details (what the
  plan says about the code, checked against the code).
- **Full depth** adds Design Critic (failure modes, scale, trade-offs) and
  Implementation Readiness (files, steps and tests). It runs when the plan names
  sensitive paths, the same ones that bring in Reviewer 2 on a PR, or when the Lead or
  you set `bb factory design-depth APP-12 full` before the plan is READY.
- Each reviewer records its findings, each a Blocker, Major or Nit, with
  `bb factory design-findings`. The Planner resolves each one with
  `bb factory design-resolve`: **fix**, **contest** with evidence the reviewer could
  have read, **escalate** when only you know the answer, or **decline** for Nits. A
  Comprehension finding can't be contested.
- A Builder can't start until no Blocker or Major is unsettled. The Planner resolves
  every Blocker and Major first, then posts a new READY plan after a fix, which starts
  the next round and stops the old round's reviewers still reading. The same plan
  can't be marked ready again to shake off its findings. A round with no unsettled
  Blocker or Major ends the review, and its findings can't change after that.
- Only escalations reach you, through the Lead or as Keep and Fix buttons on the task
  on the Factory page. So do the plan's own questions for you: the Planner lists each
  one under "## Open questions" as `- For the person: Q1. <question> Assumed: <what the
  plan builds on>`. The Lead gets them as soon as the plan is READY, and no Builder
  starts until you've answered each (an answer that kept the plan's assumption carries
  over to the same question in the next plan), through the Lead (`bb factory plan-answer APP-12
  keep|change --question Q1`) or on the task. A different answer sends the plan back to
  the Planner for a new READY plan. After 5 rounds, the Lead brings the plan to you: you can accept it
  as it is (`bb factory design-accept APP-12 --reason "..."`) or send it back.
- READY plans also need a "## Success checks" heading. Every review, with findings or
  without, ends with "## Checked" (the plan sections and files read) and "## Not
  checked", so a clean review shows what it looked at.
- Once a reviewer has finished, the factory archives its thread and deletes the
  worktree and branch bb made for it, the same way as an Explorer's.

Design review is on for new factories. Existing factories turn it on from outside an
agent thread: `bb factory design-review APP on`. It applies to plans marked ready from
then on. The design reviewer seat in Agents defaults to Codex, a provider other than
the Planner's; if that provider isn't available, reviewers run on the Planner's and
the task says so. Turning design review off lets plans it was holding go ahead.

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
block is cleared, no Rafter scan is running, and the checks GitHub requires on the base
branch all passed on the head. If the base branch requires none, every check counts. A
failing optional check doesn't hold a merge, and when a check ran more than once on the head, only its latest run counts. GitHub's own branch rules must also allow it:
a PR GitHub reports as blocked (for example a required check that hasn't started yet) or
behind its base isn't merged. It pins the merge to that head and records who ran it. You can run it
too under either policy, or merge on GitHub yourself.

**Merge card.** When a PR is ready for you to merge, with its required checks passing and no conflict on GitHub, the factory shows a card in the
Lead's chat and sends a notification to your phone and desktop. The card lists the
reviewers' approvals, QA, CI, the final scan, any overlap with other open PRs, and
the changed files, with a link to the full diff on GitHub. Tap **Merge** to run the
same checks as `bb factory merge` for that exact commit, or **Not now** to close it.
While the card waits, it takes the place of the chat's message box. One card shows at
a time per factory, a new commit takes it back, and `bb factory merge-card APP-12`
shows it again. If a failing required check, a conflict, GitHub's branch rules or a repo
with no CI checks holds the card back, the Lead is told why, so it can tell you. Failing optional checks are listed on the card. Turn it off with the **Offer a merge card in the Lead's chat** setting.
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

To compare before and after a change, such as turning on the evidence contract, count only
PRs opened in a window: on the Factory page, pick the days in **Health**, or run
`bb factory health APP --since 2026-11-05` for that day on and `--before 2026-11-05` for
before it. Days are YYYY-MM-DD, from midnight on the machine bb runs on. A PR with no open date
can't be placed in a window, so it's left out and counted.

**Where tokens go**, below the PR numbers, reads the run ledger, for the turns that started in the window:

- **By role:** tokens excluding cached, cached tokens, each role's share, failed and interrupted turns, and the median cached tokens per turn.
- **By what became of the task:** merged, closed without merging, PR still open, no PR (plans, explorations or work that never reached one), and turns not tied to a task, mostly the Lead's. A task's outcome counts every PR, whenever it opened.
- **Failed or interrupted turns,** and their share.
- **The Lead's cached tokens per turn,** in the first and last quarter of each Lead thread's turns, for threads with at least 8. A replaced Lead starts with a fresh context, so each thread is read on its own.

Cached tokens per turn grow with both the context and the steps in a turn, so they're a
sign of growth, not a measure of context size. Providers count cached input differently,
so compare roles on the same provider. Turns from before the ledger counted tokens are
counted but add none. A turn never counts below zero, even when a provider reports more
cached input than its total; tokens per merged task use the same definition.

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
