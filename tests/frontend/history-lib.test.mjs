// Paging through a conversation's history (src/lib/history.js): when to offer
// "Show earlier messages", what to ask for, and how the answer joins the screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PAGE, mayHaveEarlier, earlierPath, withEarlier, placeOf, restorePlace } from '../../src/lib/history.js';

const msg = (i) => ({ _id: `m${i}`, timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
const page = (n, from = 0) => Array.from({ length: n }, (_, i) => msg(from + i));

test('a full page may have earlier messages; a short one is the start', () => {
  assert.equal(mayHaveEarlier(page(PAGE)), true);
  assert.equal(mayHaveEarlier(page(PAGE - 1)), false);
  assert.equal(mayHaveEarlier([]), false);
  assert.equal(mayHaveEarlier(null), false);
});

test('the earlier page is asked for before the earliest message on screen', () => {
  const path = earlierPath('/api/groups/g1/messages', page(3, 10));
  assert.equal(path, `/api/groups/g1/messages?before=${encodeURIComponent(msg(10).timestamp)}&beforeId=m10`);
  assert.ok(!path.includes('+') && !path.includes(':'), 'the time is encoded');
});

test('the view is put back where it was after earlier messages go in front', () => {
  const el = { scrollHeight: 1000, scrollTop: 40 };
  const place = placeOf(el);
  el.scrollHeight = 1600; // 600 px of earlier messages were added above
  restorePlace(el, place);
  assert.equal(el.scrollTop, 640, 'the same messages are under the eye');
  assert.equal(placeOf(null), null);
  restorePlace(null, place); // no element: nothing to do, and no throw
});

test('earlier messages go in front, in order, and none is repeated', () => {
  const current = page(3, 5);
  const joined = withEarlier([msg(3), msg(4), msg(5)], current);
  assert.deepEqual(joined.map((m) => m._id), ['m3', 'm4', 'm5', 'm6', 'm7']);
  assert.deepEqual(withEarlier([], current), current);
});
