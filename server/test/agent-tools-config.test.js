/**
 * The agent's signing key at startup.
 *
 * Unset: the tool endpoint answers 503 and the rest of the server runs as
 * before. Set to something that cannot do its job: the server refuses to start.
 * The case that matters most is a key equal to AI_SERVICE_SECRET, because the
 * AI service holds that one, and a key it holds is a key it can mint with.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { start, stop, api, seed } = require('./helpers/harness');

/** Run the server with this environment until it exits; resolve with code and output. */
function boot(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['index.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        PORT: '3198',
        MONGODB_URI: 'mongodb://127.0.0.1:27017/chatapp_test',
        FIREBASE_PROJECT_ID: 'test-project',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test('an unusable signing key stops the server starting', async (t) => {
  await seed();
  await t.test('too short', async () => {
    const { code, out } = await boot({ AI_SERVICE_SECRET: 'stub-secret', AGENT_TOKEN_SECRET: 'short' });
    assert.equal(code, 1);
    assert.match(out, /at least 32 characters/);
  });
  await t.test('the same as the AI service\'s secret', async () => {
    const same = 'x'.repeat(40);
    const { code, out } = await boot({ AI_SERVICE_SECRET: same, AGENT_TOKEN_SECRET: same });
    assert.equal(code, 1);
    assert.match(out, /must not be the same as AI_SERVICE_SECRET/);
    assert.doesNotMatch(out, /x{40}/, 'and it does not print either key');
  });
});

test('with no signing key the endpoint answers 503 and nothing else changes', async (t) => {
  await start({ extraEnv: { AI_SERVICE_SECRET: 'stub-secret', AGENT_TOKEN_SECRET: '', AI_SERVICE_URL: '' } });
  t.after(() => stop());
  const res = await api('/internal/agent/tools/list_goals', {
    method: 'POST',
    body: { args: {} },
    headers: { 'X-AI-Secret': 'stub-secret', Authorization: 'Bearer anything' }
  });
  assert.equal(res.status, 503);
  assert.match((await res.json()).error, /not configured/);
});
