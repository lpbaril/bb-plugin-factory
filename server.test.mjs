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
const { default: plugin, supervisorAction, turnsFromEvents, creditUsage, mergeBlockers } = await import('./server.ts');
const { leadCharter, workerReminder } = await import('./roles.ts');
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
  assert.deepEqual(report.boardHealth.inProgressWithoutLiveWorker.map(task => task.taskKey), ['TEST-2'], 'the Planner-only task is reported as a READY plan instead');
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

// ----- Run ledger -----

const requested = (seq, model = 'gpt-test') => ({ seq, type: 'client/turn/requested', createdAt: seq * 1000, data: { execution: { model, reasoningLevel: 'high' } } });
const started = seq => ({ seq, type: 'turn/started', createdAt: seq * 1000, data: {} });
const completed = (seq, status = 'completed', error) => ({ seq, type: 'turn/completed', createdAt: seq * 1000, data: { status, ...(error ? { error: { message: error } } : {}) } });
const usage = (seq, totalTokens, cachedInputTokens = 0, outputTokens = 0) => ({ seq, type: 'thread/tokenUsage/updated', createdAt: seq * 1000, data: { tokenUsage: { total: { totalTokens, cachedInputTokens, outputTokens } } } });
/** Answers threads.events.list from a mutable log, honoring its filters and the real server's page limit. */
const eventLog = events => ({
  events: { list: async ({ afterSeq = '0', types, order, limit }) => {
    if (limit !== undefined && Number(limit) > 100) throw new Error('Thread event limit cannot exceed 100');
    let rows = events.filter(event => event.seq > Number(afterSeq) && (types === undefined || types.includes(event.type)));
    if (order === 'desc') rows = [...rows].reverse();
    return limit === undefined ? rows : rows.slice(0, Number(limit));
  } },
});

test('turnsFromEvents records finished turns and leaves a running one unread', () => {
  const finished = turnsFromEvents([requested(1, 'model-a'), started(2), completed(3), requested(4, 'model-b'), started(5)]);
  assert.equal(finished.closedSeq, 3);
  assert.equal(finished.openStartSeq, 5);
  assert.deepEqual(finished.turns, [{ startSeq: 2, startedAt: 2000, model: 'model-a', reasoning: 'high', outcome: 'completed', error: null, endSeq: 3, endedAt: 3000 }]);
});

test('turnsFromEvents marks cut-off turns interrupted and failed turns failed', () => {
  const cutOff = turnsFromEvents([started(1), requested(2), started(3), completed(4, 'failed', 'boom')]);
  assert.deepEqual(cutOff.turns.map(turn => [turn.outcome, turn.endSeq, turn.error]), [['interrupted', 2, null], ['failed', 4, 'boom']]);
  const open = turnsFromEvents([started(1), { seq: 2, type: 'client/turn/requested', createdAt: 2000, data: {} }], 'unauthorized');
  assert.deepEqual(open.turns.map(turn => [turn.outcome, turn.error, turn.endSeq]), [['failed', 'unauthorized', 2]]);
  assert.equal(open.closedSeq, 2);
  assert.equal(open.openStartSeq, null);
  assert.deepEqual(turnsFromEvents([], 'unauthorized'), { turns: [], closedSeq: null, openStartSeq: null });
});

test('the ledger records each turn once and credits token growth to the newest turn', async t => {
  const events = [requested(1), started(2), completed(3), requested(4), started(5), usage(6, 1000, 700, 100), completed(7)];
  const { harness } = await fixture(t, false, {}, { threads: { ...eventLog(events) } });
  const idle = { thread: makeThreadResponse({ id: 'thr_builder' }), lastAssistantText: null };
  await harness.behavior.emitThreadEvent('thread.idle', idle);
  await harness.behavior.emitThreadEvent('thread.idle', idle);
  let report = await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null });
  assert.equal(report.recent.length, 2);
  assert.deepEqual(report.recent.map(run => run.tokensTotal), [1000, null]);
  assert.equal(report.groups[0].runs, 2);
  assert.equal(report.groups[0].tokensCached, 700);

  events.push(requested(8), started(9), usage(10, 1500, 900, 150), completed(11));
  await harness.behavior.emitThreadEvent('thread.idle', idle);
  report = await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null });
  assert.deepEqual(report.recent[0], { ...report.recent[0], tokensTotal: 500, tokensCached: 200, tokensOutput: 50, model: 'gpt-test', role: 'build', taskKey: 'TEST-1', outcome: 'completed' });
  assert.equal(report.groups[0].tokensTotal, 1500);

  // A provider session restart lowers the total; everything in the new session counts.
  events.push(started(12), usage(13, 40, 0, 10), completed(14));
  await harness.behavior.emitThreadEvent('thread.idle', idle);
  report = await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null });
  assert.equal(report.recent[0].tokensTotal, 40);

  assert.equal((await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: 'TEST-2' })).groups.length, 0);
});

