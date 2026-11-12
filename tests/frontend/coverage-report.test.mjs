/**
 * The coverage report screen and the rubric controls, in a real browser, with every
 * server route stubbed in the browser (the same way as copilot-panel.test.mjs).
 *
 * What matters here: the mentor's edits go to the server as typed and the evidence
 * goes back untouched, export stays off until a saved draft is ticked as reviewed,
 * a student gets none of it, and nothing the server wrote is ever treated as HTML.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5198;
const SERVER = 'http://stubbed.invalid';
const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'b'.repeat(24);
const MID = 'dddddddddddddddddddddddd';
const SUB = 'eeeeeeeeeeeeeeeeeeeeeee1';
const ASSIGNMENT = 'eeeeeeeeeeeeeeeeeeeeeee2';
const REPORT = 'cccccccccccccccccccccc01';
const RUBRIC_FILE = 'fffffffffffffffffffffff1';
const RUBRIC_NAME = 'marking-grid.pdf';
const SECRET_NAME = 'secret-grid.pdf';

const person = (id, role, displayName) => ({ _id: id, displayName, email: `${displayName[0]}@x.invalid`, role, photoURL: '' });
const mentorUser = person(ME, 'mentor', 'Meera Iyer');
const studentUser = person(ME, 'student', 'Rohan Kapoor');
const otherStudent = person(OTHER, 'student', 'Sana Rao');
const otherMentor = person(OTHER, 'mentor', 'Dev Shah');

const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, 'ai/tests/fixtures/s8-draft.json'), 'utf8'));
const clone = (x) => JSON.parse(JSON.stringify(x));

let vite;
let browser;

async function waitForVite() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}`)).ok) return;
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Vite did not start');
}

test.before(async () => {
  vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, VITE_DEV_USER_ID: ME, VITE_SERVER_URL: SERVER }
  });
  await waitForVite();
  browser = await chromium.launch();
});

test.after(async () => {
  await browser?.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  else vite?.kill();
});

/**
 * The app, with the world stubbed. `user` is who is signed in; `world` holds what the
 * server would hold, and is changed by the stubbed writes so that replies are true to them.
 */
async function open({ user, startPath, world }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(180000);
  const seen = { requests: [], pageErrors: [] };
  page.on('pageerror', (e) => seen.pageErrors.push(e.message));
  page.on('dialog', (d) => d.dismiss());

  const cors = {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*',
    'access-control-expose-headers': '*'
  };
  const json = (route, body, code = 200) =>
    route.fulfill({ status: code, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });

  const isMentor = user.role === 'mentor';
  const mentorship = {
    _id: MID, status: 'active', topic: 'Backend', createdAt: new Date().toISOString(),
    student: isMentor ? otherStudent : user, mentor: isMentor ? user : otherMentor
  };
  const due = new Date(Date.now() + 864e5).toISOString();

  await page.route(`${SERVER}/**`, async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith('/socket.io')) return route.abort();
    seen.requests.push({ method, path: p, body: method === 'GET' ? null : request.postDataJSON() });

    if (p === '/api/auth/login') return json(route, user);
    if (p === '/api/mentorships') return json(route, [mentorship]);
    if (p === `/api/mentorships/${MID}/assignments`) {
      return json(route, [{
        _id: SUB, status: 'submitted', student: mentorship.student, text: 'Attached.', attachments: [], history: [],
        assignment: { _id: ASSIGNMENT, title: 'Design rate limiting', instructions: '', dueAt: due, mentor: mentorship.mentor, attachments: world.studentFiles || [] }
      }]);
    }
    if (p === '/api/assignments') {
      return json(route, {
        set: [{ _id: ASSIGNMENT, title: 'Design rate limiting', dueAt: due, summary: { total: 1, handedIn: 0, toReview: 0, overdue: 0, drafts: 0, accepted: 0 } }],
        mine: []
      });
    }
    if (p === `/api/assignments/${ASSIGNMENT}`) {
      return json(route, { _id: ASSIGNMENT, title: 'Design rate limiting', instructions: '', dueAt: due, attachments: world.files, submissions: [] });
    }
    if (p === `/api/assignments/${ASSIGNMENT}/files`) return json(route, { attachments: world.files });
    if (p === `/api/assignments/${ASSIGNMENT}/files/${RUBRIC_FILE}` && method === 'PATCH') {
      const body = request.postDataJSON();
      const f = world.files[0];
      if (body.rubric !== undefined) f.rubric = { isRubric: body.rubric, shared: false };
      if (body.shared !== undefined) f.rubric = { isRubric: true, shared: body.shared };
      return json(route, { attachments: world.files });
    }
    if (p === `/api/mentorships/${MID}/coverage-reports`) {
      if (method === 'POST') return json(route, world.view(), 201);
      return json(route, { reports: world.listed ? [{ id: REPORT, createdAt: new Date().toISOString(), period: '', reviewedAt: world.reviewedAt, exports: [], assignments: ['A', 'B', 'C'] }] : [] });
    }
    if (p === `/api/coverage-reports/${REPORT}`) {
      if (world.notFound) return json(route, { error: 'Not found' }, 404);
      if (method === 'PATCH') {
        world.report = request.postDataJSON().draft;
        world.reviewedAt = null;
      }
      return json(route, world.view());
    }
    if (p === `/api/coverage-reports/${REPORT}/review`) {
      world.reviewedAt = request.postDataJSON().reviewed ? new Date().toISOString() : null;
      return json(route, world.view());
    }
    if (p === `/api/coverage-reports/${REPORT}/export`) {
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 stub') });
    }
    return json(route, []);
  });

  await page.goto(`http://localhost:${PORT}${startPath}`, { timeout: 180000 });
  return { page, seen, close: () => context.close() };
}

