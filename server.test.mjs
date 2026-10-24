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

async function fixture(t, fallback = false, initial = {}) {
  const spawns = [];
  const failureEffects = [];
  const comments = [];
  const messages = [];
  const task = { id: 'task_1', key: 'TEST-1', projectId: 'tracker', title: 'Test', description: '', status: 'in_review', priority: 'none', position: 0, labelIds: [], createdAt: '', updatedAt: '' };
  const { bb, harness } = createFakePluginHost({
    pluginId: 'factory', settings: { superviseAgents: true },
    sdk: {
      projects: { get: async () => ({ name: 'Test', sources: [{ hostId: 'host_test', isDefault: true }] }) },
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
      },
      plugins: { callRpc: async ({ method, input }) => {
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
  await bb.storage.kv.set('factory:TEST', {
    prefix: 'TEST', name: 'Test', bbProjectId: 'proj_test', trackerProjectId: 'tracker', blockedLabelId: 'blocked', leadThreadId: 'thr_lead', createdAt: '',
    agents: [{ threadId: 'thr_builder', role: 'build', taskKey: 'TEST-1', providerId: 'codex', createdAt: '', pr: null }],
    ...initial,
  });
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
  assert.equal((await bb.storage.kv.get('factory:TEST')).plans[0].commentId, null);
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
  assert.match(workerReminder({ role: 'plan', factoryName: 'Test', taskKey: 'TEST-1' }), /plan-ready/);
});
