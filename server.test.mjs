import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { createFakePluginHost, makeThreadResponse, makeTurnFailedEvent } from '@get-bb/plugin-sdk/testing';

// Run the plugin's bundler-style TypeScript imports using Node's type stripping.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('./') && !/\.[a-z]+$/.test(specifier)) {
    return next(`${specifier}.ts`, context);
  }
  return next(specifier, context);
} });
const { default: plugin, supervisorAction } = await import('./server.ts');
const { createFactoryStorage } = await import('./factory-storage.ts');

const failure = (category, httpStatusCode = null, attemptNumber = 1) =>
  makeTurnFailedEvent({ attemptNumber, errorInfo: { category, httpStatusCode } });

test('BB owns transient provider failures throughout and after its retry budget', () => {
  for (const attempt of [1, 2, 5, 6]) {
    for (const category of ['overloaded', 'rate-limit', 'connection-failed', 'internal', 'stream-disconnected']) {
      assert.equal(supervisorAction(failure(category, null, attempt)), 'leave');
    }
    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(supervisorAction(failure('unknown', status, attempt)), 'leave');
    }
  }
});

test('Factory still retries interruptions once and escalates permanent failures', () => {
  assert.equal(supervisorAction(makeTurnFailedEvent({ errorInfo: null, attemptNumber: 1 })), 'retry');
  assert.equal(supervisorAction(makeTurnFailedEvent({ errorInfo: null, attemptNumber: 2 })), 'escalate');
  for (const category of ['unauthorized', 'billing', 'policy', 'budget-exceeded', 'bad-request', 'context-window-exceeded']) {
    assert.equal(supervisorAction(failure(category)), 'escalate');
  }
});

async function fixture(t, fallback = false, initial = {}, overrides = {}) {
  const spawns = [];
  const failureEffects = [];
  const comments = [];
  const messages = [];
  const task = { id: 'task_1', key: 'TEST-1', projectId: 'tracker', title: 'Test', description: '', status: 'in_review', priority: 'none', position: 0, labelIds: [], createdAt: '', updatedAt: '' };
  const { bb, harness } = createFakePluginHost({
    pluginId: 'factory', settings: { superviseAgents: true },
    experimental_callHostRpc: overrides.hostRpc,
    sdk: {
      projects: { get: async () => ({ name: 'Test', gitRemoteUrl: 'https://github.com/owner/repo.git', sources: [{ hostId: 'host_test', isDefault: true, path: overrides.projectPath ?? null }] }) },
      providers: { models: async () => ({ models: [] }) },
      threads: {
        get: async () => makeThreadResponse({ id: 'thr_builder', environmentId: 'env_builder' }),
        spawn: async args => {
          spawns.push(args);
          if (fallback && args.environment.type === 'host') throw new Error('No worktree');
          return makeThreadResponse({ id: `thr_spawned_${spawns.length}` });
        },
        send: async args => { messages.push(args); return {}; },
        retry: async () => { failureEffects.push('retry'); return {}; },
        ...overrides.threads,
      },
      plugins: { callRpc: async ({ method, input }) => {
        if (overrides.tasksRpc) {
          const custom = await overrides.tasksRpc({ method, input });
          if (custom !== undefined) return custom;
        }
        if (method === 'listComments') return { comments };
        if (method === 'getTaskByKey') return { task };
        if (method === 'createComment') return { comment: { id: 'comment', kind: 'system', authorName: 'Factory', threadId: null, body: input.body, createdAt: '' } };
        failureEffects.push(method);
        throw new Error(`Unexpected Tasks mutation: ${method}`);
      } },
    },
  });
  t.after(() => harness.lifecycle.dispose());
  await bb.storage.kv.set('agents-migrated', true);
  const factory = {
    prefix: 'TEST', name: 'Test', bbProjectId: 'proj_test', trackerProjectId: 'tracker', blockedLabelId: 'blocked', leadThreadId: 'thr_lead', createdAt: '',
    prs: [], plans: [], repo: null, archivedAt: null,
    agents: [{ threadId: 'thr_builder', role: 'build', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: null }],
    ...initial,
  };
  if (Buffer.byteLength(JSON.stringify(factory)) > 262144) await createFactoryStorage(bb.storage, value => value).write(factory);
  else await bb.storage.kv.set('factory:TEST', factory);
  await plugin(bb);
  return { bb, harness, spawns, failureEffects, comments, messages };
}

