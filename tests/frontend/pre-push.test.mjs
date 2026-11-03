/**
 * The pre-push gate. Its suites are replaced with tiny Node commands, so this never
 * runs the real ones, which would run this file again.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { nothingToTest, refusalBefore, runGate, suiteEnv, SUITES } from '../../scripts/pre-push.mjs';

const ZERO = '0'.repeat(40);
const HEAD = 'a'.repeat(40);
const ref = (sha) => `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;
const fake = (name, code) => ({ name, command: process.execPath, args: ['-e', `console.log("from ${name}"); process.exit(${code})`], cwd: '.' });
const quiet = () => {};

test('every suite passing passes', async () => {
  const results = await runGate([fake('a', 0), fake('b', 0)], process.env, quiet);
  assert.deepEqual(results.map((r) => r.passed), [true, true]);
});

test('one failure fails, and the suites after it still run', async () => {
  const results = await runGate([fake('a', 1), fake('b', 0)], process.env, quiet);
  assert.deepEqual(results.map((r) => r.passed), [false, true]);
});

test('a failure shows the output of the suite that failed', async () => {
  const lines = [];
  await runGate([fake('broken', 1)], process.env, (line) => lines.push(line));
  assert.match(lines.join('\n'), /from broken/);
});

test('a suite that cannot start is a failure, not a skip', async () => {
  const [result] = await runGate([{ name: 'gone', command: 'no-such-command-anywhere', args: [], cwd: '.' }], process.env, quiet);
  assert.equal(result.passed, false);
});

test('the gate runs all three test suites and the key scan', () => {
  assert.deepEqual(SUITES.map((s) => s.name), ['Python tests', 'Node tests', 'Frontend tests', 'Key scan']);
});

test('a dirty tree is refused, untracked files included', () => {
  assert.match(refusalBefore(ref(HEAD), HEAD, ' M src/App.jsx\n'), /uncommitted/);
  assert.match(refusalBefore(ref(HEAD), HEAD, '?? new.py\n'), /uncommitted/);
});

test('pushing anything but HEAD is refused, because the suites would not test it', () => {
  assert.match(refusalBefore(ref('b'.repeat(40)), HEAD, ''), /other than HEAD/);
  assert.equal(refusalBefore(ref(HEAD), HEAD, ''), null);
});

test('a push that only deletes a branch has nothing to test', () => {
  assert.equal(nothingToTest(`(delete) ${ZERO} refs/heads/old ${HEAD}\n`), true);
  assert.equal(nothingToTest(ref(HEAD)), false);
});

test('the suites cannot spend quota, cannot skip Atlas, and are not redirected by git', () => {
  const env = suiteEnv({ AI_LIVE_SMOKE: '1', GIT_DIR: '/elsewhere', PATH: 'x' });
  assert.equal(env.AI_LIVE_SMOKE, undefined);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.AI_TESTS_REQUIRE_ATLAS, '1');
  assert.equal(env.PATH, 'x');
});

test('the tracked hook runs this gate', () => {
  assert.ok(existsSync('.githooks/pre-push'));
  assert.match(readFileSync('.githooks/pre-push', 'utf8'), /scripts\/pre-push\.mjs/);
});