test('the ledger pages through a thread longer than one page of events', async t => {
  const events = [];
  for (let turn = 0; turn < 120; turn++) events.push(started(turn * 2 + 1), completed(turn * 2 + 2));
  const { harness } = await fixture(t, false, {}, { threads: { ...eventLog(events) } });
  await harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_builder' }), lastAssistantText: null });
  const { groups } = await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null });
  assert.equal(groups[0].runs, 120);
});

const noTokens = { tokensTotal: 0, tokensCached: 0, tokensOutput: 0 };
const turnAt = (startSeq, endSeq) => ({ startSeq, endSeq, startedAt: 0, endedAt: 0, model: null, reasoning: null, outcome: 'completed', error: null });

test('creditUsage adds across session restarts instead of keeping only the latest total', () => {
  const { credits, totals, lastSeq } = creditUsage([turnAt(1, 9)], null, [usage(2, 100, 60, 10), usage(3, 900, 700, 50), usage(4, 40, 0, 5), usage(5, 70, 10, 8)], noTokens);
  assert.deepEqual(credits.get(0), { tokensTotal: 970, tokensCached: 710, tokensOutput: 58 });
  assert.deepEqual(totals, { tokensTotal: 70, tokensCached: 10, tokensOutput: 8 });
  assert.equal(lastSeq, 5);
});

test('creditUsage credits each event to the turn running when it was reported', () => {
  const turns = [turnAt(2, 5), turnAt(10, 15)];
  const { credits } = creditUsage(turns, null, [usage(1, 5), usage(3, 100), usage(7, 130), usage(12, 200), usage(20, 220)], noTokens);
  assert.equal(credits.get(0).tokensTotal, 130, 'an early event, a mid-turn event and a late event after the turn ended');
  assert.equal(credits.get(1).tokensTotal, 90, 'a mid-turn event and a late event after the last turn ended');
});

test('creditUsage leaves a running turn\'s events for when it finishes', () => {
  const { credits, totals, lastSeq } = creditUsage([turnAt(1, 3)], 5, [usage(2, 100), usage(6, 150)], noTokens);
  assert.equal(credits.get(0).tokensTotal, 100);
  assert.equal(totals.tokensTotal, 100);
  assert.equal(lastSeq, 2);
  assert.deepEqual(creditUsage([], null, [usage(2, 100)], noTokens), { credits: new Map(), totals: noTokens, lastSeq: null });
});

test('the ledger keeps tokens on the right model and never counts a usage event twice', async t => {
  const events = [requested(1, 'model-a'), started(2), usage(3, 500, 100, 10), completed(4), requested(5, 'model-b'), started(6), usage(7, 90, 0, 9), usage(8, 120, 0, 12), completed(9)];
  const { harness } = await fixture(t, false, {}, { threads: { ...eventLog(events) } });
  const idle = { thread: makeThreadResponse({ id: 'thr_builder' }), lastAssistantText: null };
  const byModel = async () => Object.fromEntries((await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null })).groups.map(group => [group.model, group.tokensTotal]));
  await harness.behavior.emitThreadEvent('thread.idle', idle);
  assert.deepEqual(await byModel(), { 'model-a': 500, 'model-b': 120 });

  // Without a usage-event cursor, the earlier 90 would read as another session restart.
  events.push(requested(10, 'model-b'), started(11), completed(12));
  await harness.behavior.emitThreadEvent('thread.idle', idle);
  assert.deepEqual(await byModel(), { 'model-a': 500, 'model-b': 120 });

  events.push(requested(13, 'model-b'), started(14), usage(15, 150, 0, 15), completed(16));
  await harness.behavior.emitThreadEvent('thread.idle', idle);
  assert.deepEqual(await byModel(), { 'model-a': 500, 'model-b': 150 });
});

