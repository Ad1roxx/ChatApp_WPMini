/**
 * The pre-push gate: refuses a push unless every suite, the linter and the key scan pass, and no
 * commit being pushed holds a private detail of the app's real records
 * (`scripts/check-private.mjs`, with its terms kept beside the AI_ENV_FILE file).
 *
 * Run by `.githooks/pre-push`, which `npm run hooks:install` turns on. Git hands it the
 * refs being pushed on stdin. It needs MongoDB on 27017 and the Atlas container on 27018.
 *
 * Three things keep a pass meaning what it says:
 *
 * - **The tree must be clean, and the push must be HEAD.** The suites run on the working
 *   tree, so a pass says nothing about a commit that differs from it.
 * - **A skip does not count.** The Python tests that need Atlas skip when it is down, which is
 *   right on a laptop and wrong here, so `AI_TESTS_REQUIRE_ATLAS` makes them fail.
 * - **Nothing here spends quota.** The opt-in flag for real provider calls is removed.
 *
 * All of them always run, so one failure does not hide another.
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateRefusal } from './check-private.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE_LIMIT_MS = 15 * 60 * 1000;
const NO_COMMIT = /^0+$/;

const PYTHON = path.join(ROOT, 'ai', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

export const SUITES = [
  { name: 'Python tests', command: PYTHON, args: ['-m', 'pytest'], cwd: path.join(ROOT, 'ai') },
  { name: 'Node tests', command: 'npm test', cwd: path.join(ROOT, 'server'), shell: true },
  { name: 'Frontend tests', command: 'npm run test:frontend', cwd: ROOT, shell: true },
  { name: 'Lint', command: 'npm run lint', cwd: ROOT, shell: true },
  { name: 'Key scan', command: 'npm run check:keys', cwd: ROOT, shell: true },
];

export function suiteEnv(env = process.env) {
  const clean = { ...env, AI_TESTS_REQUIRE_ATLAS: '1', CHECK_KEYS_REQUIRE_VALUES: '1' };
  delete clean.AI_LIVE_SMOKE;
  // Git sets these for its hooks, and they would redirect any git command a test runs.
  for (const name of Object.keys(clean)) if (name.startsWith('GIT_')) delete clean[name];
  return clean;
}

const pushedCommits = (refs) => refs.split('\n').filter(Boolean)
  .map((line) => line.split(/\s+/)[1])
  .filter((sha) => !NO_COMMIT.test(sha));

/** True when this push only deletes refs, so there is nothing to test. */
export function nothingToTest(refs) {
  return pushedCommits(refs).length === 0;
}

/** Why this push cannot be checked, or null. `refs` is what git gives on stdin. */
export function refusalBefore(refs, head, status) {
  if (status.trim()) return 'The tree has uncommitted changes, so the suites would not be testing what is being pushed. Commit or stash them, untracked files included.';
  if (pushedCommits(refs).some((sha) => sha !== head)) return 'This pushes something other than HEAD, which the suites would not be testing. Check it out first.';
  return null;
}

function runSuite(suite, env) {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = '';
    const child = suite.shell
      ? spawn(suite.command, { cwd: suite.cwd, env, shell: true })
      : spawn(suite.command, suite.args || [], { cwd: suite.cwd, env });
    const timer = setTimeout(() => {
      output += `\nStopped after ${SUITE_LIMIT_MS / 60000} minutes.`;
      child.kill();
    }, SUITE_LIMIT_MS);
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    let finished = false;
    const finish = (passed) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ name: suite.name, passed, output, seconds: Math.round((Date.now() - started) / 1000) });
    };
    // A suite that cannot start is a failure, never a skip.
    child.on('error', (err) => { output += String(err); finish(false); });
    child.on('close', (code) => finish(code === 0));
  });
}

/** Every suite, in order, whatever the earlier ones did. */
export async function runGate(suites = SUITES, env = suiteEnv(), log = console.log) {
  const results = [];
  for (const suite of suites) {
    log(`pre-push: ${suite.name}...`);
    const result = await runSuite(suite, env);
    log(`pre-push: ${suite.name} ${result.passed ? 'passed' : 'FAILED'} in ${result.seconds} s`);
    if (!result.passed) log(result.output.split('\n').slice(-40).join('\n'));
    results.push(result);
  }
  return results;
}

async function main() {
  const refs = readFileSync(0, 'utf8');
  if (nothingToTest(refs)) return 0;
  const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  const refusal = refusalBefore(refs, git('rev-parse', 'HEAD'), git('status', '--porcelain'));
  if (refusal) {
    console.error(`pre-push: push refused. ${refusal}`);
    return 1;
  }
  // Before the suites: every commit being pushed, not just the tree they test.
  const leak = privateRefusal(refs, ROOT);
  if (leak) {
    console.error(`pre-push: push refused. ${leak}`);
    return 1;
  }
  console.log('pre-push: no private details in the commits being pushed.');
  const failed = (await runGate()).filter((r) => !r.passed).map((r) => r.name);
  if (failed.length) {
    console.error(`pre-push: push refused. Failed: ${failed.join(', ')}.`);
    return 1;
  }
  console.log('pre-push: every suite and the key scan passed.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main());
}
