/**
 * The key scan. Fake keys are assembled at run time, so this file cannot trip it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { placementProblems, problemsIn, secretsIn } from '../../scripts/check-keys.mjs';

const google = `AIza${'x'.repeat(35)}`;
const groq = `gsk_${'y'.repeat(30)}`;

test('a Google-shaped key anywhere but the Firebase config fails', () => {
  assert.equal(problemsIn('ai/eval/out.txt', `key: ${google}`).length, 1);
  assert.equal(problemsIn('src/other.js', google).length, 1);
});

test('the one Firebase web key is allowed, in that file only', () => {
  assert.deepEqual(problemsIn('src/firebase.js', `apiKey: "${google}"`), []);
});

test('a second key in the Firebase config fails', () => {
  assert.equal(problemsIn('src/firebase.js', `${google} ${google}`).length, 1);
});

test('a Groq key fails everywhere, the Firebase config included', () => {
  assert.equal(problemsIn('ai/x.py', groq).length, 1);
  assert.equal(problemsIn('src/firebase.js', groq).length, 1);
});

test('the Gemini key from the secrets file fails even in the Firebase config, whatever its shape', () => {
  assert.equal(problemsIn('src/firebase.js', google, { GEMINI_API_KEY: google }).length, 1);
  assert.equal(problemsIn('docs/a.md', 'value-with-any-shape', { GROQ_API_KEY: 'value-with-any-shape' }).length, 1);
});

test('a report names the kind of problem, never the key', () => {
  const report = problemsIn('a.txt', `${google} ${groq}`, { GEMINI_API_KEY: google }).join(' ');
  assert.doesNotMatch(report, /AIza|gsk_/);
});

test('every secret is read from an env file, and an empty one does not count', () => {
  const text = `GEMINI_API_KEY=${google}\nGROQ_API_KEY=\n  AI_SERVICE_SECRET="abc"\nAI_HOST=127.0.0.1\n`;
  assert.deepEqual(secretsIn(text), { GEMINI_API_KEY: google, AI_SERVICE_SECRET: 'abc' });
});

test('the proposal key counts as a secret', () => {
  assert.deepEqual(secretsIn('AGENT_PROPOSAL_SECRET=abc\n'), { AGENT_PROPOSAL_SECRET: 'abc' });
});

test('a secret in ai/.env fails, naming it and never its value', () => {
  const problems = placementProblems({ root: 'C:/repo', envFile: 'C:/private/ai.env', repoEnvText: `GROQ_API_KEY=${groq}\n` });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /GROQ_API_KEY/);
  assert.ok(!problems[0].includes(groq));
});

test('ai/.env with only settings passes', () => {
  assert.deepEqual(placementProblems({ root: 'C:/repo', envFile: 'C:/private/ai.env', repoEnvText: 'AI_HOST=127.0.0.1\nGEMINI_API_KEY=\n' }), []);
});

test('a secrets file inside the repository fails, and a sibling folder with a similar name does not', () => {
  assert.equal(placementProblems({ root: 'C:/repo', envFile: 'C:/repo/ai/secrets.env' }).length, 1);
  assert.deepEqual(placementProblems({ root: 'C:/repo', envFile: 'C:/repo-private/ai.env' }), []);
});

test('asked to require the exact values, the scan fails when it has none', () => {
  const script = fileURLToPath(new URL('../../scripts/check-keys.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, AI_ENV_FILE: '', CHECK_KEYS_REQUIRE_VALUES: '1' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be checked for/);
});

test('the pre-push gate requires the exact values, and the key scan is what it runs', async () => {
  const { suiteEnv } = await import('../../scripts/pre-push.mjs');
  assert.equal(suiteEnv({}).CHECK_KEYS_REQUIRE_VALUES, '1');
});

test('asked to require the exact values, the scan fails with secrets but no server.env beside them', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const envFile = path.join(dir, 'ai.env');
  // Made at run time, so that no scanned file can hold it and fail the scan some other way.
  writeFileSync(envFile, `GEMINI_API_KEY=${randomBytes(16).toString('hex')}\n`);
  const script = fileURLToPath(new URL('../../scripts/check-keys.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8',
    env: { ...process.env, AI_ENV_FILE: envFile, CHECK_KEYS_REQUIRE_VALUES: '1' }
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not be checked for/);
});

test('real admin addresses in server/.env fail, naming the setting and never the addresses', () => {
  const address = 'someone@example.test';
  const problems = placementProblems({ root: 'C:/repo', envFile: 'C:/private/ai.env', serverRepoEnvText: `PORT=3001\nADMIN_EMAILS=${address}\n` });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /server\/\.env holds ADMIN_EMAILS/);
  assert.ok(!problems[0].includes(address));
});

test('server/.env with only settings passes', () => {
  assert.deepEqual(placementProblems({ root: 'C:/repo', envFile: 'C:/private/ai.env', serverRepoEnvText: 'PORT=3001\nADMIN_EMAILS=\n' }), []);
});

test('the real admin addresses are among the exact values looked for', () => {
  const value = 'someone@example.test';
  const found = problemsIn('docs/notes.md', `mail ${value}`, secretsIn(`ADMIN_EMAILS=${value}\n`));
  assert.deepEqual(found, ['the value of ADMIN_EMAILS']);
});