test('a failed turn lands in the ledger with its category, and a ledger error stays out of the way', async t => {
  const { harness, failureEffects } = await fixture(t, false, {}, { threads: { ...eventLog([requested(1), started(2)]) } });
  await harness.behavior.emitThreadEvent('turn.failed', { ...failure('connection-failed'), threadId: 'thr_builder' });
  const report = await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null });
  assert.deepEqual(report.recent.map(run => [run.outcome, run.error]), [['failed', 'connection-failed']]);
  assert.deepEqual(failureEffects, []);

  const broken = await fixture(t, false, {}, { threads: { events: { list: async () => { throw new Error('events down'); } } } });
  await broken.harness.behavior.emitThreadEvent('thread.idle', { thread: makeThreadResponse({ id: 'thr_builder' }), lastAssistantText: null });
  assert.equal((await broken.harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null })).groups.length, 0);
});

test('runs --sync backfills threads and joins review verdicts to models', async t => {
  const agents = [
    { threadId: 'thr_r1', role: 'review1', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: 1 },
    { threadId: 'thr_r2', role: 'review2', taskKey: 'TEST-1', providerId: 'claude-code', createdAt: '', pr: 1 },
  ];
  const prs = [{ number: 1, taskKey: 'TEST-1', url: 'https://example.org/1', headSha: 'abc', branch: 'b', state: 'open', isDraft: true, deep: true, readyRequested: false, openedAt: '', scans: [], reviews: [
    { role: 'review1', threadId: 'thr_r1', sha: 'abc', verdict: 'pending', at: '' },
    { role: 'review1', threadId: 'thr_r1', sha: 'abc', verdict: 'changes', at: '' },
    { role: 'review1', threadId: 'thr_r1', sha: 'def', verdict: 'approve', at: '' },
    { role: 'review2', threadId: 'thr_r2', sha: 'abc', verdict: 'approve', at: '' },
  ] }];
  const logs = { thr_r1: [requested(1, 'model-a'), started(2), usage(3, 90, 30, 10), completed(4)], thr_r2: [requested(1, 'model-b'), started(2), completed(3)] };
  const { harness } = await fixture(t, false, { agents, prs }, { threads: { events: { list: args => eventLog(logs[args.threadId]).events.list(args) } } });
  const empty = await harness.behavior.runCli(['runs', 'TEST']);
  assert.match(empty.stdout, /--sync/);
  const result = await harness.behavior.runCli(['runs', 'TEST', '--sync', '--json']);
  assert.equal(result.exitCode, 0);
  const groups = Object.fromEntries(JSON.parse(result.stdout).groups.map(group => [group.model, group]));
  assert.deepEqual([groups['model-a'].approvals, groups['model-a'].changes, groups['model-a'].tokensTotal], [1, 1, 90]);
  assert.deepEqual([groups['model-b'].approvals, groups['model-b'].changes, groups['model-b'].tokensTotal], [1, 0, 0]);
  const text = await harness.behavior.runCli(['runs', 'TEST']);
  assert.match(text.stdout, /Reviewer 1 on codex\/model-a: 1 turn\(s\), 0 failed, 0 interrupted, 0 min, 50 \/ 30 \/ 10, 1 approved, 1 changes requested/);
});

// ----- Recurring review findings -----

