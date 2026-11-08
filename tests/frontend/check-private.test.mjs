/**
 * The private-details check. Its terms here are invented; the real ones live only in
 * a file outside the repository. The commit tests build throwaway repositories.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitProblems, commitsToPush, parseTerms, privateRefusal, termsFile, termsIn, TERMS_FILE } from '../../scripts/check-private.mjs';

const TERMS = ['99999999999', 'Fake_Report.pdf', 'example-uni.edu'];
const ZERO = '0'.repeat(40);
// Under the pre-push hook git sets GIT_DIR and friends, which would point these at the real repository.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-private-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: gitEnv }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 'tester@example.com');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(path.join(dir, TERMS_FILE), `# invented\n${TERMS.join('\n')}\n`);
  writeFileSync(path.join(dir, '.gitignore'), `${TERMS_FILE}\n`);
  const commit = (file, text, message = 'change') => {
    writeFileSync(path.join(dir, file), text);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const remove = (file) => { git('rm', '-q', file); git('commit', '-q', '-m', 'remove'); return git('rev-parse', 'HEAD'); };
  return { dir, git, commit, remove, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const push = (sha) => `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;

test('terms are one a line, with blanks and comments skipped', () => {
  assert.deepEqual(parseTerms('# note\n\n  abc  \r\ndef\n'), ['abc', 'def']);
});

test('a term is found whatever its case, and named by its number', () => {
  assert.deepEqual(termsIn('student@EXAMPLE-UNI.EDU wrote fake_report.PDF', TERMS), [2, 3]);
  assert.deepEqual(termsIn('nothing here', TERMS), []);
});

test('a clean push passes', (t) => {
  const r = repo();
  t.after(r.done);
  const head = r.commit('notes.md', 'synthetic data only');
  assert.equal(privateRefusal(push(head), r.dir, path.join(r.dir, TERMS_FILE)), null);
});

test('a term in a file is refused, and the report never repeats the term', (t) => {
  const r = repo();
  t.after(r.done);
  const head = r.commit('notes.md', 'roll 99999999999');
  const refusal = privateRefusal(push(head), r.dir, path.join(r.dir, TERMS_FILE));
  assert.match(refusal, /notes\.md has term 1/);
  for (const term of TERMS) assert.ok(!refusal.includes(term));
});

test('a term added in one commit and removed in the next is still refused', (t) => {
  const r = repo();
  t.after(r.done);
  r.commit('a.md', 'clean');
  r.commit('ids.json', '{"from": "someone@example-uni.edu"}');
  const head = r.remove('ids.json');
  assert.match(privateRefusal(push(head), r.dir, path.join(r.dir, TERMS_FILE)), /ids\.json has term 3/);
});

test('a term in a commit message or a path is refused, and the path is not printed', (t) => {
  const r = repo();
  t.after(r.done);
  const message = r.commit('a.md', 'clean', 'add Fake_Report.pdf notes');
  assert.match(privateRefusal(push(message), r.dir, path.join(r.dir, TERMS_FILE)), /commit message or author has term 2/);
  const r2 = repo();
  t.after(r2.done);
  // Its contents hold a term too, so the file is reported twice; neither report may name it.
  const named = r2.commit('99999999999-notes.md', 'mail someone@example-uni.edu');
  const refusal = privateRefusal(push(named), r2.dir, path.join(r2.dir, TERMS_FILE));
  assert.match(refusal, /a file path has term 1/);
  assert.ok(!refusal.includes('99999999999'));
});

test('only commits the remote lacks are checked', (t) => {
  const r = repo();
  t.after(r.done);
  const old = r.commit('a.md', 'roll 99999999999');
  r.git('update-ref', 'refs/remotes/origin/main', old);
  const head = r.commit('b.md', 'clean');
  assert.deepEqual(commitsToPush(push(head), r.dir), [head]);
  assert.deepEqual(commitProblems([head], TERMS, r.dir).length, 1, 'the older file is still in the tree, so still refused');
  r.remove('a.md');
  const clean = r.git('rev-parse', 'HEAD');
  assert.deepEqual(commitProblems([clean], TERMS, r.dir), []);
});

test('with no terms file the push is refused, because nothing was checked', (t) => {
  const r = repo();
  t.after(r.done);
  const head = r.commit('a.md', 'clean');
  rmSync(path.join(r.dir, TERMS_FILE));
  assert.match(privateRefusal(push(head), r.dir, path.join(r.dir, TERMS_FILE)), /nothing private could be checked/);
  writeFileSync(path.join(r.dir, TERMS_FILE), '# only a comment\n');
  assert.match(privateRefusal(push(head), r.dir, path.join(r.dir, TERMS_FILE)), /nothing private could be checked/);
});

test('the pre-push hook runs the check before the suites', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../../scripts/pre-push.mjs', import.meta.url), 'utf8');
  const main = source.slice(source.indexOf('async function main'));
  assert.ok(main.indexOf('privateRefusal(refs') > 0);
  assert.ok(main.indexOf('privateRefusal(refs') < main.indexOf('runGate()'));
});

test('the terms file and the local snapshot are ignored by git', () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  for (const file of ['.private-terms', 'ai/eval/extract-identity.local.json']) {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: root });
  }
});

test('the terms are kept beside the AI_ENV_FILE file, outside the repository', () => {
  const env = path.join('C:', 'private', 'ai.env');
  assert.equal(termsFile({ AI_ENV_FILE: env }), path.join('C:', 'private', TERMS_FILE));
  assert.equal(termsFile({}), null);
});

test('with AI_ENV_FILE unset the push is refused, because nothing was checked', (t) => {
  const r = repo();
  t.after(r.done);
  const head = r.commit('a.md', 'clean');
  assert.match(privateRefusal(push(head), r.dir, null), /nothing private could be checked/);
});
