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
| `bb factory list` | List factories with their prefix, project and Lead; archived ones are marked `[archived]`. |
| `bb factory archive APP` | Archive a factory: it leaves the Factory page tabs, takes no new agents, and gets no automatic PR reviews. |
| `bb factory restore APP` | Restore an archived factory. Deleting a factory is only possible from the Factory page. |
| `bb factory create --prefix APP [--project proj_...] [--name "..."]` | Create a factory and its Tasks tracker (or reuse a tracker with that prefix). The project defaults to the current thread's. |
| `bb factory start APP [--goal "..."]` | Start the Lead thread. |
| `bb factory assign APP-12 --role build\|qa\|design\|review1\|review2\|security [--instructions "..."]` | Spawn a specialist for the task as the Lead's child. Builder and Designer get a new worktree; the others reuse the task's builder worktree. PR reviewers are normally started automatically instead. |
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

`bb plugin config factory` shows them: the provider for each role, agent
permissions, automatic PR reviews on or off, the changed-line threshold for
Reviewer 2, the secret Rafter API key and optional GitHub token for Rafter, and
the shadow security reviewer (provider, model, and when it runs: off, the next N
PRs, or every sensitive PR, judged by changed paths and the PR title). The shadow
reviewer posts only task comments, and a comparison thread scores it against the
incumbent. With **Shadow REQUEST CHANGES blocks the ready gate** on, its REQUEST
CHANGES keeps the PR in draft until a new commit fixes it (the shadow re-reviews)
or the Security reviewer or the person dismisses it with a reason. The Lead sends
real findings to the builder; it never dismisses them.

## Rules

- Spawn factory agents only with `bb factory assign`, never with `bb thread
  spawn`, so they appear on the board and report to the Lead.
- Assign a Builder before QA or a reviewer: they check the builder's worktree.
- Blocked is a label on top of the status. Use `bb factory block`, not a
  status change, and always give the reason.
- The Lead may push builder branches and open draft PRs. Never merge, force-push
  or push to the base branch; merging is the user's decision.
