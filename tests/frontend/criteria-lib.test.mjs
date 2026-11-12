/**
 * The criteria-confirmation helpers (src/lib/criteria.js), without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addRow,
  mergeRows,
  problemWith,
  removeRow,
  rowsFrom,
  toConfirmBody,
  updateRow
} from '../../src/lib/criteria.js';

const extracted = {
  criteria: [
    { id: 'c1', sourceText: 'Clear aims', marks: 5, weight: 10 },
    { id: 'c2', sourceText: 'Good method', marks: null, weight: null }
  ],
  rejected: [],
  notRead: []
};
const latest = {
  n: 2,
  confirmedAt: '2026-11-13T00:00:00Z',
  by: 'x',
  criteria: [{ id: 'k1', text: 'My aims', sourceText: 'Clear aims', marks: 6, weight: 20, origin: 'c1', from: ['c1'] }]
};
const fresh = { id: 's1', extracted, versions: [], latest: null };
const confirmed = { id: 's1', extracted, versions: [latest], latest };

const row = (key, o = {}) => ({
  key,
  text: key,
  from: [key],
  sourceText: `q-${key}`,
  marks: 1,
  weight: 1,
  ...o
});

test('rowsFrom: with no version, one row per extracted criterion', () => {
  const rows = rowsFrom(fresh, { fromExtraction: false });
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => [r.text, r.from, r.sourceText, r.marks, r.weight]),
    [
      ['Clear aims', ['c1'], 'Clear aims', 5, 10],
      ['Good method', ['c2'], 'Good method', null, null]
    ]
  );
  assert.notEqual(rows[0].key, rows[1].key);
});

test('rowsFrom: the latest version wins unless fromExtraction is true', () => {
  const rows = rowsFrom(confirmed, { fromExtraction: false });
  assert.deepEqual(
    rows.map((r) => [r.text, r.from, r.sourceText, r.marks, r.weight]),
    [['My aims', ['k1'], 'Clear aims', 6, 20]]
  );
  const again = rowsFrom(confirmed, { fromExtraction: true });
  assert.deepEqual(again.map((r) => r.from), [['c1'], ['c2']]);
});

test('mergeRows: replaced at the first position, from joined in order, texts and quotes joined', () => {
  const rows = [row('a'), row('b'), row('c'), row('d')];
  const out = mergeRows(rows, ['d', 'b']);
  assert.equal(out.length, 3);
  assert.equal(out[0].key, 'a');
  assert.equal(out[2].key, 'c');
  assert.deepEqual(out[1].from, ['b', 'd']);
  assert.equal(out[1].text, 'b / d');
  assert.equal(out[1].sourceText, 'q-b\n…\nq-d');
  assert.equal(out[1].marks, 2);
  assert.equal(out[1].weight, 2);
});

test('mergeRows: marks and weight are null when any selected row has none', () => {
  const out = mergeRows([row('a'), row('b', { marks: null, weight: null })], ['a', 'b']);
  assert.equal(out.length, 1);
  assert.equal(out[0].marks, null);
  assert.equal(out[0].weight, null);
});

test('mergeRows: fewer than two selected changes nothing', () => {
  const rows = [row('a'), row('b')];
  assert.deepEqual(mergeRows(rows, ['a']), rows);
});

test('addRow, removeRow and updateRow', () => {
  const rows = [row('a'), row('b')];
  const added = addRow(rows);
  assert.equal(added.length, 3);
  assert.deepEqual(added[2].from, []);
  assert.equal(added[2].sourceText, '');
  assert.equal(rows.length, 2);

  assert.deepEqual(removeRow(rows, 'a').map((r) => r.key), ['b']);

  const updated = updateRow(rows, 'b', { text: 'new' });
  assert.equal(updated[1].text, 'new');
  assert.equal(updated[0].text, 'a');
  assert.equal(rows[1].text, 'b');
});

test('toConfirmBody: exactly the four keys, trimmed, never sourceText, id or origin', () => {
  const body = toConfirmBody([
    row('a', { text: '  hello  ', marks: undefined, weight: undefined, id: 'k9', origin: 'x' })
  ]);
  assert.deepEqual(body, {
    criteria: [{ text: 'hello', from: ['a'], marks: null, weight: null }]
  });
  assert.deepEqual(Object.keys(body.criteria[0]).sort(), ['from', 'marks', 'text', 'weight']);
});

test('problemWith: empty text, and 40 versus 41 rows', () => {
  const many = (n) => Array.from({ length: n }, (_, i) => row(`r${i}`));
  assert.equal(problemWith(many(40)), null);
  assert.match(problemWith(many(41)), /40/);
  assert.match(problemWith([row('a', { text: '   ' })]), /wording/);
  assert.equal(problemWith([]), null);
});
