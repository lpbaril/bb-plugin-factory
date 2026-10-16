A software factory inside bb: a Lead agent that turns what you want into
tasks, specialist agents that build, test, design and review them, and a live
board that shows who is working on what.

## What you get

- A **Factory** page in the left navigation rail. The top shows every agent in
  the factory with its live status (working, needs you, idle, error); click
  one to open its thread. Below it is a board with the columns Backlog, To do,
  In progress, In review, Done and Blocked. Drag cards between columns, add
  tasks, or open a task to read it and assign it to an agent.
- A `bb factory` command that agents and you use to create factories, start
  the Lead, assign tasks, and mark work blocked.
- A Lead plus five specialists: Builder, QA, Designer, Reviewer 1 and
  Reviewer 2. Choose Claude Code or Codex for each role in the plugin
  settings.

## How it works

Each factory links one bb project to one project in bb's Tasks tracker, so
tasks also show in the Tasks page. The Lead runs in the project checkout.
Builders and designers each get their own Git worktree, and QA and reviewers
work in the builder's worktree for the same task. Every specialist is a child
thread of the Lead, so the Lead hears when it finishes. Agents never merge or
push without your OK.

The role prompts and team culture are adapted from OpenRig's factory team
(Apache-2.0).
