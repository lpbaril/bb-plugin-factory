import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { FACTORY_MIGRATIONS, createFactoryStorage } from './factory-storage.ts';

function history(count = 250) {
  const factory = { prefix: 'BIG', name: 'Large factory', bbProjectId: 'proj_big', trackerProjectId: 'tracker', blockedLabelId: 'blocked', leadThreadId: 'lead', createdAt: '', repo: 'owner/repo', archivedAt: null, agents: [], prs: [], plans: [] };
  for (let i = 1; i <= count; i++) {
    const taskKey = `BIG-${i}`;
    for (let j = 0; j < 12; j++) factory.agents.push({ threadId: `thread_${i}_${j}`, taskKey, role: 'build', providerId: 'codex', pr: null, createdAt: '' });
    factory.prs.push({ number: i, taskKey, url: `https://example.org/pr/${i}`, headSha: 'abc', branch: `build-${i}`, state: i < count ? 'merged' : 'open', isDraft: i === count, deep: true, readyRequested: false, openedAt: '', reviews: Array.from({ length: 15 }, (_, j) => ({ role: ['review1', 'review2', 'security'][j % 3], threadId: `review_${i}_${j}`, sha: 'abc', verdict: 'approve', at: '' })), scans: [{ phase: 'open', sha: 'abc', scanId: null, status: 'failed', error: 'quota', startedAt: '' }] });
    factory.plans.push({ taskKey, threadId: `plan_${i}`, commentId: `comment_${i}` });
  }
  return factory;
}

const identity = value => value;
test('migrates 250 tasks with 12 agents and 15 verdicts each without loss or growing values', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const original = history();
  assert.ok(Buffer.byteLength(JSON.stringify(original)) > 262144);
  // Simulate a persisted legacy value that exceeds today's write cap: reads
  // still work, but any attempt to rewrite this value via KV would fail.
  const storage = { ...bb.storage, kv: { ...bb.storage.kv, get: async key => (await bb.storage.kv.get(key)) ?? (key === 'factory:BIG' ? original : undefined) } };
  let store = createFactoryStorage(storage, identity);
  assert.deepEqual(await store.read('BIG'), original);
  assert.deepEqual(await bb.storage.kv.get('factory:BIG'), { storageVersion: 2, prefix: 'BIG' });
  const db = bb.storage.database();
  assert.deepEqual(JSON.parse(db.prepare('SELECT payload FROM factory_legacy_backups').get().payload), original);
  assert.equal(db.prepare("SELECT count(*) AS n FROM factory_records WHERE kind='agent'").get().n, 3000);
  assert.ok(db.prepare('SELECT max(length(payload)) AS n FROM factory_records').get().n < 1024);
  const bytes = Buffer.byteLength(JSON.stringify(await bb.storage.kv.get('factory:BIG')));
  const grown = structuredClone(original);
  grown.prs[249].reviews.push({ role: 'review1', threadId: 'new_review', sha: 'abc', verdict: 'changes', at: '' });
  grown.agents.push({ ...grown.agents[0], threadId: 'new_builder' });
  await store.write(grown);
  store = createFactoryStorage(storage, identity); // restart/repeated migration
  assert.deepEqual(await store.read('BIG'), grown);
  assert.equal(Buffer.byteLength(JSON.stringify(await bb.storage.kv.get('factory:BIG'))), bytes);
  assert.equal(db.prepare('SELECT count(*) AS n FROM factory_legacy_backups').get().n, 1);
});

test('failed KV cutover resumes from committed rows without losing later updates', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const original = history(1);
  await bb.storage.kv.set('factory:BIG', original);
  let fail = true;
  const storage = { ...bb.storage, kv: { ...bb.storage.kv, set: async (key, value) => { if (fail) throw new Error('cutover interrupted'); return bb.storage.kv.set(key, value); } } };
  let store = createFactoryStorage(storage, identity);
  await assert.rejects(store.read('BIG'), /cutover interrupted/);
  assert.deepEqual(await bb.storage.kv.get('factory:BIG'), original);
  fail = false;
  store = createFactoryStorage(storage, identity);
  const recovered = await store.read('BIG');
  recovered.prs[0].reviews.push({ role: 'security', threadId: 'security', sha: 'new', verdict: 'approve', at: '' });
  await store.write(recovered);
  assert.deepEqual(await store.read('BIG'), recovered);
  assert.deepEqual(JSON.parse(bb.storage.database().prepare('SELECT payload FROM factory_legacy_backups').get().payload), original);
});

