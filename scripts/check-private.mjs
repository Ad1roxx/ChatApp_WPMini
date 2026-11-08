/**
 * No identifying detail of the app's real records in anything pushed.
 *
 *   npm run check:private           # every tracked and every new, unignored file
 *
 * The pre-push gate also runs `commitProblems` on every commit a push would add to
 * the remote: each commit's whole tree, its paths and its message, so a detail added
 * in one commit and deleted in the next is still refused.
 *
 * The terms (the real file's name, the roll number, the institution's email domain,
 * the real records' ids) are kept one per line in a file called `private-terms`, beside
 * the file AI_ENV_FILE names and outside the repository: a check that listed them in a
 * tracked file would publish them itself, and other tools can read anything in this folder.
 * Matching ignores case. A report names a term by its line number, never its text,
 * and leaves out any path that contains one. With no terms file the check refuses
 * rather than passes, because it would have checked nothing.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TERMS_FILE = 'private-terms';
const NO_COMMIT = /^0+$/;

/** One term per line; blank lines and `#` comments are skipped. */
export function parseTerms(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
}

/** The numbers (from 1) of the terms in `text`, ignoring case. Pure, so it can be tested. */
export function termsIn(text, terms) {
  const lower = text.toLowerCase();
  return terms.flatMap((term, i) => (lower.includes(term.toLowerCase()) ? [i + 1] : []));
}

/** Where the terms are kept, or null when AI_ENV_FILE is not set. */
export function termsFile(env = process.env) {
  return env.AI_ENV_FILE ? path.join(path.dirname(env.AI_ENV_FILE), TERMS_FILE) : null;
}

/** The terms, or null when there are none to check with. */
export function loadTerms(file = termsFile()) {
  if (!file || !existsSync(file)) return null;
  const terms = parseTerms(readFileSync(file, 'utf8'));
  return terms.length ? terms : null;
}

const named = (numbers) => `term${numbers.length > 1 ? 's' : ''} ${numbers.join(', ')}`;
const shown = (file, terms) => (termsIn(file, terms).length ? 'a path that itself contains a term' : file);

function gitIn(root) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    } catch (err) {
      if (err.status === 1 && args[0] === 'grep') return ''; // grep found nothing
      throw err;
    }
  };
}

/** The commits a push would add to the remote, from the refs git gives the hook on stdin. */
export function commitsToPush(refs, root = ROOT) {
  const git = gitIn(root);
  const shas = refs.split('\n').filter(Boolean).map((line) => line.split(/\s+/)[1]).filter((sha) => sha && !NO_COMMIT.test(sha));
  const out = new Set();
  for (const sha of shas) {
    for (const commit of git(['rev-list', sha, '--not', '--remotes']).split('\n').filter(Boolean)) out.add(commit);
  }
  return [...out];
}

/** What each commit holds of the terms: its message and people, its paths, its files. */
export function commitProblems(commits, terms, root = ROOT) {
  const git = gitIn(root);
  const problems = [];
  for (const sha of commits) {
    const short = sha.slice(0, 7);
    const meta = termsIn(git(['show', '-s', '--format=%an%n%ae%n%cn%n%ce%n%B', sha]), terms);
    if (meta.length) problems.push(`${short}: the commit message or author has ${named(meta)}`);
    const paths = termsIn(git(['ls-tree', '-r', '--name-only', sha]), terms);
    if (paths.length) problems.push(`${short}: a file path has ${named(paths)}`);
    const args = ['grep', '-I', '-i', '-F', '-l'];
    for (const term of terms) args.push('-e', term);
    const files = git([...args, sha, '--']).split('\n').filter(Boolean).map((line) => line.slice(sha.length + 1));
    for (const file of files) {
      const found = termsIn(git(['show', `${sha}:${file}`]), terms);
      if (found.length) problems.push(`${short}: ${shown(file, terms)} has ${named(found)}`);
    }
  }
  return problems;
}

/** Why this push would publish something private, or null. */
export function privateRefusal(refs, root = ROOT, file = termsFile()) {
  const terms = loadTerms(file);
  if (!terms) return `There is no ${TERMS_FILE} file with terms in it beside AI_ENV_FILE, so nothing private could be checked for.`;
  const problems = commitProblems(commitsToPush(refs, root), terms, root);
  return problems.length ? `It would publish private details:\n  ${problems.join('\n  ')}` : null;
}

function main() {
  const terms = loadTerms();
  if (!terms) {
    console.error(`No ${TERMS_FILE} file with terms in it beside AI_ENV_FILE: nothing private could be checked for.`);
    process.exit(1);
  }
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  let scanned = 0;
  let failed = false;
  for (const file of files) {
    const full = path.join(ROOT, file);
    if (termsIn(file, terms).length) {
      console.error(`a path that itself contains a term`);
      failed = true;
    }
    if (!existsSync(full)) continue;
    const bytes = readFileSync(full);
    if (bytes.includes(0)) continue; // binary
    scanned += 1;
    const found = termsIn(bytes.toString('utf8'), terms);
    if (found.length) {
      console.error(`${shown(file, terms)}: ${named(found)}`);
      failed = true;
    }
  }
  console.log(`Scanned ${scanned} files for ${terms.length} private terms: ${failed ? 'PRIVATE DETAILS FOUND' : 'clean'}.`);
  if (failed) process.exit(1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