const reviewers = [
  { threadId: 'thr_r1', role: 'review1', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: 1 },
  { threadId: 'thr_sec', role: 'security', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: 1 },
  { threadId: 'thr_r2', role: 'review1', taskKey: 'TEST-2', providerId: 'codex', createdAt: '', pr: 2 },
  { threadId: 'thr_shadow', role: 'shadow', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: 1 },
  { threadId: 'thr_builder', role: 'build', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: null },
];
const twoTasks = { tasksRpc: async ({ method, input }) => method === 'getTaskByKey' ? { task: { id: input.taskKey, key: input.taskKey, projectId: 'tracker', title: 'T', description: '', status: 'in_review', priority: 'none', position: 0, labelIds: [], createdAt: '', updatedAt: '' } } : undefined };
const RULE = 'Validate every path parameter before it reaches the filesystem.';

test('only a reviewer of the task can record a lesson, with exactly one of --rule and --same-as', async t => {
  const { harness } = await fixture(t, false, { agents: reviewers }, twoTasks);
  for (const threadId of ['thr_builder', 'thr_shadow', 'thr_r2', undefined]) {
    const denied = await harness.behavior.runCli(['lesson', 'TEST-1', '--rule', RULE], threadId === undefined ? {} : { threadId });
    assert.notEqual(denied.exitCode, 0, String(threadId));
    assert.match(denied.stderr, /Only a reviewer/);
  }
  const asReviewer = { threadId: 'thr_r1' };
  assert.notEqual((await harness.behavior.runCli(['lesson', 'TEST-1'], asReviewer)).exitCode, 0);
  assert.notEqual((await harness.behavior.runCli(['lesson', 'TEST-1', '--rule', RULE, '--same-as', '1'], asReviewer)).exitCode, 0);
  assert.notEqual((await harness.behavior.runCli(['lesson', 'TEST-1', '--rule', 'short'], asReviewer)).exitCode, 0);
  assert.notEqual((await harness.behavior.runCli(['lesson', 'TEST-1', '--same-as', '99'], asReviewer)).exitCode, 0);
  assert.equal((await harness.behavior.runCli(['lessons', 'TEST'])).stdout, 'No lessons recorded for TEST.');
});

test('a lesson reaches the Lead once, when a second task repeats it', async t => {
  const { harness, messages } = await fixture(t, false, { agents: reviewers }, { ...twoTasks, threads: { get: async () => makeThreadResponse({ id: 'thr_lead' }) } });
  const first = await harness.behavior.runCli(['lesson', 'TEST-1', '--rule', `  ${RULE}\n`], { threadId: 'thr_r1' });
  assert.equal(first.exitCode, 0, first.stderr);
  const listed = JSON.parse((await harness.behavior.runCli(['lessons', 'TEST', '--json'])).stdout);
  assert.deepEqual(listed.map(lesson => [lesson.rule, lesson.tasks, lesson.notifiedAt]), [[RULE, ['TEST-1'], null]]);
  const id = String(listed[0].id);

  // A second reviewer on the same task is still one task.
  await harness.behavior.runCli(['lesson', 'TEST-1', '--same-as', id], { threadId: 'thr_sec' });
  assert.equal(messages.length, 0);

  await harness.behavior.runCli(['lesson', 'TEST-2', '--same-as', id], { threadId: 'thr_r2' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].threadId, 'thr_lead');
  assert.match(messages[0].input[0].text, /Recurring review finding.*TEST-1 and TEST-2.*assign the Planner/s);
  assert.ok(messages[0].input[0].text.includes(JSON.stringify(RULE)));

  await harness.behavior.runCli(['lesson', 'TEST-2', '--same-as', id], { threadId: 'thr_r2' });
  assert.equal(messages.length, 1);
  assert.match((await harness.behavior.runCli(['lessons', 'TEST'])).stdout, /\[reported to the Lead\]/);
});

test('a lesson the Lead could not receive is reported on its next hit', async t => {
  let leadUp = false;
  const { harness, messages } = await fixture(t, false, { agents: reviewers }, { ...twoTasks, threads: { get: async () => { if (!leadUp) throw new Error('down'); return makeThreadResponse({ id: 'thr_lead' }); } } });
  await harness.behavior.runCli(['lesson', 'TEST-1', '--rule', RULE], { threadId: 'thr_r1' });
  await harness.behavior.runCli(['lesson', 'TEST-2', '--same-as', '1'], { threadId: 'thr_r2' });
  assert.equal(messages.length, 0);
  leadUp = true;
  await harness.behavior.runCli(['lesson', 'TEST-2', '--same-as', '1'], { threadId: 'thr_r2' });
  assert.equal(messages.length, 1);
});

