/**
 * The file helpers the assignment-brief UI shares with hand-ins
 * (src/lib/attachments.js), without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_FILE_BYTES,
  MAX_FILES,
  pickProblem,
  uploadBriefFiles
} from '../../src/lib/attachments.js';

const file = (name, size = 10) => ({ name, size });

test('pickProblem: nothing chosen is not a problem', () => {
  assert.equal(pickProblem(0, [], 'assignment'), null);
});

test('pickProblem: a few small files are fine', () => {
  assert.equal(pickProblem(1, [file('a.pdf'), file('b.txt')], 'assignment'), null);
});

test('pickProblem: the count includes the files already attached', () => {
  const picked = [file('a.pdf'), file('b.pdf')];
  assert.equal(pickProblem(MAX_FILES - 2, picked, 'assignment'), null);
  assert.equal(
    pickProblem(MAX_FILES - 1, picked, 'assignment'),
    `Up to ${MAX_FILES} files per assignment`
  );
});

test('pickProblem: the noun is the caller\'s', () => {
  assert.equal(pickProblem(MAX_FILES, [file('a.pdf')], 'hand-in'), `Up to ${MAX_FILES} files per hand-in`);
});

test('pickProblem: names the file that is over the size limit', () => {
  const msg = pickProblem(0, [file('ok.pdf'), file('big.zip', MAX_FILE_BYTES + 1)], 'assignment');
  assert.match(msg, /^big\.zip is over 10 MB$/);
  assert.equal(pickProblem(0, [file('exact.zip', MAX_FILE_BYTES)], 'assignment'), null);
});

/** An authFetch stand-in that answers each call from a script, and records them. */
function scripted(replies) {
  const calls = [];
  const authFetch = async (path, init) => {
    calls.push({ path, init });
    const r = replies[calls.length - 1];
    if (r instanceof Error) throw r;
    return {
      ok: r.ok,
      json: async () => {
        if (r.badJson) throw new Error('not json');
        return r.body;
      }
    };
  };
  return { authFetch, calls };
}

test('uploadBriefFiles: posts each file to the brief, in order, in field "file"', async () => {
  const { authFetch, calls } = scripted([
    { ok: true, body: { attachments: [{ name: 'a' }] } },
    { ok: true, body: { attachments: [{ name: 'a' }, { name: 'b' }] } }
  ]);

  const out = await uploadBriefFiles(authFetch, 'abc123', [
    new File(['x'], 'a.txt'),
    new File(['y'], 'b.txt')
  ]);

  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.attachments, [{ name: 'a' }, { name: 'b' }]);
  assert.equal(calls.length, 2);
  for (const [i, name] of ['a.txt', 'b.txt'].entries()) {
    assert.equal(calls[i].path, '/api/assignments/abc123/files');
    assert.equal(calls[i].init.method, 'POST');
    assert.equal(calls[i].init.body.get('file').name, name);
  }
});

test('uploadBriefFiles: a refusal is reported with the server\'s words and the rest still go', async () => {
  const { authFetch, calls } = scripted([
    { ok: false, body: { error: 'That file type is not allowed' } },
    { ok: true, body: { attachments: [{ name: 'b' }] } },
    { ok: false, badJson: true }
  ]);

  const out = await uploadBriefFiles(authFetch, 'id', [
    new File(['x'], 'a.exe'),
    new File(['y'], 'b.txt'),
    new File(['z'], 'c.txt')
  ]);

  assert.equal(calls.length, 3);
  assert.deepEqual(out.attachments, [{ name: 'b' }]);
  assert.deepEqual(out.errors, [
    'a.exe: That file type is not allowed',
    'c.txt: could not be attached'
  ]);
});

test('uploadBriefFiles: a network failure is reported per file, never thrown', async () => {
  const { authFetch } = scripted([new Error('offline')]);
  const out = await uploadBriefFiles(authFetch, 'id', [new File(['x'], 'a.txt')]);
  assert.equal(out.attachments, null);
  assert.deepEqual(out.errors, ['a.txt: could not reach the server']);
});

import { rubricActions, rubricBadge } from '../../src/lib/attachments.js';

test('rubricBadge: no rubric field, or isRubric false, shows nothing', () => {
  assert.equal(rubricBadge({ name: 'a.pdf' }), null);
  assert.equal(rubricBadge(null), null);
  assert.equal(rubricBadge({ rubric: { isRubric: false, shared: false } }), null);
});

test('rubricBadge: unshared and shared rubric text', () => {
  assert.equal(rubricBadge({ rubric: { isRubric: true, shared: false } }), 'Rubric · mentor only');
  assert.equal(
    rubricBadge({ rubric: { isRubric: true, shared: true } }),
    'Rubric · shared with students'
  );
});

test('rubricActions: no buttons when the viewer cannot edit', () => {
  const f = { rubric: { isRubric: true, shared: true } };
  assert.deepEqual(rubricActions(f, false), { rubric: null, share: null });
});

test('rubricActions: an ordinary file offers only Mark as rubric', () => {
  const a = rubricActions({ name: 'a.pdf' }, true);
  assert.deepEqual(a.rubric, { label: 'Mark as rubric', body: { rubric: true } });
  assert.equal(a.share, null);
});

test('rubricActions: an unshared rubric offers Unmark and Share', () => {
  const a = rubricActions({ rubric: { isRubric: true, shared: false } }, true);
  assert.deepEqual(a.rubric, { label: 'Unmark rubric', body: { rubric: false } });
  assert.deepEqual(a.share, { label: 'Share with students', body: { shared: true } });
});

test('rubricActions: a shared rubric offers Stop sharing', () => {
  const a = rubricActions({ rubric: { isRubric: true, shared: true } }, true);
  assert.deepEqual(a.share, { label: 'Stop sharing', body: { shared: false } });
});