test('database transaction failure leaves both legacy state and prior rows intact', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const original = history(1);
  await bb.storage.kv.set('factory:BIG', original);
  const store = createFactoryStorage(bb.storage, identity);
  const db = bb.storage.database();
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON factory_records BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  await assert.rejects(store.read('BIG'), /disk failure/);
  assert.deepEqual(await bb.storage.kv.get('factory:BIG'), original);
  assert.equal(db.prepare('SELECT count(*) AS n FROM factory_metadata').get().n, 0);
  db.exec('DROP TRIGGER fail_insert');
  assert.deepEqual(await store.read('BIG'), original);
  db.exec("CREATE TRIGGER fail_insert BEFORE INSERT ON factory_records BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  await assert.rejects(store.write(history(2)), /disk failure/);
  assert.deepEqual(await store.read('BIG'), original);
});

test('shadow trial runs and retired history migrate into rows and survive later writes', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const trial = { runs: Array.from({ length: 4000 }, (_, i) => ({ taskKey: `BIG-${i}`, shadowThreadId: `shadow_${i}`, shadowModel: 'test-model', startedAt: '' })), comparisonThreadId: 'comparison', comparedRuns: 100 };
  const legacy = { 'shadow-trial': trial, 'shadow-trial-history': [trial, trial] };
  const storage = { ...bb.storage, kv: { ...bb.storage.kv, get: async key => (await bb.storage.kv.get(key)) ?? legacy[key] } };
  let store = createFactoryStorage(storage, identity);
  assert.deepEqual(await store.readTrial(), trial);
  const db = bb.storage.database();
  assert.equal(db.prepare('SELECT count(*) AS n FROM factory_trial_runs').get().n, 12000);
  await store.retireTrial(trial);
  await store.writeTrial({ runs: [], comparisonThreadId: null });
  store = createFactoryStorage(storage, identity);
  assert.deepEqual(await store.readTrial(), { runs: [], comparisonThreadId: null });
  assert.equal(db.prepare('SELECT count(*) AS n FROM factory_trial_runs').get().n, 12000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM factory_legacy_backups').get().n, 2);
  assert.ok(Buffer.byteLength(JSON.stringify(await bb.storage.kv.get('shadow-trial-history'))) < 100);
});

test('the run ledger survives factory rewrites, ignores replays, and leaves with its factory', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const store = createFactoryStorage(bb.storage, identity);
  const factory = history(1);
  await store.write(factory);
  const row = { threadId: 'thr', endSeq: 5, prefix: 'BIG', taskKey: 'BIG-1', role: 'build', providerId: 'codex', model: 'm', reasoning: null, outcome: 'completed', error: null, startedAt: 1000, endedAt: 4000, tokensTotal: 10, tokensCached: 4, tokensOutput: 2 };
  const cursor = { lastSeq: 5, usageSeq: 4, tokensTotal: 10, tokensCached: 4, tokensOutput: 2 };
  store.appendRuns('thr', [row], cursor);
  store.appendRuns('thr', [row], cursor);
  await store.write(factory);
  assert.deepEqual(store.recentRuns('BIG', null, 10), [row]);
  assert.deepEqual(store.runCursor('thr'), cursor);
  assert.equal(store.recentRuns('BIG', null, 0).length, 0);
  assert.equal(store.recentRuns('BIG', 'BIG-2', 10).length, 0);
  assert.deepEqual(store.runGroups('BIG', null), [{ role: 'build', providerId: 'codex', model: 'm', runs: 1, failed: 0, interrupted: 0, durationMs: 3000, tokensTotal: 10, tokensCached: 4, tokensOutput: 2 }]);

  assert.deepEqual(store.runCursor('unknown'), { lastSeq: 0, usageSeq: 0, tokensTotal: 0, tokensCached: 0, tokensOutput: 0 });
  const lesson = store.recordLesson('BIG', { rule: 'Do the thing.' }, 'BIG-1', 'thr');
  assert.deepEqual(lesson.tasks, ['BIG-1']);
  assert.equal(store.recordLesson('OTHER', { id: lesson.id }, 'OTHER-1', 'thr'), null, 'a lesson belongs to one factory');
  await store.remove('BIG');
  assert.equal(store.recentRuns('BIG', null, 10).length, 0);
  assert.deepEqual(store.runCursor('thr'), { lastSeq: 0, usageSeq: 0, tokensTotal: 0, tokensCached: 0, tokensOutput: 0 });
  assert.deepEqual(store.lessons('BIG'), []);
});