test('reviewer prompts and standing rules teach lessons; the shadow stays out', () => {
  for (const role of ['review1', 'review2', 'security']) {
    assert.match(workerReminder({ role, factoryName: 'F', taskKey: 'T-1' }), /bb factory lesson/);
  }
  assert.doesNotMatch(workerReminder({ role: 'shadow', factoryName: 'F', taskKey: 'T-1' }), /lesson/);
  assert.match(leadCharter({ factoryName: 'F', prefix: 'T' }), /recurring review finding/);
});

// ----- Nightly check -----

const nightlyHost = async ({ method }) => {
  if (method === 'inspect_repo') return { exists: true, isGitRepo: true, commitCount: 1, sourceDirs: [], detectedMode: 'brownfield', files: { agentsMd: 'AGENTS.md', constitution: 'c.md', specs: 'a.md', roadmap: 'r.md' }, existingDocs: [] };
  throw new Error(`Unexpected host call: ${method}`);
};
const boardTask = (key, status) => ({ id: key, key, projectId: 'tracker', title: key, description: '', status, priority: 'none', position: 0, labelIds: [], createdAt: '', updatedAt: '' });

function nightlyFixture(t, tasks, initial = {}, overrides = {}) {
  const moved = [];
  return fixture(t, false, initial, {
    projectPath: '/repo',
    hostRpc: nightlyHost,
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, status: 'idle' }), ...eventLog([requested(1), started(2), completed(3)]), ...overrides.threads },
    tasksRpc: async ({ method, input }) => {
      if (method === 'listTasks') return { tasks: tasks() };
      if (method === 'getTask') return { task: boardTask(input.taskId, 'in_review') };
      if (method === 'getTaskByKey') return { task: boardTask(input.taskKey, 'in_progress') };
      if (method === 'boardMove') { moved.push([input.taskId, input.status]); return { ok: true, task: boardTask(input.taskId, input.status) }; }
      return undefined;
    },
  }).then(result => ({ ...result, moved }));
}

const nightly = async harness => JSON.parse((await harness.behavior.runCli(['nightly', 'TEST', '--json'])).stdout)[0].report;

test('the nightly check leaves findings for the person and never messages an agent', async t => {
  const tasks = [boardTask('TEST-1', 'in_progress')];
  const { harness, messages } = await nightlyFixture(t, () => tasks);
  assert.equal(await nightly(harness), null);
  await harness.runSchedule('nightly-check');
  assert.equal(messages.length, 0);
  const report = await nightly(harness);
  assert.deepEqual(report.stalled, [{ taskKey: 'TEST-1', title: 'TEST-1' }]);
  assert.equal(report.dismissed, false);
  assert.equal(report.error, null);
  assert.equal((await harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null })).recent.length, 1);
  assert.match((await harness.behavior.runCli(['nightly', 'TEST'])).stdout, /Stalled, no active worker: TEST-1/);
  assert.deepEqual(await harness.behavior.callRpc('factory_nightly', { prefix: 'TEST' }), report);
});

test('a dismissed nightly report stays hidden until something changes', async t => {
  let tasks = [boardTask('TEST-1', 'in_progress')];
  const { harness, messages } = await nightlyFixture(t, () => tasks);
  await harness.runSchedule('nightly-check');
  assert.equal((await harness.behavior.callRpc('factory_nightly_dismiss', { prefix: 'TEST' })).dismissed, true);
  await harness.runSchedule('nightly-check');
  assert.equal((await nightly(harness)).dismissed, true, 'the same finding stays read');
  tasks = [boardTask('TEST-1', 'in_review')];
  await harness.runSchedule('nightly-check');
  assert.equal((await nightly(harness)).dismissed, false, 'a change shows again');
  assert.equal(messages.length, 0);
});

const healthOf = async harness => (await harness.behavior.callRpc('factory_doctor', { prefix: 'TEST' })).boardHealth;

