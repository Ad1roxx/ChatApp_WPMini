/**
 * What the assistant panel decides, without a browser (src/lib/copilot.js).
 * The panel itself is tested in a browser in copilot-panel.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANCHOR } from '../../src/lib/anchors.js';
import {
  MESSAGES,
  anchorOf,
  chipLabel,
  isRecord,
  recordKindOf,
  recordTarget,
  outcomeOf,
  pagesOf,
  refusalFor,
  shortenPassage,
  splitAnswer
} from '../../src/lib/copilot.js';

const c1 = { handle: 1, title: 'report.pdf', startPage: 2, endPage: 2, heading: 'Results' };

test('handles the response listed become references', () => {
  assert.deepEqual(splitAnswer('Five [1].', [c1]), ['Five ', { handle: 1, citation: c1 }, '.']);
});

test('a handle the response did not list stays as text', () => {
  assert.deepEqual(splitAnswer('Five [7] and [1]', [c1]), ['Five [7] and ', { handle: 1, citation: c1 }]);
});

test('with no citations, everything is text', () => {
  assert.deepEqual(splitAnswer('Five [1].', []), ['Five [1].']);
});

test('markup in an answer is just a string', () => {
  const nasty = '<img src=x onerror=alert(1)> [javascript:alert(1)](javascript:alert(1)) [1]';
  const parts = splitAnswer(nasty, [c1]);
  assert.equal(parts[0], '<img src=x onerror=alert(1)> [javascript:alert(1)](javascript:alert(1)) ');
  assert.deepEqual(parts[1], { handle: 1, citation: c1 });
});

test('the only thing taken from a response is a well-formed answer', () => {
  const body = { error: 'Traceback: internals', message: 'internals', status: 'error' };
  for (const status of [200, 400, 401, 403, 404, 409, 429, 500, 502, 503, 0]) {
    assert.doesNotMatch(JSON.stringify(outcomeOf(status, body)), /internals/);
  }
});

test('each status has its own plain message', () => {
  assert.equal(outcomeOf(429, null).message, MESSAGES.limited);
  assert.equal(outcomeOf(503, null).message, MESSAGES.unavailable);
  assert.equal(outcomeOf(502, null).message, MESSAGES.failed);
  assert.equal(outcomeOf(0, null).message, MESSAGES.failed);
  assert.equal(outcomeOf(409, { error: 'anything at all' }).message, MESSAGES.ended);
});

test('an abstention is its own state, with our sentence, whatever came back', () => {
  for (const message of ['something else', '<img src=x onerror=alert(1)>', '', null, undefined]) {
    assert.deepEqual(outcomeOf(200, { status: 'abstained', message }), {
      state: 'abstained',
      message: MESSAGES.abstained
    });
  }
});

test('a 200 with the wrong shape is a failure, not a blank panel', () => {
  for (const body of [null, {}, { status: 'answered' }, { status: 'answered', answer: '   ' }, { status: 'error' }]) {
    assert.equal(outcomeOf(200, body).state, 'failed');
  }
});

test('only an active mentorship has no refusal, and only ended says ended', () => {
  assert.equal(refusalFor('active'), null);
  assert.equal(refusalFor('ended'), MESSAGES.ended);
  assert.equal(refusalFor('pending'), MESSAGES.notActive);
  assert.equal(refusalFor('declined'), MESSAGES.notActive);
});

test('pages, chip labels and anchors', () => {
  assert.equal(pagesOf(c1), 'page 2');
  assert.equal(pagesOf({ startPage: 2, endPage: 3 }), 'pages 2-3');
  assert.equal(pagesOf({ startPage: null }), undefined);
  assert.equal(chipLabel(c1), 'Source 1: report.pdf, page 2');
  assert.equal(chipLabel({ handle: 2, title: 'a.docx', heading: 'Summary' }), 'Source 2: a.docx, Summary');
  assert.equal(anchorOf({ sourceType: 'goal', sourceId: 'abc' }), 'source-goal-abc');
});

test('a passage is cut at about 300 characters, at a word', () => {
  const long = 'word '.repeat(200);
  const short = shortenPassage(long);
  assert.ok(short.length <= 301);
  assert.ok(short.endsWith('word…'));
  assert.equal(shortenPassage('  a\n\n b  '), 'a b');
});

// ---------------------------------------------------------------------------
// The agent's answers (S4 Step 5)
// ---------------------------------------------------------------------------
const MID = 'dddddddddddddddddddddddd';
const OTHER = 'cccccccccccccccccccccccc';
const ID = 'eeeeeeeeeeeeeeeeeeeeeee1';
const t1 = { handle: 'T1', kind: 'goal', id: ID, mentorshipId: MID, title: 'Be ready' };
const p1 = { handle: '1', title: 'design.pdf', sourceType: 'attachment' };

test("an agent's answer cites records as [T1] and passages as [1], by their text", () => {
  assert.deepEqual(splitAnswer('Left [T1], see [1].', [t1, p1]), [
    'Left ', { handle: 'T1', citation: t1 }, ', see ', { handle: '1', citation: p1 }, '.'
  ]);
});

test('an unlisted [T7] stays text, and S2 number handles still work', () => {
  assert.deepEqual(splitAnswer('Left [T7].', [t1]), ['Left [T7].']);
  const s2 = { handle: 1, title: 'report.pdf' };
  assert.deepEqual(splitAnswer('Five [1].', [s2]), ['Five ', { handle: 1, citation: s2 }, '.']);
});

test('only a T handle is a record', () => {
  assert.equal(isRecord(t1), true);
  assert.equal(isRecord(p1), false);
  assert.equal(isRecord({ handle: 1 }), false);
});

test('a record in this mentorship leads to its row here; a file summary to its hand-in', () => {
  assert.deepEqual(recordTarget(t1, MID), { anchor: `source-goal-${ID}` });
  assert.deepEqual(recordTarget({ ...t1, kind: 'session' }, MID), { anchor: `source-session-${ID}` });
  assert.deepEqual(recordTarget({ ...t1, kind: 'file' }, MID), { anchor: `source-submission-${ID}` });
  assert.equal(recordKindOf({ kind: 'file' }), 'hand-in');
});

test('a record in another mentorship leads to that page, at its row', () => {
  assert.deepEqual(recordTarget({ ...t1, kind: 'submission', mentorshipId: OTHER }, MID), {
    path: `/mentorships/${OTHER}#source-submission-${ID}`
  });
});

test('ids that are not ids, and kinds with no row, lead nowhere', () => {
  assert.equal(recordTarget({ ...t1, id: 'javascript:alert(1)' }, MID), null);
  assert.equal(recordTarget({ ...t1, mentorshipId: '../../admin' }, MID), null);
  assert.equal(recordTarget({ ...t1, kind: 'counts' }, MID), null);
  assert.equal(recordTarget({ ...t1, kind: 'constructor' }, MID), null);
});

test('a URL hash is followed only when it is one of our own row anchors', () => {
  assert.ok(ANCHOR.test(`source-session-${ID}`));
  for (const bad of [`source-x-${ID}`, 'source-goal-123', `source-goal-${ID}x`, 'login', '']) assert.ok(!ANCHOR.test(bad), bad);
});

test("a turn a cap stopped, and one refused because the mentorship ended, get our sentences", () => {
  assert.deepEqual(outcomeOf(200, { status: 'stopped', message: 'internals' }), {
    state: 'stopped', message: MESSAGES.stopped
  });
  assert.deepEqual(outcomeOf(200, { status: 'refused', httpStatus: 409, message: 'internals' }), {
    state: 'refused', message: MESSAGES.ended
  });
  assert.equal(outcomeOf(200, { status: 'refused', httpStatus: 403 }).state, 'failed');
});

test("an answer's notes are kept, strings only", () => {
  const out = outcomeOf(200, { status: 'answered', answer: 'x [T1]', citations: [t1], notes: ['I covered 1 of 1.', { x: 1 }, 7] });
  assert.deepEqual(out.notes, ['I covered 1 of 1.']);
  assert.deepEqual(outcomeOf(200, { status: 'answered', answer: 'x' }).notes, []);
});
