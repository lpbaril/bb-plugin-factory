# bb-plugin-factory

A software factory for [bb](https://getbb.app): a Lead agent, five specialist
agents, and a kanban board of their tasks, in the left navigation rail.

See [PLUGIN_OVERVIEW.md](PLUGIN_OVERVIEW.md) for what it does and
[skills/software-factory/SKILL.md](skills/software-factory/SKILL.md) for the
`bb factory` commands.

## Develop

```sh
npm install
npx tsc --noEmit -p .
bb plugin install .   # registers this directory in place
bb plugin dev         # rebuild and reload on save
```

## Files

- `server.ts`: factory storage, the `bb factory` CLI, the page's RPC, and the
  board change feed. Tasks are read and moved through the built-in Tasks
  plugin's RPC.
- `roles.ts`: the Lead and specialist prompts.
- `app.tsx`: the Factory page.

The role prompts and culture are adapted from
[OpenRig](https://github.com/mvschwarz/openrig)'s factory team (Apache-2.0).