test('tasks with no agents or only a Planner are not stalled; a quiet worker is', async t => {
  const agents = [
    { threadId: 'thr_plan', role: 'plan', taskKey: 'TEST-2', providerId: 'codex', createdAt: '', pr: null },
    { threadId: 'thr_build', role: 'build', taskKey: 'TEST-3', providerId: 'codex', createdAt: '', pr: null },
  ];
  const { harness } = await nightlyFixture(t, () => [boardTask('TEST-1', 'in_progress'), boardTask('TEST-2', 'in_progress'), boardTask('TEST-3', 'in_progress')], { agents });
  assert.deepEqual((await healthOf(harness)).inProgressWithoutLiveWorker.map(task => task.taskKey), ['TEST-3']);
});

test('task-kind stops a task being reported, and only the Lead or the person can set it', async t => {
  const agents = [
    { threadId: 'thr_lead', role: 'lead', taskKey: null, providerId: 'codex', createdAt: '', pr: null },
    { threadId: 'thr_plan', role: 'plan', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: null },
    { threadId: 'thr_build', role: 'build', taskKey: 'TEST-2', providerId: 'codex', createdAt: '', pr: null },
  ];
  const plans = [{ taskKey: 'TEST-1', threadId: 'thr_plan', commentId: 'comment_1' }];
  const { harness } = await nightlyFixture(t, () => [boardTask('TEST-1', 'in_progress'), boardTask('TEST-2', 'in_progress')], { agents, plans });
  let health = await healthOf(harness);
  assert.deepEqual(health.readyPlansAwaitingBuilder.map(task => task.taskKey), ['TEST-1'], 'a Planner-only READY plan is still reported');
  assert.deepEqual(health.inProgressWithoutLiveWorker.map(task => task.taskKey), ['TEST-2']);

  const denied = await harness.behavior.runCli(['task-kind', 'TEST-1', 'coordination'], { threadId: 'thr_build' });
  assert.notEqual(denied.exitCode, 0);
  assert.match(denied.stderr, /Only the factory's Lead or the person/);
  assert.notEqual((await harness.behavior.runCli(['task-kind', 'TEST-1', 'other'], { threadId: 'thr_lead' })).exitCode, 0);

  assert.equal((await harness.behavior.runCli(['task-kind', 'TEST-1', 'coordination'], { threadId: 'thr_lead' })).stdout, 'TEST-1: coordination');
  assert.equal((await harness.behavior.runCli(['task-kind', 'TEST-2', 'person'])).stdout, 'TEST-2: person');
  health = await healthOf(harness);
  assert.deepEqual(health.readyPlansAwaitingBuilder, []);
  assert.deepEqual(health.inProgressWithoutLiveWorker, []);
  assert.deepEqual(health.markedNotStalled, [{ taskKey: 'TEST-1', kind: 'coordination' }, { taskKey: 'TEST-2', kind: 'person' }]);

  await harness.behavior.runCli(['task-kind', 'TEST-2', 'work']);
  assert.equal((await harness.behavior.runCli(['task-kind', 'TEST-2'])).stdout, 'TEST-2: work');
  assert.deepEqual((await healthOf(harness)).inProgressWithoutLiveWorker.map(task => task.taskKey), ['TEST-2']);
});

test('the nightly check reports merged tasks it moved, and skips archived factories', async t => {
  const pr = { number: 1, taskKey: 'TEST-1', url: 'https://example.org/1', headSha: 'abc', branch: 'b', state: 'merged', isDraft: false, deep: false, readyRequested: false, openedAt: '', scans: [], reviews: [] };
  const live = await nightlyFixture(t, () => [boardTask('TEST-1', 'in_review')], { prs: [pr] });
  await live.harness.runSchedule('nightly-check');
  assert.deepEqual(live.moved, [['TEST-1', 'done']]);
  assert.equal(live.messages.length, 0);
  assert.deepEqual((await nightly(live.harness)).movedToDone, ['TEST-1']);

  const archived = await nightlyFixture(t, () => [boardTask('TEST-1', 'in_progress')], { archivedAt: '2026-01-01T00:00:00.000Z' });
  await archived.harness.runSchedule('nightly-check');
  assert.equal(archived.messages.length, 0);
  assert.equal((await archived.harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null })).recent.length, 0);
});

