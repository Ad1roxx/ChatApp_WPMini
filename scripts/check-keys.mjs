/**
 * No provider key in anything git would keep.
 *
 *   npm run check:keys              # every tracked and every new, unignored file
 *
 * Fails on anything shaped like a Google or Groq API key, and, where the file named by
 * `AI_ENV_FILE` exists, on the exact values of the secrets in it. Also fails if that file
 * is inside the repository, or if `ai/.env` or `server/.env` holds a secret or the real
 * admin addresses (those live in `server.env` beside it): other tools work in this folder
 * and can read any file in it, git-ignored or not. Printed by file and kind only:
 * a scan that echoed a key would be a leak of its own.
 *
 * With CHECK_KEYS_REQUIRE_VALUES=1 (the pre-push gate), having no values to check for is a
 * failure rather than a weaker scan. CI has no secrets file, so it scans by shape.
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

/** The secrets assigned non-empty values in an env file's text. */
export function secretsIn(text) {
  const keys = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(GEMINI_API_KEY|GROQ_API_KEY|AI_SERVICE_SECRET|AGENT_PROPOSAL_SECRET|ADMIN_EMAILS)\s*=\s*(.+?)\s*$/);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, '');
    if (value) keys[match[1]] = value;
  }
  return keys;
}

/** What is wrong with where the secrets are kept; pure, so it can be tested. */
export function placementProblems({ root, envFile, repoEnvText, serverRepoEnvText }) {
  const found = [
    ...Object.keys(secretsIn(repoEnvText || '')).map((name) => `ai/.env holds ${name}: move it to the AI_ENV_FILE file`),
    ...Object.keys(secretsIn(serverRepoEnvText || '')).map((name) => `server/.env holds ${name}: move it to server.env beside the AI_ENV_FILE file`)
  ];
  if (envFile) {
    const relative = path.relative(path.resolve(root), path.resolve(envFile));
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) found.push('AI_ENV_FILE is inside the repository');
  }
  return found;
}

const readIf = (file) => (file && existsSync(file) ? readFileSync(file, 'utf8') : '');

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
  const envFile = process.env.AI_ENV_FILE || '';
  const aiSecrets = secretsIn(readIf(envFile));
  const serverPrivate = secretsIn(readIf(envFile ? path.join(path.dirname(envFile), 'server.env') : ''));
  const secrets = { ...aiSecrets, ...serverPrivate };
  const haveValues = Object.keys(aiSecrets).length > 0 && Object.keys(serverPrivate).length > 0;
  let scanned = 0;
  let failed = false;

  for (const problem of placementProblems({ root: ROOT, envFile, repoEnvText: readIf(path.join(ROOT, 'ai', '.env')), serverRepoEnvText: readIf(path.join(ROOT, 'server', '.env')) })) {
    console.error(problem);
    failed = true;
  }
  if (!haveValues && process.env.CHECK_KEYS_REQUIRE_VALUES === '1') {
    console.error('AI_ENV_FILE does not name a file with secrets in it, with a server.env beside it, so their exact values could not be checked for.');
    failed = true;
  }

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

  console.log(`Scanned ${scanned} files${haveValues ? ', with the values in the private files' : ', by shape only'}: ${failed ? 'PROBLEMS FOUND' : 'clean'}.`);
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
