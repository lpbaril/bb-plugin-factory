import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('./') && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context);
  return next(specifier, context);
} });
const { default: hostEntry } = await import('./host.ts');

async function repo(t) {
  const dir = await mkdtemp(join(tmpdir(), 'factory-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}
const scaffold = dir => hostEntry.handlers.scaffold_specs(
  { projectPath: dir, factoryName: 'App', prefix: 'APP', mode: 'greenfield' },
  { signal: new AbortController().signal },
);

test('scaffolded docs say why each one is worth reading first', async t => {
  const dir = await repo(t);
  const { created } = await scaffold(dir);
  assert.deepEqual(created.sort(), ['.specify/memory/constitution.md', 'AGENTS.md', 'docs/architecture.md', 'docs/roadmap.md']);
  const agents = await readFile(join(dir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /\| Document \| Read it before \| Because \|/);
  for (const doc of ['.specify/memory/constitution.md', 'docs/architecture.md', 'docs/roadmap.md']) {
    assert.ok(agents.includes(`| \`${doc}\` |`), doc);
  }
  const architecture = await readFile(join(dir, 'docs/architecture.md'), 'utf8');
  const header = architecture.split('\n').find(line => line.startsWith('| Path / Module'));
  assert.ok(header.includes('Read this first, because'));
  for (const line of architecture.split('\n').filter(line => line.startsWith('| '))) {
    assert.equal(line.split('|').length, header.split('|').length, line);
  }
});

test('scaffolding leaves an existing document alone', async t => {
  const dir = await repo(t);
  await writeFile(join(dir, 'AGENTS.md'), 'mine');
  const { existing } = await scaffold(dir);
  assert.ok(existing.includes('AGENTS.md'));
  assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), 'mine');
});

test('the host worker deletes only an Explorer\'s branch, and not one still checked out', async t => {
  const dir = await repo(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=T', ...args], { cwd: dir, encoding: 'utf8' });
  git('commit', '-q', '--allow-empty', '-m', 'start');
  const explorer = 'bb/app-16-explorer-tips-from-csv-thr_abc123';
  git('branch', explorer);
  git('branch', 'bb/app-15-builder-add-tax-thr_def456');
  const del = (branch, threadId = 'thr_abc123') => hostEntry.handlers.delete_explorer_branch({ projectPath: dir, branch, threadId }, { signal: new AbortController().signal });
  assert.deepEqual(await del(explorer), { deleted: true, missing: false, error: null });
  assert.equal(git('branch', '--list', explorer).trim(), '');
  assert.deepEqual(await del(explorer), { deleted: false, missing: true, error: null }, 'gone already: nothing more to do');
  // A Builder's branch for a task whose title has "explorer" in it: the role comes right after the number.
  git('branch', 'bb/app-18-builder-add-file-explorer-thr_abc123');
  for (const branch of ['bb/app-15-builder-add-tax-thr_def456', 'bb/app-18-builder-add-file-explorer-thr_abc123', 'main', 'master', '-D', 'bb/app-16-explorer-../../x-thr_abc123', 'bb/app-16-explorer-x --force-thr_abc123']) {
    const result = await del(branch);
    assert.equal(result.deleted, false, branch);
    assert.match(result.error, /isn't the branch of Explorer thr_abc123/, branch);
  }
  git('branch', 'bb/app-19-explorer-other-thr_zzz999');
  assert.match((await del('bb/app-19-explorer-other-thr_zzz999')).error, /isn't the branch of Explorer thr_abc123/, 'another Explorer\'s branch');
  assert.notEqual(git('branch', '--list', 'bb/app-18-builder-add-file-explorer-thr_abc123').trim(), '');
  assert.notEqual(git('branch', '--list', 'bb/app-15-builder-add-tax-thr_def456').trim(), '', 'a Builder\'s branch stays');
  const busy = 'bb/app-17-explorer-still-here-thr_abc123';
  const elsewhere = join(dir, '..', `${dir.split('/').at(-1)}-wt`);
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  git('worktree', 'add', '-q', '-b', busy, elsewhere);
  const refused = await del(busy);
  assert.equal(refused.deleted, false, 'git refuses a branch still checked out');
  assert.ok(refused.error !== null && refused.error.length > 0);
  const missingDir = await hostEntry.handlers.delete_explorer_branch({ projectPath: '/nowhere/at/all', branch: explorer, threadId: 'thr_abc123' }, { signal: new AbortController().signal });
  assert.match(missingDir.error, /isn't an accessible directory/);
  // Not a repository: git fails, which isn't "missing", so the branch isn't recorded as gone.
  const plain = await mkdtemp(join(tmpdir(), 'factory-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  const notRepo = await hostEntry.handlers.delete_explorer_branch({ projectPath: plain, branch: explorer, threadId: 'thr_abc123' }, { signal: new AbortController().signal });
  assert.deepEqual([notRepo.deleted, notRepo.missing], [false, false]);
  assert.ok(notRepo.error !== null);
});
