/** The coverage-report draft helpers (src/lib/coverageReport.js), without a browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  VERDICT_LABELS, addItem, editCriterion, editItem, isDirty, removeItem
} from '../../src/lib/coverageReport.js';

const base = () => ({
  title: 'T',
  sections: [
    { id: 's1', criteria: [{ id: 'k1', label: 'Met', note: '' }, { id: 'k2', label: 'Met', note: '' }],
      strengths: [{ id: 'a', text: 'x', evidence: [] }], gaps: [], lookClosely: [] },
    { id: 's2', criteria: [{ id: 'k1', label: 'Met', note: '' }], strengths: [], gaps: [], lookClosely: [] }
  ],
  trends: [{ id: 't1', text: 'trend', evidence: [] }],
  mentorNotes: ''
});

test('the four verdict labels are exact', () => {
  assert.deepEqual(VERDICT_LABELS, ['Met', 'Partially met', 'Not found in submission', "Can't assess"]);
});

test('editCriterion changes only that criterion in that section and does not mutate', () => {
  const d = base();
  const before = JSON.stringify(d);
  const out = editCriterion(d, 's1', 'k1', { label: "Can't assess", note: 'n' });
  assert.equal(JSON.stringify(d), before);
  assert.equal(out.sections[0].criteria[0].label, "Can't assess");
  assert.equal(out.sections[0].criteria[0].note, 'n');
  assert.equal(out.sections[0].criteria[1].label, 'Met');
  assert.equal(out.sections[1].criteria[0].label, 'Met');
});

test('removeItem removes from a section list and from trends, immutably', () => {
  const d = base();
  const before = JSON.stringify(d);
  const a = removeItem(d, 's1', 'strengths', 'a');
  assert.equal(a.sections[0].strengths.length, 0);
  const b = removeItem(d, null, 'trends', 't1');
  assert.equal(b.trends.length, 0);
  assert.equal(JSON.stringify(d), before);
});

test('addItem adds a new- item of the right shape', () => {
  const d = base();
  const s = addItem(d, 's1', 'gaps');
  assert.equal(s.sections[0].gaps.length, 1);
  assert.match(s.sections[0].gaps[0].id, /^new-/);
  assert.deepEqual(Object.keys(s.sections[0].gaps[0]).sort(), ['evidence', 'id', 'text']);
  const l = addItem(d, 's1', 'lookClosely');
  assert.deepEqual(Object.keys(l.sections[0].lookClosely[0]).sort(), ['id', 'where', 'why']);
  const t = addItem(d, null, 'trends');
  assert.equal(t.trends.length, 2);
  assert.equal(d.trends.length, 1);
  const two = addItem(addItem(d, null, 'trends'), null, 'trends');
  assert.notEqual(two.trends[1].id, two.trends[2].id);
});

test('editItem edits one item', () => {
  const out = editItem(base(), 's1', 'strengths', 'a', { text: 'y' });
  assert.equal(out.sections[0].strengths[0].text, 'y');
  assert.equal(editItem(base(), null, 'trends', 't1', { text: 'z' }).trends[0].text, 'z');
});

test('isDirty is false for equal content and true after any edit', () => {
  const d = base();
  assert.equal(isDirty(d, base()), false);
  assert.equal(isDirty(d, editCriterion(d, 's1', 'k1', { note: 'x' })), true);
  assert.equal(isDirty(d, { ...d, mentorNotes: 'x' }), true);
});
