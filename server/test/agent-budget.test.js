/**
 * The agent's two guards as plain functions: synthetic databases only, and each
 * person's share of the model calls. The routes that use them have their own
 * tests (copilot-agent*.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { SYNTHETIC_DATABASES, agentDatabaseRefusal } = require('../lib/agentDatabases');
const { ModelCallBudget, MINUTE_MS, DAY_MS } = require('../lib/agentBudget');

// ---------------------------------------------------------------------------
// Synthetic databases only
// ---------------------------------------------------------------------------
test('the agent refuses for chatapp, with the plain sentence', () => {
  assert.equal(agentDatabaseRefusal('chatapp'), 'The agent is not configured on this server.');
});

test('and for the served index, and for anything not listed', () => {
  for (const name of ['chatapp_rag', 'Chatapp_demo', 'chatapp_demo ', '', undefined, 'mentorconnect']) {
    assert.ok(agentDatabaseRefusal(name), String(name));
  }
});

test('the list is the demo, the evaluation fixtures and the tests\' own databases, as the AI service has it', () => {
  assert.deepEqual([...SYNTHETIC_DATABASES].sort(), [
    'chatapp_demo', 'chatapp_demo_eval', 'chatapp_eval', 'chatapp_eval_ctx',
    'chatapp_rag_pytest', 'chatapp_rag_pytest_app', 'chatapp_test'
  ]);
  for (const name of SYNTHETIC_DATABASES) assert.equal(agentDatabaseRefusal(name), null);
  assert.ok(Object.isFrozen(SYNTHETIC_DATABASES));
});

test('the AI service keeps the same list', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const config = fs.readFileSync(path.join(__dirname, '..', '..', 'ai', 'config.py'), 'utf8');
  const block = /AGENT_SYNTHETIC_DATABASES = frozenset\(\{([\s\S]*?)\}\)/.exec(config)[1];
  const names = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(names, [...SYNTHETIC_DATABASES].sort());
});

// ---------------------------------------------------------------------------
// Each person's share
// ---------------------------------------------------------------------------
function budget(perMinute = 12, perDay = 60) {
  const clock = { t: 1_000_000 };
  return { b: new ModelCallBudget({ perMinute, perDay, now: () => clock.t }), clock };
}

test('a turn reserves its worst case, and a second that would pass the minute is refused', () => {
  const { b } = budget(12, 60);
  assert.ok(b.reserve('u', 11).entry);
  assert.deepEqual(b.reserve('u', 11), { limit: 'minute' });
});

test('settled to what it spent, the rest of the reservation is free again', () => {
  const { b } = budget(12, 60);
  const { entry } = b.reserve('u', 11);
  b.settle(entry, 2);
  assert.equal(b.used('u', MINUTE_MS), 2);
  assert.ok(b.reserve('u', 10).entry);
});

test('settling never adds calls, and ignores a missing figure', () => {
  const { b } = budget();
  const { entry } = b.reserve('u', 11);
  b.settle(entry, 50);
  assert.equal(b.used('u', MINUTE_MS), 11);
  b.settle(entry, undefined);
  b.settle(entry, NaN);
  assert.equal(b.used('u', MINUTE_MS), 11);
  b.settle(entry, -3);
  assert.equal(b.used('u', MINUTE_MS), 0);
});

test('the minute rolls over, and the day still counts', () => {
  const { b, clock } = budget(12, 30);
  b.settle(b.reserve('u', 11).entry, 10);
  clock.t += MINUTE_MS;
  b.settle(b.reserve('u', 11).entry, 10);
  clock.t += MINUTE_MS;
  assert.equal(b.used('u', MINUTE_MS), 0);
  assert.equal(b.used('u', DAY_MS), 20);
  assert.deepEqual(b.reserve('u', 11), { limit: 'day' }, '20 + 11 > 30');
});

test('the day rolls over too', () => {
  const { b, clock } = budget(12, 11);
  b.reserve('u', 11);
  assert.deepEqual(b.reserve('u', 11), { limit: 'day' });
  clock.t += DAY_MS;
  assert.ok(b.reserve('u', 11).entry);
});

test('each person is counted alone', () => {
  const { b } = budget(11, 11);
  b.reserve('a', 11);
  assert.ok(b.reserve('b', 11).entry);
});

test('the day is checked first, so the sentence says when it will be available again', () => {
  const { b } = budget(11, 11);
  b.reserve('u', 11);
  assert.deepEqual(b.reserve('u', 11), { limit: 'day' });
});