test('failure handler leaves later BB retries alone without blocking the task', async t => {
  const { harness, failureEffects } = await fixture(t);
  for (const attemptNumber of [1, 2, 5]) {
    await harness.behavior.emitThreadEvent('turn.failed', {
      ...failure('connection-failed', null, attemptNumber), threadId: 'thr_builder',
    });
  }
  assert.deepEqual(failureEffects, []);
});

for (const role of ['plan', 'build', 'qa', 'review1', 'review2', 'security', 'design']) {
  test(`${role} receives explicit parent notifications`, async t => {
    const { harness, spawns } = await fixture(t);
    await harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role, instructions: null });
    assert.equal(spawns.length, 1);
    assert.equal(spawns[0].parentNotifications, role === 'shadow' ? 'off' : 'auto');
    assert.equal(spawns[0].parentThreadId, role === 'shadow' ? undefined : 'thr_lead');
  });
}

test('project-checkout fallback preserves completion notifications', async t => {
  const { harness, spawns } = await fixture(t, true);
  await harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role: 'build', instructions: null });
  assert.equal(spawns.length, 2);
  assert.equal(spawns[1].environment.type, 'project-default');
  assert.equal(spawns[1].parentNotifications, 'auto');
  assert.equal(spawns[1].parentThreadId, 'thr_lead');
});

const planningDocument = {
  id: 'plan_comment', kind: 'agent', authorName: 'Planner', threadId: 'thr_spawned_1', createdAt: '',
  body: 'Factory plan: READY\n## Problem and scope\nFix the bug; no redesign.\n## Acceptance criteria\nThe regression test passes.\n## Implementation plan\nReproduce, fix, test.\n## Dependencies\nNone.\n## Open questions\nNone blocking.',
};

test('Planner defaults to Opus, reads the project and gates builders until its durable plan is ready', async t => {
  const { harness, spawns, comments } = await fixture(t);
  await harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role: 'plan', instructions: null });
  assert.equal(spawns[0].model, 'claude-opus-5-5');
  assert.equal(spawns[0].reasoningLevel, 'high');
  assert.equal(spawns[0].environment.type, 'project-default');
  await assert.rejects(harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role: 'build', instructions: null }));
  assert.equal(spawns.length, 1);
  comments.push(planningDocument);
  const denied = await harness.behavior.runCli(['plan-ready', 'TEST-1', '--comment', 'plan_comment'], { threadId: 'thr_lead' });
  assert.notEqual(denied.exitCode, 0);
  const ready = await harness.behavior.runCli(['plan-ready', 'TEST-1', '--comment', 'plan_comment'], { threadId: 'thr_spawned_1' });
  assert.equal(ready.exitCode, 0, JSON.stringify(ready));
  await harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role: 'build', instructions: null });
  assert.match(spawns[1].prompt, /Canonical plan for TEST-1: task comment plan_comment/);
});

test('incomplete or foreign planning comments cannot unlock a build', async t => {
  const { harness, comments } = await fixture(t);
  await harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role: 'plan', instructions: null });
  for (const document of [
    { ...planningDocument, threadId: 'thr_other' },
    { ...planningDocument, body: 'Factory plan: DRAFT' },
    { ...planningDocument, body: 'Factory plan: READY' },
  ]) {
    comments.splice(0, comments.length, document);
    const result = await harness.behavior.runCli(['plan-ready', 'TEST-1', '--comment', 'plan_comment'], { threadId: 'thr_spawned_1' });
    assert.notEqual(result.exitCode, 0);
  }
  await assert.rejects(harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role: 'build', instructions: null }));
});

