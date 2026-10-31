---
name: software-factory
description: Run or work in a bb software factory with the `bb factory` CLI. Use when the user asks to create a factory, start its Lead, assign a task to a planner, builder, QA, designer, reviewer or security agent, record a PR review verdict, mark a task blocked, or see the factory board; or when your own prompt says you are the Lead or a specialist of a factory.
---

# Software factory

A factory ties one bb project to one Tasks tracker project. Its **Lead** thread
coordinates ready tasks and assigns **specialists** (Planner, Builder, QA,
Designer). The Planner owns PRDs, architecture, acceptance criteria and task breakdown. Each specialist runs as the Lead's child thread, so the Lead is
notified when it finishes. PR reviewers use stuck-only parent notifications;
Factory reports their combined review round. The **Factory** page in the left navigation rail
shows the agents and a board with the columns Backlog, To do, In progress,
In review, Done and Blocked; cards show their pull request and its verdicts.

## Spec-Driven Alignment & Greenfield vs. Brownfield Onboarding

When starting or resuming a factory, the plugin inspects the project repository to detect whether it is **Greenfield** (new project) or **Brownfield** (existing codebase and commit history), or uses the explicit `--mode greenfield|brownfield` setting:

- **Living Repository Truth (`AGENTS.md`, `.specify/memory/constitution.md`, `docs/architecture.md`, `docs/roadmap.md`):** Task comments (`Factory plan: READY`) hold per-task execution plans, while the repository holds the living system truth. Scaffolding missing files with `bb factory init-specs APP` (or via the Factory page) ensures every agent (Lead, Planner, Builder, QA, Reviewers) shares one Constitution and architecture router without overwriting existing docs.
- **Greenfield Playbook:** The Lead confirms vision and constraints, scaffolds the Constitution and initial specs (`bb factory init-specs APP`), routes Milestone 1 architecture and task breakdown through the Planner, and waits for `Factory plan: READY` before spawning Builders.
- **Brownfield Playbook:** The Lead runs `bb factory status APP` and `bb factory doctor APP`, reads existing docs (`AGENTS.md`, `.specify/memory/constitution.md`, `docs/architecture.md`, `docs/roadmap.md`), reconciles any merged PRs or orphaned In-Progress tasks (`bb factory reconcile APP`), and gives the person a concise status and next-step brief before dispatching new work.
- **Spec-Bound Review Convergence:** Reviewers grade diffs against the task's `Factory plan: READY` acceptance criteria and `.specify/memory/constitution.md`. On re-review rounds (Round 2+), reviewers check only whether prior blocking findings were fixed and whether the new delta introduced regressions—never inventing new out-of-scope redesign requests.

## On-demand planning

Preserve the original request verbatim, its source message references and constraints
in a task before summarizing it. For new features, unclear acceptance criteria,
migrations, cross-cutting changes or a technical dispute, assign
`bb factory assign APP-12 --role plan`. A small, well-specified fix can skip planning.
The Planner defaults to Opus 5.5/high. Keep existing Lead settings unless the person
asks to change them.

The Planner reads the project checkout without editing code or git state. It saves
a complete Markdown PRD and plan as an agent task comment (scratch files belong
in thread storage). A ready comment starts with `Factory plan: READY` and includes
`## Problem and scope`, `## Acceptance criteria`, `## Implementation plan`,
`## Dependencies`, and `## Open questions`. Product questions go to the person
through the Lead; unresolved plans stay DRAFT and the task is blocked.

After posting, the current Planner runs
`bb factory plan-ready APP-12 --comment <comment-id>`. Factory checks its identity,
comment authorship and required sections. This is a readiness declaration, not
an automated assessment of the plan's quality. New Builder assignments on that
task are refused until it is ready; assigning another Planner resets readiness.
Builders receive the canonical comment reference and read it directly.

The Lead routes work; it must not rewrite requirements, waive security findings,
or resolve architectural disputes itself. Reuse the Planner for substantive
changes (a new Planner assignment invalidates readiness); ask the person about
product intent. Stop or steer any running Builder before replanning: the gate
controls new assignments, not running threads. When splitting into child tasks,
carry the parent plan reference and applicable acceptance criteria into each.

Keep handoffs concise: status, task/plan references, evidence links and decisions
needed. Do not paste full plans or logs into the Lead thread, or poll active workers.

