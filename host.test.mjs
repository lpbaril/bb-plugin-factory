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