test('replanning invalidates an old sign-off and survives plugin reload', async t => {
  const { bb, harness, comments } = await fixture(t);
  const assign = role => harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role, instructions: null });
  await assign('plan');
  comments.push(planningDocument);
  await harness.behavior.runCli(['plan-ready', 'TEST-1', '--comment', 'plan_comment'], { threadId: 'thr_spawned_1' });
  await assign('plan');
  assert.equal(JSON.parse(bb.storage.database().prepare("SELECT payload FROM factory_records WHERE prefix='TEST' AND kind='plan'").get().payload).commentId, null);
  await harness.lifecycle.reload(plugin);
  const stale = await harness.behavior.runCli(['plan-ready', 'TEST-1', '--comment', 'plan_comment'], { threadId: 'thr_spawned_1' });
  assert.notEqual(stale.exitCode, 0);
  await assert.rejects(assign('build'));
});

const trackedPr = {
  number: 1, url: 'https://example.com/pr/1', taskKey: 'TEST-1', branch: 'build', headSha: 'abc123',
  isDraft: true, state: 'open', deep: false, reviews: [], scans: [], readyRequested: false, openedAt: '',
};

test('tracked PR reviewer sends only stuck notifications, with one alert for a missing verdict', async t => {
  const { harness, spawns, messages } = await fixture(t, false, { prs: [trackedPr] });
  const assigned = await harness.behavior.runCli(['assign', 'TEST-1', '--role', 'review1', '--pr', '1']);
  assert.equal(assigned.exitCode, 0, JSON.stringify(assigned));
  assert.equal(spawns[0].parentNotifications, 'stuck');
  assert.match(spawns[0].prompt, /routine final replies are suppressed/);
  for (let i = 0; i < 2; i++) {
    await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_spawned_1' }), lastAssistantText: 'Done' });
  }
  assert.equal(messages.length, 1);
  assert.match(messages[0].input[0].text, /stopped without recording a verdict/);
});

test('verdict and reviewer assignment work with 225 tasks and 12 agents each; approved reviewers do not trigger stall alerts', async t => {
  const agents = [{ threadId: 'thr_builder', role: 'build', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: null }];
  const prs = [];
  for (let i = 1; i <= 225; i++) {
    for (let j = 0; j < 12; j++) agents.push({ ...agents[0], threadId: `worker_${i}_${j}`, taskKey: `TEST-${i}` });
    prs.push({ ...trackedPr, number: i, taskKey: `TEST-${i}`, state: i === 1 ? 'open' : 'merged', reviews: [] });
  }
  const { bb, harness, messages } = await fixture(t, false, { agents, prs });
  assert.equal((await harness.behavior.runCli(['assign', 'TEST-1', '--role', 'review1', '--pr', '1'])).exitCode, 0);
  const verdict = await harness.behavior.runCli(['verdict', 'TEST-1', '--role', 'review1', '--verdict', 'approve', '--pr', '1'], { threadId: 'thr_spawned_1' });
  assert.equal(verdict.exitCode, 0, JSON.stringify(verdict));
  await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_spawned_1' }), lastAssistantText: 'APPROVE' });
  assert.equal(messages.length, 0);
  assert.ok(Buffer.byteLength(JSON.stringify(await bb.storage.kv.get('factory:TEST'))) < 100);
  const db = bb.storage.database();
  assert.equal(db.prepare("SELECT count(*) AS n FROM factory_records WHERE kind='agent'").get().n, agents.length + 1);
  const reviews = db.prepare("SELECT payload FROM factory_records WHERE kind='review' ORDER BY position").all().map(row => JSON.parse(row.payload));
  assert.equal(reviews.at(-1).verdict, 'approve');
  assert.equal(reviews.at(-1).threadId, 'thr_spawned_1');
});