## Pull request flow

1. When a builder is done (and QA passed, if assigned), it has run the full
   local suite and pushed its branch; the Lead opens a **draft** PR for it with
   `gh pr create --draft`.
2. Within about two minutes the factory sees the PR (it matches the PR's head
   branch to the task's builder worktree) and starts **Reviewer 1** and the
   **Security** reviewer, plus **Reviewer 2** when the diff is large or touches
   sensitive paths. With a Rafter API key set, the factory first runs a Rafter
   scan of the PR branch and gives its results to the Security reviewer.
3. Each reviewer posts one PR comment starting with APPROVE or REQUEST CHANGES,
   then records it with `bb factory verdict`.
4. When the round is complete, the factory tells the Lead once, and the Lead
   sends the builder PR/comment and reviewer-thread references in one handoff;
   the builder reads and addresses every finding directly, so fixes land in a
   single push. New commits re-review only the delta, and only by the
   reviewers who requested changes.
5. When every required verdict is APPROVE, the factory marks the PR ready for
   review (which also runs full CI) and, with Rafter, runs a final scan. If
   the PR touches files another open factory PR also touches, the Lead gets a
   merge-train note so it can suggest an order. The person merges; the factory
   then moves the task to Done.

## Keeping CI costs down

Every push to a PR branch re-runs the repo's CI and the re-reviewers, so the
factory is built to minimize pushes and rounds: batched findings per round,
delta-scoped re-reviews, builders that push only a locally green branch, and
reviewers that never re-run CI jobs to probe flakes (they reproduce locally).

On the repo side, keep expensive workflows for when they matter: fast Linux
checks on `pull_request`, macOS/Windows matrices on `main`, nightly, a label
such as `ci-full`, or platform-sensitive paths only; cancel superseded runs;
skip docs-only changes. PRs stay drafts until every reviewer approves, so
"ready for review" can gate the heavy jobs.

## Commands

| Command | Effect |
| --- | --- |
| `bb factory list` | List factories with their prefix, project and Lead; archived ones are marked `[archived]`. |
| `bb factory agents` | Show the provider, model and reasoning level each agent runs on. Leave changes to the person unless they ask. |
| `bb factory archive APP` | Archive a factory: it leaves the Factory page tabs, takes no new agents, and gets no automatic PR reviews. |
| `bb factory restore APP` | Restore an archived factory. Deleting a factory is only possible from the Factory page. |
| `bb factory create --prefix APP [--project proj_...] [--name "..."] [--mode auto\|greenfield\|brownfield] [--init-specs]` | Create a factory and its Tasks tracker (or reuse a tracker with that prefix). Optionally set the project mode and scaffold missing Spec-Driven alignment files. |
| `bb factory start APP [--goal "..."] [--mode auto\|greenfield\|brownfield] [--init-specs]` | Start the Lead thread with Greenfield/Brownfield detection and optional spec scaffolding. |
| `bb factory doctor [APP] [--mode auto\|greenfield\|brownfield]` | Inspect Greenfield/Brownfield mode, Spec-Driven alignment files (`AGENTS.md`, `.specify/memory/constitution.md`, `docs/`), and board health (merged PRs still open, In-Progress tasks without live workers, READY plans awaiting Builders). |
| `bb factory init-specs [APP] [--mode greenfield\|brownfield]` | Scaffold missing Spec-Driven alignment files in the repository without overwriting existing files. |
| `bb factory reconcile [APP] [--notify-lead]` | Move tasks with already-merged PRs to Done, audit stalled In-Progress tasks, and optionally send a status/alignment brief to the Lead thread. |
| `bb factory assign APP-12 --role plan\|build\|qa\|design\|review1\|review2\|security [--instructions "..."]` | Spawn a specialist for the task as the Lead's child. Planner uses the project checkout; Builder and Designer get a new worktree; QA and reviewers reuse the task's builder worktree. PR reviewers are normally started automatically instead. |
| `bb factory assign APP-12 --role review1\|review2\|security --pr N` | Replace a reviewer that failed (dead provider, removed model) with a fresh one on the current roster, reviewing that PR. Retrying the old thread keeps the model it was spawned with, so it cannot recover from a provider that ran out. |
| `bb factory plan-ready APP-12 --comment <id>` | Current Planner only: validate its READY planning comment and allow Builder assignments. |
| `bb factory verdict APP-12 --role review1\|review2\|security\|shadow --verdict approve\|changes [--pr N]` | Record a reviewer's verdict on the task's PR, after posting it (as a PR comment; the shadow reviewer posts a task comment). Only the reviewer thread the factory started can record it. |
| `bb factory dismiss APP-12 --reason "..."` | Dismiss the shadow Security reviewer's REQUEST CHANGES. Only the task's Security reviewer can run this; the person can also dismiss from the task on the Factory page. |
| `bb factory rafter check` | Check the Rafter API key and show the scan quota (never prints the key). |
| `bb factory rafter scan APP-12` | Rescan the task's open PR with Rafter and hand the results to its Security reviewer. |
| `bb factory rafter report APP-12` | Save the full report of the latest finished scan and print its path. |
| `bb factory shadow compare [--now]` | Start the shadow reviewer comparison if its condition is met, or say what it waits for. |
| `bb factory shadow backfill APP-12` | Add an already-reviewed open PR to the shadow reviewer trial. |
| `bb factory block APP-12 --reason "..."` | Mark the task Blocked and record why. |
| `bb factory unblock APP-12 [--note "..."]` | Clear Blocked. |
| `bb factory status [APP]` | Print the board, the agents on each task, and each task's branch or PR with its verdicts. |

Add `--json` to `list`, `create`, `start`, `assign` and `status` when the
output drives code.

Tasks themselves are managed with `bb tasks` (`create`, `show`, `update
--status`, `comment`, `attach`). The prefix of a task key names its factory.

## Settings

Factory history is stored in the plugin database; `factory:<PREFIX>` KV entries
are fixed-size locators. The first upgraded load backs up and migrates legacy
state automatically without pruning Done tasks or review history.

Recovery commands:
- `bb factory recover-agent APP-12 --thread <id>` reattaches an existing Factory
  thread after an assignment save failed; it validates ownership and never spawns.
- `bb factory assign APP-12 --role review1 --pr N --track-only` tracks and validates
  a matching open PR without starting reviewers or writing GitHub. Without
  `--track-only`, assignment also starts the reviewer. Forks and unrelated builder
  branches are rejected.
- `bb factory reviews pause APP` pauses automatic PR actions for that factory
  during local recovery; `bb factory reviews resume APP` starts them again.
  Verdict recording and manual assignments remain available while paused.

`bb factory agents` shows the provider, model and reasoning level each agent
runs on (every role plus the reviewer-trial comparison); the person changes them
in the Agents section of the plugin settings, or with `bb factory agents set`.
An unset level follows the model's default. A level the model's catalog doesn't
list is still sent as the person set it — provider capabilities lag behind what
a provider accepts — with a warning in the plugin log.
`bb plugin config factory` shows the rest: agent permissions, automatic PR reviews on or off, the changed-line threshold for
Reviewer 2, the secret Rafter API key and optional GitHub token for Rafter, and
the shadow security reviewer (when it runs: off, the next N
PRs, or every sensitive PR, judged by changed paths and the PR title). The shadow
reviewer posts only task comments, and a comparison thread scores it against the
incumbent. With **Shadow REQUEST CHANGES blocks the ready gate** on, its REQUEST
CHANGES keeps the PR in draft until a new commit fixes it (the shadow re-reviews)
or the Security reviewer or the person dismisses it with a reason. The Lead sends
real findings to the builder; it never dismisses them.

With **Retry a failed agent once** on, a factory agent whose turn fails, or is
cut off by a daemon restart, a lost connection or a stalled provider, is retried
once automatically, and the Lead gets a `[factory]` message saying so: wait for
that agent's result before reassigning. If the retry fails too, the task is
marked Blocked and the Lead is told. Overloads, rate limits, server errors and connection failures are left to bb's
Provider retry plugin, even when its retry budget is exhausted or it is disabled.

## Rules

- Spawn factory agents only with `bb factory assign`, never with `bb thread
  spawn`, so they appear on the board and report to the Lead.
- Assign a Builder before QA or a reviewer: they check the builder's worktree.
- Blocked is a label on top of the status. Use `bb factory block`, not a
  status change, and always give the reason.
- The Lead may push builder branches and open draft PRs. Never merge, force-push
  or push to the base branch; merging is the user's decision.
