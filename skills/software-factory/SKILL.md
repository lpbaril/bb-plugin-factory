---
name: software-factory
description: Run or work in a bb software factory with the `bb factory` CLI. Use when the user asks to create a factory, start its Lead, assign a task to a builder, QA, designer, reviewer or security agent, record a PR review verdict, mark a task blocked, or see the factory board; or when your own prompt says you are the Lead or a specialist of a factory.
---

# Software factory

A factory ties one bb project to one Tasks tracker project. Its **Lead** thread
shapes work into tasks and assigns them to **specialists** (Builder, QA,
Designer). Each specialist runs as the Lead's child thread, so the Lead is
notified when it finishes. The **Factory** page in the left navigation rail
shows the agents and a board with the columns Backlog, To do, In progress,
In review, Done and Blocked; cards show their pull request and its verdicts.

## Pull request flow

1. When a builder is done (and QA passed, if assigned), the Lead pushes the
   builder's branch and opens a **draft** PR for it with `gh pr create --draft`.
2. Within about two minutes the factory sees the PR (it matches the PR's head
   branch to the task's builder worktree) and starts **Reviewer 1** and the
   **Security** reviewer, plus **Reviewer 2** when the diff is large or touches
   sensitive paths. With a Rafter API key set, the factory first runs a Rafter
   scan of the PR branch and gives its results to the Security reviewer.
3. Each reviewer posts one PR comment starting with APPROVE or REQUEST CHANGES,
   then records it with `bb factory verdict`.
4. New commits on the PR re-run only the reviewers who requested changes.
5. When every required verdict is APPROVE, the factory marks the PR ready for
   review (which also runs full CI) and, with Rafter, runs a final scan. The
   person merges; the factory then moves the task to Done.

## Commands

| Command | Effect |
| --- | --- |
| `bb factory list` | List factories with their prefix, project and Lead. |
| `bb factory create --prefix APP [--project proj_...] [--name "..."]` | Create a factory and its Tasks tracker (or reuse a tracker with that prefix). The project defaults to the current thread's. |
| `bb factory start APP [--goal "..."]` | Start the Lead thread. |
| `bb factory assign APP-12 --role build\|qa\|design\|review1\|review2\|security [--instructions "..."]` | Spawn a specialist for the task as the Lead's child. Builder and Designer get a new worktree; the others reuse the task's builder worktree. PR reviewers are normally started automatically instead. |
| `bb factory verdict APP-12 --role review1\|review2\|security --verdict approve\|changes [--pr N]` | Record a reviewer's verdict on the task's PR, after posting it as a PR comment. |
| `bb factory block APP-12 --reason "..."` | Mark the task Blocked and record why. |
| `bb factory unblock APP-12 [--note "..."]` | Clear Blocked. |
| `bb factory status [APP]` | Print the board, the agents on each task, and each task's branch or PR with its verdicts. |

Add `--json` to `list`, `create`, `start`, `assign` and `status` when the
output drives code.

Tasks themselves are managed with `bb tasks` (`create`, `show`, `update
--status`, `comment`, `attach`). The prefix of a task key names its factory.

## Settings

`bb plugin config factory` shows them: the provider for each role, agent
permissions, automatic PR reviews on or off, the changed-line threshold for
Reviewer 2, and the secret Rafter API key and optional GitHub token for Rafter.

## Rules

- Spawn factory agents only with `bb factory assign`, never with `bb thread
  spawn`, so they appear on the board and report to the Lead.
- Assign a Builder before QA or a reviewer: they check the builder's worktree.
- Blocked is a label on top of the status. Use `bb factory block`, not a
  status change, and always give the reason.
- The Lead may push builder branches and open draft PRs. Never merge, force-push
  or push to the base branch; merging is the user's decision.