test('the nightly check can be turned off, and reports a failing factory', async t => {
  const quiet = await nightlyFixture(t, () => [boardTask('TEST-1', 'in_progress')]);
  await quiet.harness.behavior.setSettings({ nightlyChecks: false });
  await quiet.harness.runSchedule('nightly-check');
  assert.equal(quiet.messages.length, 0);
  assert.equal((await quiet.harness.behavior.callRpc('factory_runs', { prefix: 'TEST', taskKey: null })).recent.length, 0);

  const broken = await fixture(t, false, {}, { projectPath: '/repo', hostRpc: nightlyHost, tasksRpc: async () => { throw new Error('tasks down'); } });
  await assert.rejects(broken.harness.runSchedule('nightly-check'), /Nightly check failed for TEST/);
  assert.match((await nightly(broken.harness)).error, /tasks down/);
});

// ----- Merge policy -----

const HEAD = 'abc1234def';
const greenChecks = [{ name: 'test', conclusion: 'SUCCESS' }, { name: 'skip', conclusion: 'SKIPPED' }, { context: 'pages', state: 'SUCCESS' }];
const liveView = (over = {}) => ({ state: 'OPEN', isDraft: false, headRefOid: HEAD, mergeable: 'MERGEABLE', statusCheckRollup: greenChecks, ...over });
const approved = (role, sha = HEAD, verdict = 'approve') => ({ role, threadId: `thr_${role}`, sha, verdict, at: '' });
const readyPr = (over = {}) => ({ deep: false, scans: [], reviews: [approved('review1'), approved('security')], ...over });