test('assign --pr tracks a missing PR by builder branch; --track-only never spawns or writes GitHub', async t => {
  const calls = [];
  const gp = { number: 81, url: 'https://github.com/owner/repo/pull/81', title: 'Fix', headRefName: 'build-branch', headRefOid: 'abc123', isDraft: true, additions: 350, deletions: 0, isCrossRepository: false, state: 'OPEN' };
  const { bb, harness, spawns } = await fixture(t, false, {}, {
    threads: { list: async () => [{ id: 'thr_builder', environmentBranchName: 'build-branch' }] },
    hostRpc: async ({ input }) => {
      calls.push(input.args);
      assert.deepEqual(input.args.slice(0, 2), ['pr', 'view']);
      return { code: 0, stdout: JSON.stringify(input.args.at(-1) === 'files' ? { files: [] } : gp), stderr: '' };
    },
  });
  const result = await harness.behavior.runCli(['assign', 'TEST-1', '--role', 'review1', '--pr', '81', '--track-only', '--json']);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.equal(JSON.parse(result.stdout).reviewerStarted, false);
  assert.equal(spawns.length, 0);
  assert.equal(calls.length, 2);
  assert.equal(bb.storage.database().prepare("SELECT count(*) AS n FROM factory_records WHERE kind='pr'").get().n, 1);
  const assigned = await harness.behavior.runCli(['assign', 'TEST-1', '--role', 'review1', '--pr', '81']);
  assert.equal(assigned.exitCode, 0, JSON.stringify(assigned));
  assert.equal(spawns.length, 1);
});

test('an unrelated or fork PR cannot be attached to a task', async t => {
  for (const isCrossRepository of [true, false]) {
    const { harness, spawns } = await fixture(t, false, {}, {
      threads: { list: async () => [{ id: 'thr_builder', environmentBranchName: 'other-branch' }] },
      hostRpc: async () => ({ code: 0, stdout: JSON.stringify({ number: 81, url: 'https://github.com/owner/repo/pull/81', title: 'Fix', headRefName: 'unrelated', headRefOid: 'abc', isDraft: true, additions: 0, deletions: 0, isCrossRepository, state: 'OPEN' }), stderr: '' }),
    });
    assert.notEqual((await harness.behavior.runCli(['assign', 'TEST-1', '--role', 'review1', '--pr', '81'])).exitCode, 0);
    assert.equal(spawns.length, 0);
  }
});

test('recover-agent reattaches only a matching Factory thread and is idempotent', async t => {
  const thread = makeThreadResponse({ id: 'orphan', projectId: 'proj_test', providerId: 'codex', originPluginId: 'factory', createdAt: 1000 });
  let metadata = { factory: 'TEST', taskKey: 'TEST-1', role: 'build' };
  const { bb, harness, spawns, messages } = await fixture(t, false, {}, { threads: {
    get: async () => thread, getPluginMetadata: async () => metadata,
  } });
  for (let i = 0; i < 2; i++) {
    const result = await harness.behavior.runCli(['recover-agent', 'TEST-1', '--thread', 'orphan']);
    assert.equal(result.exitCode, 0, JSON.stringify(result));
  }
  assert.equal(bb.storage.database().prepare("SELECT count(*) AS n FROM factory_records WHERE kind='agent'").get().n, 2);
  assert.equal(spawns.length, 0);
  assert.equal(messages.length, 0);
  metadata = { ...metadata, taskKey: 'TEST-2' };
  assert.notEqual((await harness.behavior.runCli(['recover-agent', 'TEST-1', '--thread', 'orphan'])).exitCode, 0);
});

test('pausing one factory prevents automatic PR actions while leaving verdict commands available', async t => {
  let reads = 0;
  const { bb, harness } = await fixture(t, false, {}, { hostRpc: async () => { reads++; throw new Error('PR actions must be paused'); } });
  const paused = await harness.behavior.runCli(['reviews', 'pause', 'TEST']);
  assert.equal(paused.exitCode, 0, JSON.stringify(paused));
  assert.equal(await bb.storage.kv.get('pr-watch-paused:TEST'), true);
  await harness.behavior.setSettings({ prReviews: true });
  const service = harness.behavior.runService('pr-watch');
  await new Promise(resolve => setTimeout(resolve, 50));
  service.controller.abort();
  await service.done;
  assert.equal(reads, 0);
  assert.equal((await harness.behavior.runCli(['reviews', 'resume', 'TEST'])).exitCode, 0);
  assert.equal(await bb.storage.kv.get('pr-watch-paused:TEST'), undefined);
});

