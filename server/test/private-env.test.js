/**
 * ADMIN_EMAILS comes from a file outside the repository (BUILD_NOTES Entry 103).
 *
 * Every value here is invented, in a temporary folder. The real file is never read:
 * each server started here is given its own AI_ENV_FILE. These servers exit, or are
 * stopped, before any test would depend on the database.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { serverEnvFile, serverEnvProblem } = require('../lib/privateEnv');

const MARK = /Admin allowlist: (\d+) address/;

/** Start the real server; resolve when it exits, or as soon as it reports its allowlist. */
function boot(extraEnv) {
  const env = { ...process.env };
  delete env.ADMIN_EMAILS;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['index.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...env,
        PORT: '3197',
        MONGODB_URI: 'mongodb://127.0.0.1:27017/chatapp_test',
        FIREBASE_PROJECT_ID: 'test-project',
        ...extraEnv
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    const see = (d) => {
      out += d;
      if (MARK.test(out)) child.kill();
    };
    child.stdout.on('data', see);
    child.stderr.on('data', see);
    const timer = setTimeout(() => child.kill(), 15000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function folder(t, serverEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  if (serverEnv !== undefined) fs.writeFileSync(path.join(dir, 'server.env'), serverEnv);
  return path.join(dir, 'ai.env');
}

test('the file is beside the AI_ENV_FILE file', () => {
  const named = path.join('C:', 'private', 'ai.env');
  assert.equal(serverEnvFile({ AI_ENV_FILE: named }), path.join('C:', 'private', 'server.env'));
  assert.equal(serverEnvFile({}), null);
  assert.equal(serverEnvFile({ AI_ENV_FILE: '   ' }), null);
});

test('each way of being missing has its own plain sentence', () => {
  assert.match(serverEnvProblem({}), /AI_ENV_FILE is not set/);
  assert.match(serverEnvProblem({ AI_ENV_FILE: 'x/ai.env' }, () => false), /no server\.env beside/);
  assert.equal(serverEnvProblem({ AI_ENV_FILE: 'x/ai.env' }, () => true), null);
});

test('the server will not start with AI_ENV_FILE unset, and says why', async () => {
  const { code, out } = await boot({ AI_ENV_FILE: '' });
  assert.equal(code, 1);
  assert.match(out, /AI_ENV_FILE is not set/);
  assert.doesNotMatch(out, /Traceback|at .*index\.js/);
});

test('the server will not start when server.env is not there', async (t) => {
  const { code, out } = await boot({ AI_ENV_FILE: folder(t) });
  assert.equal(code, 1);
  assert.match(out, /no server\.env beside/);
});

test('the addresses in the file reach the allowlist', async (t) => {
  const { out } = await boot({ AI_ENV_FILE: folder(t, 'ADMIN_EMAILS=a@example.test,b@example.test\n') });
  assert.equal(MARK.exec(out)?.[1], '2');
});

test('the environment wins over the file', async (t) => {
  const { out } = await boot({
    AI_ENV_FILE: folder(t, 'ADMIN_EMAILS=a@example.test,b@example.test\n'),
    ADMIN_EMAILS: 'only@example.test'
  });
  assert.equal(MARK.exec(out)?.[1], '1');
});

test('the example file assigns no addresses', () => {
  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.doesNotMatch(example, /^\s*ADMIN_EMAILS\s*=/m);
  assert.match(example, /server\.env/);
});