test('mergeBlockers passes only with approvals and green CI on the exact head', () => {
  assert.deepEqual(mergeBlockers(readyPr(), liveView(), false), []);
  const cases = [
    [readyPr(), liveView({ isDraft: true }), /draft/],
    [readyPr(), liveView({ state: 'MERGED' }), /merged/],
    [readyPr(), liveView({ mergeable: 'CONFLICTING' }), /conflicting/],
    [readyPr(), liveView({ mergeable: 'UNKNOWN' }), /unknown/],
    [readyPr(), liveView({ statusCheckRollup: [] }), /no CI checks/],
    [readyPr(), liveView({ statusCheckRollup: null }), /no CI checks/],
    [readyPr(), liveView({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] }), /CI isn't green: test/],
    [readyPr(), liveView({ statusCheckRollup: [{ name: 'slow', conclusion: '' }] }), /CI isn't green: slow/],
    [readyPr({ reviews: [approved('review1')] }), liveView(), /Security has not approved/],
    [readyPr({ reviews: [approved('review1', 'old0000'), approved('security')] }), liveView(), /Reviewer 1 approved old0000, not the head/],
    [readyPr({ deep: true }), liveView(), /Reviewer 2 has not approved/],
    [readyPr({ reviews: [approved('review1'), approved('security', HEAD, 'approve'), approved('security', HEAD, 'changes')] }), liveView(), /Security has not approved/],
    [readyPr({ scans: [{ status: 'running' }] }), liveView(), /Rafter scan/],
  ];
  for (const [pr, view, pattern] of cases) assert.match(mergeBlockers(pr, view, false).join('; '), pattern);
  const shadowed = readyPr({ reviews: [...readyPr().reviews, approved('shadow', HEAD, 'changes')] });
  assert.match(mergeBlockers(shadowed, liveView(), true).join('; '), /shadow/);
  assert.deepEqual(mergeBlockers(shadowed, liveView(), false), []);
});

function mergeFixture(t, initial = {}, view = liveView()) {
  const ghCalls = [];
  const pr = { number: 7, taskKey: 'TEST-1', url: 'https://example.org/7', headSha: HEAD, branch: 'b', state: 'open', isDraft: false, deep: false, readyRequested: true, openedAt: '', scans: [], reviews: readyPr().reviews };
  const agents = [
    { threadId: 'thr_lead', role: 'lead', taskKey: null, providerId: 'codex', createdAt: '', pr: null },
    { threadId: 'thr_builder', role: 'build', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: null },
  ];
  return fixture(t, false, { prs: [pr], agents, ...initial }, {
    hostRpc: async ({ method, input }) => {
      if (method !== 'gh') throw new Error(`Unexpected host call: ${method}`);
      ghCalls.push(input.args);
      if (input.args[1] === 'view') return { code: 0, stdout: JSON.stringify(view), stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  }).then(result => ({ ...result, ghCalls, merges: () => ghCalls.filter(args => args[1] === 'merge') }));
}

test('a new factory defaults to person: the Lead and builders cannot merge', async t => {
  const { harness, merges } = await mergeFixture(t);
  assert.equal((await harness.behavior.runCli(['merge-policy', 'TEST'])).stdout, 'TEST: person');
  const lead = await harness.behavior.runCli(['merge', 'TEST-1'], { threadId: 'thr_lead' });
  assert.notEqual(lead.exitCode, 0);
  assert.match(lead.stderr, /merge policy is person/);
  const builder = await harness.behavior.runCli(['merge', 'TEST-1'], { threadId: 'thr_builder' });
  assert.notEqual(builder.exitCode, 0);
  assert.match(builder.stderr, /Only the factory's Lead or the person/);
  assert.equal(merges().length, 0);
});

test('under when-green the Lead merges pinned to the head, and the merge is recorded', async t => {
  const { bb, harness, merges } = await mergeFixture(t, { mergePolicy: 'when-green' });
  const result = await harness.behavior.runCli(['merge', 'TEST-1'], { threadId: 'thr_lead' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(merges(), [['pr', 'merge', '7', '--repo', 'owner/repo', '--squash', '--match-head-commit', HEAD]]);
  const stored = await createFactoryStorage(bb.storage, value => value).read('TEST');
  assert.deepEqual({ ...stored.prs[0].merge, at: '' }, { by: 'lead', threadId: 'thr_lead', sha: HEAD, policy: 'when-green', at: '' });
});

test('a failing gate names the reason and never reaches gh pr merge', async t => {
  const { harness, merges } = await mergeFixture(t, { mergePolicy: 'when-green' }, liveView({ headRefOid: 'newhead0000' }));
  const result = await harness.behavior.runCli(['merge', 'TEST-1'], { threadId: 'thr_lead' });
  assert.notEqual(result.exitCode, 0);
  assert.match(result.stderr, /can't merge yet: Reviewer 1 approved abc1234, not the head newhead/);
  assert.equal(merges().length, 0);
});

test('the person can merge under person, with the same gates, and only the person can set the policy', async t => {
  const { harness, merges } = await mergeFixture(t);
  for (const threadId of ['thr_lead', 'thr_builder']) {
    const denied = await harness.behavior.runCli(['merge-policy', 'TEST', 'when-green'], { threadId });
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.stderr, /Only the person/);
  }
  assert.equal((await harness.behavior.runCli(['merge-policy', 'TEST'])).stdout, 'TEST: person');
  assert.notEqual((await harness.behavior.runCli(['merge-policy', 'TEST', 'always'])).exitCode, 0);
  assert.equal((await harness.behavior.runCli(['merge', 'TEST-1'])).exitCode, 0);
  assert.equal(merges().length, 1);
  assert.equal((await harness.behavior.runCli(['merge-policy', 'TEST', 'when-green'])).stdout, 'TEST: when-green');
  assert.equal((await harness.behavior.runCli(['merge-policy', 'TEST'])).stdout, 'TEST: when-green');
});

test('the Lead hears one merge rule, matching the factory policy', () => {
  const person = leadCharter({ factoryName: 'F', prefix: 'T' });
  assert.match(person, /merge policy is `person`/);
  assert.match(person, /saved notes don't change this/);
  assert.doesNotMatch(person, /bb factory merge </);
  const green = leadCharter({ factoryName: 'F', prefix: 'T', mergePolicy: 'when-green' });
  assert.match(green, /bb factory merge <KEY>/);
  assert.match(green, /never `gh pr merge`/);
  assert.doesNotMatch(green, /merge policy is `person`/);
  assert.ok(green.length < 4096);
});
