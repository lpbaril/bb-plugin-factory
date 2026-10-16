---
name: software-factory
description: Run or work in a bb software factory with the `bb factory` CLI. Use when the user asks to create a factory, start its Lead, assign a task to a builder, QA, designer or reviewer agent, mark a task blocked, or see the factory board; or when your own prompt says you are the Lead or a specialist of a factory.
---

# Software factory

A factory ties one bb project to one Tasks tracker project. Its **Lead** thread
shapes work into tasks and assigns them to **specialists** (Builder, QA,
Designer, Reviewer 1, Reviewer 2). Each specialist runs as the Lead's child
thread, so the Lead is notified when it finishes. The **Factory** page in the
left navigation rail shows the agents and a board with the columns Backlog,
To do, In progress, In review, Done and Blocked.

## Commands

| Command | Effect |
| --- | --- |
| `bb factory list` | List factories with their prefix, project and Lead. |
| `bb factory create --prefix APP [--project proj_...] [--name "..."]` | Create a factory and its Tasks tracker (or reuse a tracker with that prefix). The project defaults to the current thread's. |
| `bb factory start APP [--goal "..."]` | Start the Lead thread. |
| `bb factory assign APP-12 --role build\|qa\|design\|review1\|review2 [--instructions "..."]` | Spawn a specialist for the task as the Lead's child. Builder and Designer get a new worktree; QA and reviewers reuse the task's builder worktree. Moves the task to In progress (build, design) or In review (qa, reviews). |
| `bb factory block APP-12 --reason "..."` | Mark the task Blocked and record why. |
| `bb factory unblock APP-12 [--note "..."]` | Clear Blocked. |
| `bb factory status [APP]` | Print the board and the agents on each task. |

Add `--json` to `list`, `create`, `start`, `assign` and `status` when the
output drives code.

Tasks themselves are managed with `bb tasks` (`create`, `show`, `update
--status`, `comment`, `attach`). The prefix of a task key names its factory.

## Rules

- Spawn factory agents only with `bb factory assign`, never with `bb thread
  spawn`, so they appear on the board and report to the Lead.
- Assign a Builder before QA or a reviewer: they check the builder's worktree.
- Blocked is a label on top of the status. Use `bb factory block`, not a
  status change, and always give the reason.
- Only the Lead moves a task to Done.
- Never merge, push or open a pull request without the user's OK.