const newWorld = (extra = {}) => {
  const w = {
    files: [{ fileId: RUBRIC_FILE, name: RUBRIC_NAME, size: 2048, rubric: { isRubric: false, shared: false } }],
    report: clone(FIXTURE),
    reviewedAt: null,
    listed: false,
    view() {
      return { id: REPORT, mentorship: MID, period: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'draft', reviewedAt: w.reviewedAt, exports: [], draft: w.report };
    },
    ...extra
  };
  return w;
};

const patchesTo = (seen, p) => seen.requests.filter((r) => r.method === 'PATCH' && r.path === p);

test('the mentor can mark a rubric, share it, and stop sharing, and the badge follows', async () => {
  const world = newWorld();
  const t = await open({ user: mentorUser, startPath: '/assignments', world });
  const { page, seen } = t;
  const filesPath = `/api/assignments/${ASSIGNMENT}/files/${RUBRIC_FILE}`;

  await page.getByRole('button', { name: 'See each student' }).click();
  await page.getByRole('button', { name: RUBRIC_NAME, exact: true }).waitFor();

  await page.getByRole('button', { name: 'Mark as rubric' }).click();
  await page.getByText('Rubric · mentor only').waitFor();
  assert.deepEqual(patchesTo(seen, filesPath).map((r) => r.body), [{ rubric: true }]);

  await page.getByRole('button', { name: 'Share with students' }).click();
  await page.getByText('Rubric · shared with students').waitFor();
  assert.deepEqual(patchesTo(seen, filesPath).map((r) => r.body).at(-1), { shared: true });

  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await page.getByText('Rubric · mentor only').waitFor();
  assert.deepEqual(patchesTo(seen, filesPath).map((r) => r.body).at(-1), { shared: false });
  assert.equal(patchesTo(seen, filesPath).length, 3);
  await t.close();
});

test('a student sees no rubric buttons, a shared rubric only as a badge, and an unshared one not at all', async () => {
  const world = newWorld({
    // As the server does: the unshared rubric is not in the student's list at all.
    studentFiles: [
      { fileId: 'f1', name: 'brief.pdf', size: 10, rubric: { isRubric: false, shared: false } },
      { fileId: 'f2', name: 'shared-grid.pdf', size: 10, rubric: { isRubric: true, shared: true } }
    ]
  });
  const t = await open({ user: studentUser, startPath: `/mentorships/${MID}`, world });
  const { page } = t;
  await page.getByRole('button', { name: 'brief.pdf', exact: true }).waitFor();

  await page.getByText('Rubric · shared with students').waitFor();
  for (const name of ['Mark as rubric', 'Unmark rubric', 'Share with students', 'Stop sharing']) {
    assert.equal(await page.getByRole('button', { name }).count(), 0, `${name} was offered to a student`);
  }
  assert.equal(await page.getByText('Rubric · mentor only').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(SECRET_NAME));
  await t.close();
});

