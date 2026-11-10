/** The demo's check on the proposal key: scripts/demo-secrets.mjs, with no file and no process. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MISSING_PROPOSAL_SECRET, NO_ENV_FILE, SHORT_PROPOSAL_SECRET, proposalSecret } from '../../scripts/demo-secrets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const env = { AI_ENV_FILE: 'C:/keys/ai.env' };
const GOOD = 'a'.repeat(64);
const file = (text) => () => text;

test('a key in server.env is returned', () => {
  assert.deepEqual(proposalSecret(env, file(`ADMIN_EMAILS=x@y\nAGENT_PROPOSAL_SECRET=${GOOD}\n`)), { secret: GOOD });
});

test('it reads server.env beside the AI_ENV_FILE file', () => {
  let asked;
  proposalSecret(env, (name) => { asked = name; return ''; });
  assert.equal(path.basename(asked), 'server.env');
  assert.equal(path.dirname(asked).replaceAll('\\', '/'), 'C:/keys');
});

for (const [name, text] of [['absent', 'ADMIN_EMAILS=x@y\n'], ['blank', 'AGENT_PROPOSAL_SECRET=\n'], ['only spaces', 'AGENT_PROPOSAL_SECRET="   "\n']]) {
  test(`${name}: the demo is refused, with the plain message`, () => {
    assert.deepEqual(proposalSecret(env, file(text)), { problem: MISSING_PROPOSAL_SECRET });
  });
}

test('with AI_ENV_FILE unset, nothing is read from the current folder', () => {
  for (const unset of [{}, { AI_ENV_FILE: '' }, { AI_ENV_FILE: '   ' }]) {
    let read = false;
    assert.deepEqual(proposalSecret(unset, () => { read = true; return `AGENT_PROPOSAL_SECRET=${GOOD}`; }), { problem: NO_ENV_FILE });
    assert.equal(read, false);
  }
});

test('no file at all is refused the same way', () => {
  const missing = () => { throw new Error('ENOENT'); };
  assert.deepEqual(proposalSecret(env, missing), { problem: MISSING_PROPOSAL_SECRET });
});

test('a key too short to sign with is refused', () => {
  assert.deepEqual(proposalSecret(env, file('AGENT_PROPOSAL_SECRET=short\n')), { problem: SHORT_PROPOSAL_SECRET });
});

test('a message never contains the value', () => {
  const secretish = 'visible-short-value';
  const { problem } = proposalSecret(env, file(`AGENT_PROPOSAL_SECRET=${secretish}\n`));
  assert.ok(!problem.includes(secretish));
});

test('the message says what is missing and how to fix it, in plain words', () => {
  assert.match(MISSING_PROPOSAL_SECRET, /AGENT_PROPOSAL_SECRET is missing from server\.env/);
  assert.match(MISSING_PROPOSAL_SECRET, /Generate one with/);
});

test('the demo refuses before starting anything, and gives the key to Express alone', () => {
  const demo = readFileSync(path.join(ROOT, 'scripts', 'demo.mjs'), 'utf8').replace(/\r\n/g, '\n');
  const refusal = demo.indexOf('const proposal = proposalSecret();');
  assert.ok(refusal > 0, 'the check is there');
  assert.ok(refusal < demo.indexOf("docker('start'"), 'before Docker is touched');
  assert.ok(refusal < demo.indexOf("run('ai'"), 'before anything is started');
  assert.match(demo.slice(refusal, refusal + 120), /if \(proposal\.problem\) fail\(proposal\.problem\);/);
  assert.ok(!/proposalSecret\s*=\s*randomBytes/.test(demo), 'no longer made up for each run');
  const ai = demo.slice(demo.indexOf("run('ai'"), demo.indexOf("run('api'"));
  assert.ok(!ai.includes('AGENT_PROPOSAL_SECRET') && !ai.includes('proposal'), 'the AI service is not given it');
  const api = demo.slice(demo.indexOf("run('api'"), demo.indexOf("await until('Express'"));
  assert.match(api, /AGENT_PROPOSAL_SECRET: proposal\.secret/);
});
