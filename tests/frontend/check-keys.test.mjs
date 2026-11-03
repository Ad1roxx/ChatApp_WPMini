/**
 * The key scan. Fake keys are assembled at run time, so this file cannot trip it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { problemsIn } from '../../scripts/check-keys.mjs';

const google = `AIza${'x'.repeat(35)}`;
const groq = `gsk_${'y'.repeat(30)}`;

test('a Google-shaped key anywhere but the Firebase config fails', () => {
  assert.equal(problemsIn('ai/eval/out.txt', `key: ${google}`).length, 1);
  assert.equal(problemsIn('src/other.js', google).length, 1);
});

test('the one Firebase web key is allowed, in that file only', () => {
  assert.deepEqual(problemsIn('src/firebase.js', `apiKey: "${google}"`), []);
});

test('a second key in the Firebase config fails', () => {
  assert.equal(problemsIn('src/firebase.js', `${google} ${google}`).length, 1);
});

test('a Groq key fails everywhere, the Firebase config included', () => {
  assert.equal(problemsIn('ai/x.py', groq).length, 1);
  assert.equal(problemsIn('src/firebase.js', groq).length, 1);
});

test('the Gemini key from ai/.env fails even in the Firebase config, whatever its shape', () => {
  assert.equal(problemsIn('src/firebase.js', google, { GEMINI_API_KEY: google }).length, 1);
  assert.equal(problemsIn('docs/a.md', 'value-with-any-shape', { GROQ_API_KEY: 'value-with-any-shape' }).length, 1);
});

test('a report names the kind of problem, never the key', () => {
  const report = problemsIn('a.txt', `${google} ${groq}`, { GEMINI_API_KEY: google }).join(' ');
  assert.doesNotMatch(report, /AIza|gsk_/);
});