test('upgrading clears ledger rows with bad token credit, and only those', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const db = bb.storage.database();
  bb.storage.migrate(db, FACTORY_MIGRATIONS.slice(0, -1));
  db.prepare("INSERT INTO factory_runs VALUES ('thr', 5, 'BIG', 'BIG-1', 'build', 'codex', 'm', null, 'completed', null, 1, 2, 10, 4, 2)").run();
  db.prepare("INSERT INTO factory_run_cursors VALUES ('thr', 5, 10, 4, 2)").run();
  db.prepare("INSERT INTO factory_lessons (prefix, rule, created_at) VALUES ('BIG', 'Keep this lesson.', '')").run();
  const store = createFactoryStorage(bb.storage, identity);
  assert.equal(store.recentRuns('BIG', null, 10).length, 0);
  assert.deepEqual(store.runCursor('thr'), { lastSeq: 0, usageSeq: 0, tokensTotal: 0, tokensCached: 0, tokensOutput: 0 });
  assert.equal(store.lessons('BIG').length, 1);
  store.appendRuns('thr', [], { lastSeq: 7, usageSeq: 6, tokensTotal: 1, tokensCached: 0, tokensOutput: 0 });
  assert.equal(store.runCursor('thr').usageSeq, 6);
});

test('tokensByTask sums each task, leaves out cached input and other factories', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const store = createFactoryStorage(bb.storage, identity);
  const row = (threadId, prefix, taskKey, tokensTotal, tokensCached) => ({ threadId, endSeq: 1, prefix, taskKey, role: 'build', providerId: 'codex', model: null, reasoning: null, outcome: 'completed', error: null, startedAt: 1, endedAt: 2, tokensTotal, tokensCached, tokensOutput: 0 });
  const cursor = { lastSeq: 1, usageSeq: 1, tokensTotal: 0, tokensCached: 0, tokensOutput: 0 };
  store.appendRuns('a', [row('a', 'P', 'P-1', 100, 40)], cursor);
  store.appendRuns('b', [row('b', 'P', 'P-1', 10, null)], cursor);
  store.appendRuns('c', [row('c', 'P', 'P-2', null, null)], cursor);
  store.appendRuns('d', [row('d', 'P', null, 500, 0)], cursor);
  store.appendRuns('e', [row('e', 'OTHER', 'P-1', 700, 0)], cursor);
  assert.deepEqual([...store.tokensByTask('P')].sort(), [['P-1', 70], ['P-2', 0]]);
});

test('tokenTurns keeps turns that started in a window, with tokens defined as tokensByTask defines them', async t => {
  const { bb, harness } = createFakePluginHost({ pluginId: 'factory' });
  t.after(() => harness.lifecycle.dispose());
  const store = createFactoryStorage(bb.storage, identity);
  const run = (endSeq, startedAt, tokens = {}, prefix = 'BIG') => ({ threadId: 'thr', endSeq, prefix, taskKey: 'BIG-1', role: 'build', providerId: 'codex', model: null, reasoning: null, outcome: 'completed', error: 'a long error text', startedAt, endedAt: startedAt + 10, tokensTotal: 100, tokensCached: 30, tokensOutput: 5, ...tokens });
  store.appendRuns('thr', [
    run(3, 3000, { tokensTotal: 50, tokensCached: 60 }),
    run(1, 1000),
    run(2, 2000, { tokensTotal: 40, tokensCached: -5 }),
    run(4, 4000, { tokensTotal: null, tokensCached: null, tokensOutput: null }),
  ], { lastSeq: 4, usageSeq: 4, tokensTotal: 190, tokensCached: 85, tokensOutput: 5 });
  store.appendRuns('other', [{ ...run(1, 1500, {}, 'OTHER'), threadId: 'other' }], { lastSeq: 1, usageSeq: 1, tokensTotal: 1, tokensCached: 0, tokensOutput: 0 });
  assert.deepEqual(store.tokenTurns('BIG', null, null), [
    { threadId: 'thr', role: 'build', taskKey: 'BIG-1', outcome: 'completed', startedAt: 1000, fresh: 70, cached: 30 },
    { threadId: 'thr', role: 'build', taskKey: 'BIG-1', outcome: 'completed', startedAt: 2000, fresh: 40, cached: 0 },
    { threadId: 'thr', role: 'build', taskKey: 'BIG-1', outcome: 'completed', startedAt: 3000, fresh: 0, cached: 60 },
    { threadId: 'thr', role: 'build', taskKey: 'BIG-1', outcome: 'completed', startedAt: 4000, fresh: null, cached: null },
  ], 'oldest first, one factory only, nothing below zero, only what the profile reads');
  const starts = (from, until) => store.tokenTurns('BIG', from, until).map(row => row.startedAt);
  assert.deepEqual(starts(2000, null), [2000, 3000, 4000], 'from is inclusive');
  assert.deepEqual(starts(null, 2000), [1000], 'until is exclusive');
  assert.deepEqual(starts(1001, 3000), [2000]);
  assert.equal(store.tokensByTask('BIG').get('BIG-1'), 70 + 40 + 0, 'the same definition: the profile and tokens per task agree');
});
