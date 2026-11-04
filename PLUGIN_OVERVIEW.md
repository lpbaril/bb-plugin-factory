## What you get

- **A Factory page in the navigation rail.** See agents, alignment, health and a board with PR verdicts. Open cards to see activity and assign agents.
- **Greenfield and Brownfield onboarding.** The factory detects whether the repo is new or existing, scaffolds missing alignment files (`AGENTS.md`, a constitution, architecture and roadmap docs) without overwriting existing ones, and gives the Lead the matching playbook.
- **A Lead you talk to.** Tell it what you want built. It starts specialists: Planner, Builder, QA and Designer. The on-demand Planner writes acceptance criteria and a plan. Once a task has a Planner, no Builder starts until it signs off; small fixes can skip planning.
- **Automatic PR review.** When a builder is done, the Lead opens a draft PR. The factory then starts Reviewer 1 and a Security reviewer, plus Reviewer 2 when the diff is large or touches sensitive paths. Each posts APPROVE or REQUEST CHANGES on the PR. The Lead sends all findings to the builder in one message; new commits re-run the Security reviewer and any reviewer who asked for changes, over just the new delta. When every verdict is APPROVE on the latest commit, the factory marks the PR ready, which runs your full CI, and warns the Lead if another open PR touches the same files. After the merge, the card moves to Done.
- **An evidence contract.** On for new factories: QA can block a PR, and approvals account for every file.
- **Optional Rafter scans.** With a Rafter API key, each PR branch is scanned for the Security reviewer.
- **An optional shadow reviewer.** Run a second Security reviewer on another model next to the incumbent, for the next N PRs or every sensitive PR.
- **Run ledger, Health and a nightly check.** See turns, tokens and verdicts by model, plus review rounds and cost per merged task. Stalled work is flagged nightly.

## How it works

A factory ties one bb project to one bb Tasks project, so tasks also appear on the Tasks page. Builders and designers each get their own worktree, and QA and reviewers work in the builder's worktree for the same task. In the Agents section of the plugin settings, pick each role's provider (Claude Code, Codex or Cursor), model and reasoning level. Reviewer 1 defaults to a second provider when you have one, and the factory warns if the Builder and all required reviewers share one.

Agents use the `bb factory` command: `create`, `start`, `doctor`, `init-specs`, `reconcile`, `assign`, `plan-ready`, `verdict`, `block`, `status`, `agents`, `archive`, `restore`, `merge`, `qa`, `runs`, `health`, `lessons`, `rafter check` and `shadow compare`. Delete a factory only from the Factory page.

## Requirements

- A Git repository added to bb as a project.
- Accounts for the agent CLIs you pick per role. Agents use their own subscription or API quota, and several run at once.
- For PR review: a GitHub remote and the `gh` CLI signed in on the project's machine. The factory only reviews same-repository PRs that your `gh` account opened.
- Optional: a Rafter account (https://rafter.so). Scans send the PR branch to Rafter's servers and use your scan quota, two scans per PR.

## Safety

- You merge by default. Set a factory to `when-green` and its Lead may merge once approvals and CI pass on the exact head, except large or sensitive PRs. This is a rule, not a security boundary.
- New agents start in auto mode, so commands outside the sandbox ask for approval. Setting Agent permissions to full removes every approval: agents can then run any command on the machine.
- A verdict counts only when the reviewer thread the factory started for that PR records it, so a builder can't approve its own work.
- The plugin's host worker runs only `gh pr list`, `view`, `ready`, `comment` and `merge`.
- Rafter output and PR content are passed to reviewers as untrusted data.

## Credits

The role prompts and team culture are adapted from OpenRig (https://github.com/mvschwarz/openrig), under the Apache License 2.0.