test('the mentor drafts, edits, saves, reviews and exports, and export waits for each step', async () => {
  const world = newWorld();
  const original = clone(FIXTURE);
  const t = await open({ user: mentorUser, startPath: `/mentorships/${MID}`, world });
  const { page, seen } = t;
  const exportPdf = page.getByRole('button', { name: 'Export PDF' });
  const exportWord = page.getByRole('button', { name: 'Export Word' });
  const tick = page.getByLabel('I have reviewed this draft');
  const save = page.getByRole('button', { name: 'Save draft' });

  await page.getByRole('heading', { name: 'Coverage reports' }).waitFor();
  await page.getByLabel('Design rate limiting').check();
  await page.getByRole('button', { name: 'Draft a report', exact: true }).click();
  await page.getByText('Draft, reviewed by the mentor.', { exact: false }).waitFor();
  const created = seen.requests.find((r) => r.method === 'POST' && r.path === `/api/mentorships/${MID}/coverage-reports`);
  assert.deepEqual(created.body, { assignmentIds: [ASSIGNMENT] });

  // Nothing is edited, nothing is reviewed: no save, no export.
  assert.equal(await save.isDisabled(), true);
  assert.equal(await exportPdf.isDisabled(), true);
  assert.equal(await exportWord.isDisabled(), true);

  // The evidence is there as a quote, read-only.
  await page.locator('blockquote', { hasText: 'My rule clears one list.' }).first().waitFor();
  assert.equal(await page.locator('blockquote textarea, blockquote input').count(), 0);

  await page.getByLabel('Verdict: States the rule').selectOption("Can't assess");
  await page.getByLabel('Note: States the rule').fill('Check the second page.');
  await page.getByLabel("Mentor's notes").fill('Talk about caching next week.');
  assert.equal(await save.isDisabled(), false);
  assert.equal(await tick.isDisabled(), true, 'review is offered with unsaved changes');

  await save.click();
  await page.getByText('Draft saved').waitFor();
  const patch = patchesTo(seen, `/api/coverage-reports/${REPORT}`).at(-1).body.draft;
  assert.equal(patch.sections[0].criteria[0].label, "Can't assess");
  assert.equal(patch.sections[0].criteria[0].note, 'Check the second page.');
  assert.equal(patch.mentorNotes, 'Talk about caching next week.');
  assert.deepEqual(patch.sections[0].criteria[0].evidence, original.sections[0].criteria[0].evidence);
  assert.deepEqual(patch.sections[0].strengths[0].evidence, original.sections[0].strengths[0].evidence);

  // Saved but not yet ticked.
  await page.waitForFunction(() => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save draft')?.disabled);
  assert.equal(await exportPdf.isDisabled(), true);
  await tick.click(); // checked only once the server has said so, so not .check()
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find((b) => b.textContent === 'Export PDF')?.disabled);
  assert.deepEqual(seen.requests.filter((r) => r.path === `/api/coverage-reports/${REPORT}/review`).map((r) => r.body), [{ reviewed: true }]);
  assert.equal(await exportPdf.isDisabled(), false);
  assert.equal(await exportWord.isDisabled(), false);

  const [download] = await Promise.all([page.waitForEvent('download'), exportPdf.click()]);
  assert.match(download.suggestedFilename(), /\.pdf$/);
  assert.deepEqual(seen.requests.filter((r) => r.path === `/api/coverage-reports/${REPORT}/export`).map((r) => r.body), [{ format: 'pdf' }]);

  // A new unsaved edit takes export away again.
  await page.getByLabel("Mentor's notes").fill('Changed again.');
  assert.equal(await exportPdf.isDisabled(), true);
  assert.equal(await tick.isDisabled(), true);
  await t.close();
});

test('a student gets no coverage reports section, no request for one, and a report URL is not found', async () => {
  const world = newWorld({ notFound: true });
  const t = await open({ user: studentUser, startPath: `/mentorships/${MID}`, world });
  const { page, seen } = t;
  await page.getByRole('heading', { name: 'Assignments' }).waitFor();

  assert.equal(await page.getByRole('heading', { name: 'Coverage reports' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Draft a report' }).count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /Coverage reports|Draft a report|Export PDF/);
  assert.equal(seen.requests.filter((r) => r.path.includes('coverage-report')).length, 0);

  // The app has no page for one report, so there is no URL to open: an address that
  // is not a page goes home, and the server's own 404 for the data is stubbed above.
  await page.goto(`http://localhost:${PORT}/coverage-reports/${REPORT}`);
  await page.waitForURL((u) => u.pathname === '/');
  assert.equal(await page.getByText('Draft, reviewed by the mentor', { exact: false }).count(), 0);
  await t.close();
});

test('markup in a draft is shown as text and never runs', async () => {
  const IMG = '<img src=x onerror="window.__xss=1">';
  const SCRIPT = '<script>window.__xss=2</script>';
  const world = newWorld({ listed: true });
  const d = world.report;
  d.title = IMG;
  d.header.student = SCRIPT;
  d.sections[0].brief = IMG;
  d.sections[0].criteria[0].criterion = SCRIPT;
  d.sections[0].criteria[0].present = IMG;
  d.sections[0].criteria[0].evidence = [{ quote: SCRIPT, where: IMG }];
  d.sections[0].strengths[0].text = SCRIPT;
  d.trends[0].text = IMG;
  d.mentorNotes = SCRIPT;
  const t = await open({ user: mentorUser, startPath: `/mentorships/${MID}`, world });
  const { page } = t;
  await page.getByRole('button', { name: 'Open', exact: true }).click();
  await page.getByText('Draft, reviewed by the mentor.', { exact: false }).waitFor();

  assert.equal(await page.locator('blockquote', { hasText: SCRIPT }).count(), 1, 'the quote is shown as its own characters');
  assert.equal(await page.getByText(IMG, { exact: false }).count() > 0, true);
  assert.equal(await page.locator('img[src="x"]').count(), 0);
  assert.equal(await page.locator('main script, section script').count(), 0);
  assert.equal(await page.getByLabel("Mentor's notes").inputValue(), SCRIPT);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await t.close();
});