test('concurrent planning and builder assignments cannot bypass pending planning', async t => {
  const { harness, spawns } = await fixture(t);
  const results = await Promise.allSettled(['plan', 'build'].map(role => harness.behavior.callRpc('task_assign', { taskKey: 'TEST-1', role, instructions: null })));
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(spawns.length, 1);
});

test('existing agent choices survive the new Planner default', async t => {
  const { bb, harness } = await fixture(t);
  await bb.storage.kv.set('agents', {
    roles: { lead: { providerId: 'acp-opencode', model: 'synthetic/hf:zai-org/GLM-5.3', reasoningLevel: 'high' } },
    shadowCustomModel: null,
  });
  const view = await harness.behavior.callRpc('agents_get', null);
  assert.equal(view.agents.find(a => a.key === 'lead').exec.model, 'synthetic/hf:zai-org/GLM-5.3');
  assert.equal(view.agents.find(a => a.key === 'plan').exec.model, 'claude-opus-5-5');
});

test('standing role instructions preserve the split after compaction', async () => {
  const { leadCharter, workerReminder } = await import('./roles.ts');
  const charter = leadCharter({ factoryName: 'Test', prefix: 'TEST' });
  assert.ok(charter.length < 4096);
  assert.match(charter, /Planner owns PRDs/);
  assert.match(charter, /Never change acceptance criteria or waive review gates/);
  assert.match(charter, /constitution\.md/);
  assert.match(workerReminder({ role: 'plan', factoryName: 'Test', taskKey: 'TEST-1' }), /plan-ready/);
  assert.match(workerReminder({ role: 'review1', factoryName: 'Test', taskKey: 'TEST-1' }), /constitution\.md/);
});

