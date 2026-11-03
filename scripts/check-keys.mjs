/**
 * No provider key in anything git would keep.
 *
 *   npm run check:keys              # every tracked and every new, unignored file
 *
 * Fails on anything shaped like a Google or Groq API key, and, where `ai/.env`
 * exists, on the exact values of the Gemini and Groq keys in it. Printed by file and
 * kind only: a scan that echoed a key would be a leak of its own.
 *
 * One allowance: the Firebase web key in `src/firebase.js`. It is public client
 * config by design, identifying the project to Google rather than authorising
 * anything. It is allowed in that file only, and never if it equals the Gemini key.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOOGLE = /AIza[0-9A-Za-z_-]{35}/g;
const GROQ = /gsk_[0-9A-Za-z]{20,}/g;
const FIREBASE_FILE = 'src/firebase.js';

function envKeys() {
  const file = path.join(ROOT, 'ai', '.env');
  if (!existsSync(file)) return {};
  const keys = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^(GEMINI_API_KEY|GROQ_API_KEY)\s*=\s*(.+?)\s*$/);
    if (match) keys[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return keys;
}

/** The problems in one file's text; pure, so it can be tested. */
export function problemsIn(file, text, secrets = {}) {
  const found = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (value && text.includes(value)) found.push(`the value of ${name}`);
  }
  const google = text.match(GOOGLE) || [];
  if (google.length && file !== FIREBASE_FILE) found.push(`${google.length} Google API key(s)`);
  if (google.length > 1 && file === FIREBASE_FILE) found.push('more than the one allowed Firebase web key');
  const groq = text.match(GROQ) || [];
  if (groq.length) found.push(`${groq.length} Groq API key(s)`);
  return found;
}

function main() {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const secrets = envKeys();
  let scanned = 0;
  let failed = false;

  for (const file of files) {
    const full = path.join(ROOT, file);
    if (!existsSync(full)) continue;
    const bytes = readFileSync(full);
    if (bytes.includes(0)) continue; // binary
    scanned += 1;
    for (const problem of problemsIn(file, bytes.toString('utf8'), secrets)) {
      console.error(`${file}: ${problem}`);
      failed = true;
    }
  }

  console.log(`Scanned ${scanned} files${Object.keys(secrets).length ? ', with the values in ai/.env' : ''}: ${failed ? 'KEYS FOUND' : 'clean'}.`);
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
