import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { createFactoryStorage } from './factory-storage.ts';

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