test('doctor detects brownfield mode, missing alignment files, merged PR tasks, and idle in-progress tasks; reconcile heals and notifies Lead', async t => {
  const tasks = [
    { id: 't1', key: 'TEST-1', projectId: 'tracker', title: 'Merged task still in progress', description: '', status: 'in_progress', priority: 'high', position: 0, labelIds: [], createdAt: '', updatedAt: '' },
    { id: 't2', key: 'TEST-2', projectId: 'tracker', title: 'Archived designer task', description: '', status: 'in_progress', priority: 'medium', position: 1, labelIds: [], createdAt: '', updatedAt: '' },
    { id: 't3', key: 'TEST-3', projectId: 'tracker', title: 'Plan ready task', description: '', status: 'in_progress', priority: 'medium', position: 2, labelIds: [], createdAt: '', updatedAt: '' },
  ];
  const { harness, messages } = await fixture(
    t,
    false,
    {
      prs: [{ ...trackedPr, number: 51, taskKey: 'TEST-1', state: 'merged', isDraft: false }],
      plans: [{ taskKey: 'TEST-3', threadId: 'thr_planner', commentId: 'comment_ready_1' }],
      agents: [
        { threadId: 'thr_builder', role: 'build', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: null },
        { threadId: 'thr_designer_archived', role: 'design', taskKey: 'TEST-2', providerId: 'claude-code', createdAt: '', pr: null },
        { threadId: 'thr_planner', role: 'plan', taskKey: 'TEST-3', providerId: 'claude-code', createdAt: '', pr: null },
      ],
    },
    {
      projectPath: '/repo/test',
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: 'idle',
            archivedAt: threadId === 'thr_designer_archived' ? Date.now() : null,
          }),
      },
      hostRpc: async ({ method }) => {
        if (method === 'inspect_repo') {
          return {
            exists: true,
            isGitRepo: true,
            commitCount: 120,
            sourceDirs: ['crates', 'engine'],
            detectedMode: 'brownfield',
            files: { agentsMd: null, constitution: null, specs: 'docs/architecture.md', roadmap: 'docs/roadmap.md' },
            existingDocs: ['docs/architecture.md', 'docs/roadmap.md'],
          };
        }
        if (method === 'scaffold_specs') {
          return {
            created: ['AGENTS.md', '.specify/memory/constitution.md'],
            existing: ['docs/architecture.md', 'docs/roadmap.md'],
          };
        }
        throw new Error(`Unexpected host call: ${method}`);
      },
      tasksRpc: async ({ method, input }) => {
        if (method === 'listTasks') return { tasks };
        if (method === 'getTask') return { task: tasks.find(x => x.id === input.taskId) ?? null };
        if (method === 'boardMove') {
          const found = tasks.find(x => x.id === input.taskId);
          if (found) found.status = input.status;
          return { ok: true, task: found };
        }
        return undefined;
      },
    },
  );

  const docRes = await harness.behavior.runCli(['doctor', 'TEST', '--json']);
  assert.equal(docRes.exitCode, 0, JSON.stringify(docRes));
  const report = JSON.parse(docRes.stdout);
  assert.equal(report.effectiveMode, 'brownfield');
  assert.equal(report.boardHealth.mergedPrsStillOpenTasks.length, 1);
  assert.equal(report.boardHealth.mergedPrsStillOpenTasks[0].taskKey, 'TEST-1');
  assert.equal(report.boardHealth.inProgressWithoutLiveWorker.length, 2);
  assert.equal(report.boardHealth.readyPlansAwaitingBuilder.length, 1);
  assert.equal(report.boardHealth.readyPlansAwaitingBuilder[0].taskKey, 'TEST-3');

  const initRes = await harness.behavior.runCli(['init-specs', 'TEST', '--json']);
  assert.equal(initRes.exitCode, 0, JSON.stringify(initRes));
  assert.deepEqual(JSON.parse(initRes.stdout).created, ['AGENTS.md', '.specify/memory/constitution.md']);

  const recRes = await harness.behavior.runCli(['reconcile', 'TEST', '--notify-lead', '--json']);
  assert.equal(recRes.exitCode, 0, JSON.stringify(recRes));
  const rec = JSON.parse(recRes.stdout);
  assert.deepEqual(rec.reconciledMoveToDone, ['TEST-1']);
  assert.equal(rec.leadNotified, true);
  assert.equal(tasks[0].status, 'done');
  assert.equal(messages.length, 1);
  assert.match(messages[0].input[0].text, /Auto-moved merged PR task\(s\) to Done: TEST-1/);
});

test('startLead injects Greenfield or Brownfield playbook and optional spec scaffolding', async t => {
  const scaffoldCalls = [];
  const { harness, spawns } = await fixture(
    t,
    false,
    { leadThreadId: null, agents: [] },
    {
      projectPath: '/repo/green',
      hostRpc: async ({ method, input }) => {
        if (method === 'scaffold_specs') {
          scaffoldCalls.push(input);
          return { created: ['AGENTS.md', '.specify/memory/constitution.md'], existing: [] };
        }
        if (method === 'inspect_repo') {
          return {
            exists: true,
            isGitRepo: true,
            commitCount: 1,
            sourceDirs: [],
            detectedMode: 'greenfield',
            files: {
              agentsMd: 'AGENTS.md',
              constitution: '.specify/memory/constitution.md',
              specs: 'docs/architecture.md',
              roadmap: 'docs/roadmap.md',
            },
            existingDocs: ['AGENTS.md', '.specify/memory/constitution.md'],
          };
        }
        throw new Error(`Unexpected host call: ${method}`);
      },
    },
  );
  const started = await harness.behavior.runCli(['start', 'TEST', '--mode', 'greenfield', '--init-specs']);
  assert.equal(started.exitCode, 0, JSON.stringify(started));
  assert.equal(scaffoldCalls.length, 1);
  assert.equal(scaffoldCalls[0].mode, 'greenfield');
  assert.equal(spawns.length, 1);
  assert.match(spawns[0].prompt, /Greenfield Onboarding Playbook/);
  assert.match(spawns[0].prompt, /constitution\.md/);
});
