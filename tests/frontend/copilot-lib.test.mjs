/**
 * What the assistant panel decides, without a browser (src/lib/copilot.js).
 * The panel itself is tested in a browser in copilot-panel.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGES,
  anchorOf,
  chipLabel,
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
  assert.equal(outcomeOf(409, { error: MESSAGES.ended }).message, MESSAGES.ended);
  assert.equal(outcomeOf(409, { error: MESSAGES.notActive }).message, MESSAGES.notActive);
  assert.equal(outcomeOf(409, { error: 'anything else' }).message, MESSAGES.ended);
});

test('an abstention is its own state, with our sentence, whatever came back', () => {
  assert.deepEqual(outcomeOf(200, { status: 'abstained', message: 'something else' }), {
    state: 'abstained',
    message: MESSAGES.abstained
  });
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
