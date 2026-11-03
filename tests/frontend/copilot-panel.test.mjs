/**
 * The assistant panel, in a real browser, with every server stubbed in the browser.
 *
 * The first behavioural tests the frontend has had. No MongoDB, no ai/ and no Express:
 * Vite serves the real app, signed in through the dev switch, and `page.route` answers
 * everything it asks for. So this runs anywhere Node and Chromium do, CI included.
 *
 * Assertions are about behaviour, not screenshots. The ones that matter most are that
 * model text is inert, and that nothing from a failed response reaches the screen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5199;
const SERVER = 'http://stubbed.invalid';
const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const MID = 'dddddddddddddddddddddddd';
const SUB = 'eeeeeeeeeeeeeeeeeeeeeee1';
const ASSIGNMENT = 'eeeeeeeeeeeeeeeeeeeeeee2';
const GOAL = 'eeeeeeeeeeeeeeeeeeeeeee3';
const RESOURCE = 'eeeeeeeeeeeeeeeeeeeeeee4';
const FILE = 'fffffffffffffffffffffff1';
const QUESTION = 'How many retries does my handler make?';

const me = { _id: ME, displayName: 'Rohan Kapoor', email: 'r@x.invalid', role: 'student', photoURL: '' };
const mentor = { _id: 'b'.repeat(24), displayName: 'Meera Iyer', email: 'm@x.invalid', role: 'mentor', photoURL: '' };

const PDF_CITATION = {
  handle: 1, title: 'rate-limiter-design.pdf', sourceType: 'attachment', sourceId: FILE, chunkIndex: 2, url: null,
  parentType: 'submission', parentId: SUB, parentTitle: 'Hand-in: Design rate limiting', attachmentId: FILE, fileKind: 'pdf',
  heading: 'When Redis is down', startPage: 3, endPage: 3,
  passage: `The limiter fails open. ${'If Redis cannot be reached the request is allowed. '.repeat(12)}`
};
const DOCX_CITATION = {
  ...PDF_CITATION, handle: 2, title: 'postmortem.docx', fileKind: 'docx', heading: 'Root cause', startPage: null, endPage: null,
  passage: 'The pool ran out.'
};
const GOAL_CITATION = {
  handle: 3, title: 'Be ready for backend interviews', sourceType: 'goal', sourceId: GOAL, chunkIndex: 0, url: null,
  parentType: null, parentId: null, parentTitle: null, attachmentId: null, fileKind: null, heading: null, startPage: null,
  endPage: null, passage: 'Be ready by March.'
};
const RESOURCE_CITATION = {
  ...GOAL_CITATION, handle: 4, title: 'k6 documentation', sourceType: 'resource', sourceId: RESOURCE,
  url: 'javascript:window.__xss=1', passage: 'For load tests.'
};
const ASSIGNMENT_CITATION = {
  ...GOAL_CITATION, handle: 5, title: 'Design rate limiting', sourceType: 'assignment', sourceId: ASSIGNMENT, passage: 'Design it.'
};

const answered = (answer, citations = []) => ({
  status: 200,
  body: { status: 'answered', answer, citations, message: null, cause: null, promptVersion: 's2-v3' }
});

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
  // Vite prepares modules on first load, which takes tens of seconds. The real page once
  // here, panel chunk included, so that the first test is not the one that pays for it.
  await (await open({ timeout: 180000 })).close();
});

test.after(async () => {
  await browser?.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  else vite?.kill();
});

/**
 * The app, with the world stubbed. `ask` is the answer to /copilot/ask: a
 * { status, body, delay } or a function of the request count returning one.
 * `never: true` never replies. Returns what the test needs to look at.
 */
async function open({ status = 'active', ask = answered('Yes.'), timeout = 30000 } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  // How long Vite takes to serve a page is not what is being tested, and on a slow
  // machine a first load can pass 30 s even after the warm-up in `before`.
  page.setDefaultNavigationTimeout(180000);
  const seen = { asks: [], files: [], dialogs: 0, console: [], pageErrors: [] };

  page.on('dialog', (d) => { seen.dialogs += 1; d.dismiss(); });
  page.on('console', (m) => seen.console.push(m.text()));
  page.on('pageerror', (e) => seen.pageErrors.push(e.message));

  const cors = {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*',
    'access-control-expose-headers': '*'
  };
  const json = (route, body, code = 200) =>
    route.fulfill({ status: code, contentType: 'application/json', headers: cors, body: typeof body === 'string' ? body : JSON.stringify(body) });

  await page.route(`${SERVER}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith('/socket.io')) return route.abort();
    if (p === '/api/auth/login') return json(route, me);
    if (p === '/api/mentorships') return json(route, [{ _id: MID, status, topic: 'Backend', student: me, mentor, createdAt: new Date().toISOString() }]);
    if (p === `/api/mentorships/${MID}/goals`) {
      return json(route, [{ _id: GOAL, title: 'Be ready for backend interviews', description: '', status: 'active', milestones: [] }]);
    }
    if (p === `/api/mentorships/${MID}/assignments`) {
      return json(route, [{
        _id: SUB, status: 'submitted', student: me, text: 'Attached.', attachments: [], history: [],
        assignment: { _id: ASSIGNMENT, title: 'Design rate limiting', instructions: '', dueAt: new Date(Date.now() + 864e5).toISOString(), mentor }
      }]);
    }
    if (p === `/api/mentorships/${MID}/resources`) {
      return json(route, [{ _id: RESOURCE, title: 'k6 documentation', url: 'https://example.com/k6', note: '', addedBy: mentor }]);
    }
    if (p === `/api/mentorships/${MID}/copilot/ask`) {
      seen.asks.push(request.postDataJSON());
      const reply = typeof ask === 'function' ? ask(seen.asks.length) : ask;
      if (reply.never) return undefined; // left hanging on purpose
      if (reply.delay) await new Promise((r) => setTimeout(r, reply.delay));
      return json(route, reply.body, reply.status);
    }
    if (p.startsWith(`/api/submissions/${SUB}/files/`)) {
      seen.files.push(p);
      return route.fulfill({ status: 200, headers: cors, contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 stub') });
    }
    return json(route, []);
  });

  await page.goto(`http://localhost:${PORT}/mentorships/${MID}`);
  await page.getByRole('heading', { name: 'Ask about this mentorship' }).waitFor();
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Ask about this mentorship' }) });
  const close = () => context.close();
  return { page, panel, seen, close };
}

async function send({ page, panel }, question = QUESTION) {
  await panel.getByLabel('Your question').fill(question);
  await panel.getByRole('button', { name: 'Ask', exact: true }).click();
  return page;
}

test('an answer shows as text with a chip for each listed handle', async () => {
  const t = await open({ ask: answered('It fails open [1], and the pool ran out [2].', [PDF_CITATION, DOCX_CITATION]) });
  await send(t);

  const text = t.panel.getByText('It fails open', { exact: false });
  await text.waitFor();
  assert.equal(await t.panel.getByRole('button', { name: /^Source 1: rate-limiter-design\.pdf, page 3$/ }).count(), 1);
  assert.equal(await t.panel.getByRole('button', { name: /^Source 2: postmortem\.docx, Root cause$/ }).count(), 1);
  assert.deepEqual(t.seen.asks, [{ question: QUESTION }]);
  await t.close();
});

test('a handle the response did not list is plain text, never a link or a chip', async () => {
  const t = await open({ ask: answered('Listed [1], not listed [7].', [PDF_CITATION]) });
  await send(t);
  await t.panel.getByText('not listed [7].', { exact: false }).waitFor();

  assert.equal(await t.panel.locator('button[aria-label^="Source"]').count(), 1);
  assert.equal(await t.panel.getByRole('button', { name: /Source 7/ }).count(), 0);
  assert.equal(await t.panel.locator('a').count(), 0);
  await t.close();
});

test('a PDF chip shows its source and opens the file at the cited page', async () => {
  const t = await open({ ask: answered('It fails open [1].', [PDF_CITATION]) });
  await send(t);
  await t.panel.getByRole('button', { name: /^Source 1/ }).click();

  const card = t.panel.getByRole('complementary', { name: 'Source 1' });
  const words = await card.innerText();
  assert.match(words, /rate-limiter-design\.pdf/);
  assert.match(words, /When Redis is down/);
  assert.match(words, /page 3/);
  assert.match(words, /The limiter fails open/);
  const passage = await card.locator('blockquote').innerText();
  assert.ok(passage.length <= 301, `the passage is ${passage.length} characters`);
  assert.ok(passage.endsWith('…'));

  await card.getByRole('button', { name: 'Open at page 3' }).click();
  const frame = t.page.locator('dialog iframe');
  await frame.waitFor();
  assert.match(await frame.getAttribute('src'), /^blob:.*#page=3$/);
  assert.deepEqual(t.seen.files, [`/api/submissions/${SUB}/files/${FILE}`]);
  await t.close();
});

test('a Word chip downloads, because a browser cannot show it', async () => {
  const t = await open({ ask: answered('The pool ran out [2].', [DOCX_CITATION]) });
  await send(t);
  await t.panel.getByRole('button', { name: /^Source 2/ }).click();

  const card = t.panel.getByRole('complementary', { name: 'Source 2' });
  assert.match(await card.innerText(), /Root cause/);
  const [download] = await Promise.all([
    t.page.waitForEvent('download'),
    card.getByRole('button', { name: 'Download the file' }).click()
  ]);
  assert.equal(download.suggestedFilename(), 'postmortem.docx');
  await t.close();
});

test('a record chip goes to its row on this page, and a resource never to its URL', async () => {
  const t = await open({
    ask: answered('Goal [3], resource [4], brief [5].', [GOAL_CITATION, RESOURCE_CITATION, ASSIGNMENT_CITATION])
  });
  await send(t);

  for (const [name, anchor, label] of [
    [/^Source 3/, `source-goal-${GOAL}`, 'Go to the goal'],
    [/^Source 4/, `source-resource-${RESOURCE}`, 'Go to the saved resource'],
    [/^Source 5/, `source-assignment-${ASSIGNMENT}`, 'Go to the assignment brief']
  ]) {
    await t.panel.getByRole('button', { name }).click();
    await t.panel.getByRole('button', { name: label }).click();
    assert.equal(await t.page.evaluate(() => document.activeElement?.id), anchor);
  }

  await t.panel.getByRole('button', { name: /^Source 4/ }).click();
  assert.equal(await t.panel.locator('a').count(), 0, 'the resource URL became a link');
  assert.equal(await t.page.evaluate(() => window.__xss), undefined);
  await t.close();
});

test('an abstention shows the standard message and is not an error', async () => {
  const t = await open({
    ask: { status: 200, body: { status: 'abstained', answer: null, citations: [], message: 'NOT OUR WORDS', cause: 'declined' } }
  });
  await send(t);

  await t.panel.getByText("I couldn't find an answer to that in what I can search in this mentorship.").waitFor();
  assert.equal(await t.panel.getByRole('alert').count(), 0);
  assert.equal(await t.panel.getByRole('button', { name: 'Try again' }).count(), 0);
  assert.doesNotMatch(await t.panel.innerText(), /NOT OUR WORDS|declined/);
  await t.close();
});

for (const [status, message] of [
  ['ended', "The assistant isn't available for ended mentorships."],
  ['pending', 'The assistant is only available in active mentorships.'],
  ['declined', 'The assistant is only available in active mentorships.']
]) {
  test(`a ${status} mentorship says so, offers no question box, and asks nothing`, async () => {
    const t = await open({ status });
    await t.panel.getByText(message).waitFor();
    assert.equal(await t.panel.getByLabel('Your question').count(), 0);
    assert.deepEqual(t.seen.asks, []);
    await t.close();
  });
}

test('a 409 during the session shows the same sentence, not the body', async () => {
  const t = await open({ ask: { status: 409, body: { error: 'NOT OUR WORDS' } } });
  await send(t);
  await t.panel.getByText("The assistant isn't available for ended mentorships.").waitFor();
  assert.doesNotMatch(await t.panel.innerText(), /NOT OUR WORDS/);
  await t.close();
});

for (const [status, message] of [
  [429, 'The assistant has reached its limit for now. Try again in a minute.'],
  [503, "The assistant isn't available right now. The rest of this page still works."],
  [502, "The assistant couldn't answer that. Try again."],
  [500, "The assistant couldn't answer that. Try again."]
]) {
  test(`a ${status} shows its own plain message, nothing from the body, and can be retried`, async () => {
    const t = await open({
      ask: (n) => (n === 1
        ? { status, body: { error: 'Traceback: secret internals', message: 'secret internals' } }
        : answered('Second time lucky.'))
    });
    await send(t);
    await t.panel.getByRole('alert').getByText(message).waitFor();
    assert.doesNotMatch(await t.page.locator('body').innerText(), /secret internals/);

    await t.panel.getByRole('button', { name: 'Try again' }).click();
    await t.panel.getByText('Second time lucky.').waitFor();
    assert.equal(t.seen.asks.length, 2);
    assert.deepEqual(t.seen.asks[1], { question: QUESTION });
    await t.close();
  });
}

test('a body that is not JSON is a failure, not a blank panel', async () => {
  const t = await open({ ask: { status: 200, body: '<html>proxy error</html>' } });
  await send(t);
  await t.panel.getByRole('alert').getByText("The assistant couldn't answer that. Try again.").waitFor();
  assert.doesNotMatch(await t.panel.innerText(), /proxy error/);
  await t.close();
});

test('while a question is pending it shows loading, and cannot be sent twice', async () => {
  const t = await open({ ask: { ...answered('Done.'), delay: 900 } });
  const box = t.panel.getByLabel('Your question');
  await box.fill(QUESTION);
  const ask = t.panel.getByRole('button', { name: 'Ask', exact: true });

  // Two clicks in one task: what state alone would not stop.
  await ask.evaluate((b) => { b.click(); b.click(); });
  await t.panel.getByText("Searching this mentorship's material…").first().waitFor();
  assert.equal(await box.isDisabled(), true);
  assert.equal(await ask.isDisabled(), true);

  await t.panel.getByText('Done.').waitFor();
  assert.equal(t.seen.asks.length, 1);
  assert.equal(await box.isDisabled(), false);
  assert.equal(await t.panel.getByText('Searching this', { exact: false }).count(), 0);
  await t.close();
});

test('a server that never answers ends in the failure message, not an endless spinner', async () => {
  const t = await open({ ask: { never: true } });
  await send(t);
  await t.panel.getByText("Searching this mentorship's material…").first().waitFor();
  await t.panel.getByRole('alert').getByText("The assistant couldn't answer that. Try again.").waitFor({ timeout: 17000 });
  assert.equal(await t.panel.getByLabel('Your question').isDisabled(), false);
  await t.close();
});

test('markup in an answer, a passage or a title is inert text', async () => {
  const nasty = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
  const link = '[click me](javascript:window.__xss=1) <a href="javascript:window.__xss=1">go</a>';
  const citation = {
    ...GOAL_CITATION, handle: 1, title: `${nasty} title`, heading: `${nasty} heading`, passage: `${nasty} passage ${link}`
  };
  const t = await open({ ask: answered(`${nasty} answer ${link} [1]`, [citation]) });
  await send(t, `${nasty} question`);

  await t.panel.getByText('answer [click me]', { exact: false }).waitFor();
  await t.panel.getByRole('button', { name: /^Source 1/ }).click();
  await t.panel.getByRole('complementary', { name: 'Source 1' }).waitFor();

  const words = await t.panel.innerText();
  assert.match(words, /<img src=x onerror=/, 'the markup should be visible, as text');
  assert.equal(t.seen.dialogs, 0);
  assert.equal(await t.page.evaluate(() => window.__xss), undefined);
  for (const selector of ['img', 'script', 'a', '[onerror]', '[href^="javascript"]']) {
    assert.equal(await t.panel.locator(selector).count(), 0, `the panel holds a ${selector}`);
  }
  assert.deepEqual(t.seen.pageErrors, []);
  await t.close();
});

test('no question or answer reaches the console', async () => {
  const t = await open({ ask: (n) => (n === 1 ? answered('PRIVATE-ANSWER [1]', [PDF_CITATION]) : { status: 502, body: {} }) });
  await send(t, 'PRIVATE-QUESTION-ONE');
  await t.panel.getByText('PRIVATE-ANSWER', { exact: false }).waitFor();
  await send(t, 'PRIVATE-QUESTION-TWO');
  await t.panel.getByRole('alert').waitFor();

  assert.deepEqual(t.seen.console.filter((line) => /PRIVATE-/.test(line)), []);
  await t.close();
});

test('it can be driven from the keyboard, and answers are announced', async () => {
  const t = await open({ ask: answered('It fails open [1].', [PDF_CITATION]) });
  const box = t.panel.getByLabel('Your question');
  await box.focus();
  await t.page.keyboard.type('First line');
  await t.page.keyboard.press('Shift+Enter');
  await t.page.keyboard.type('second line');
  assert.equal(await box.inputValue(), 'First line\nsecond line');
  assert.deepEqual(t.seen.asks, [], 'Shift+Enter should not send');

  await t.page.keyboard.press('Enter');
  await t.panel.getByText('It fails open', { exact: false }).waitFor();
  assert.deepEqual(t.seen.asks, [{ question: 'First line\nsecond line' }]);
  assert.equal(await t.panel.locator('[aria-live="polite"]').count(), 1);
  assert.equal(await t.panel.locator('[aria-live="polite"]').getByText('It fails open', { exact: false }).count(), 1);

  const chip = t.panel.getByRole('button', { name: /^Source 1/ });
  await chip.focus();
  assert.equal(await chip.getAttribute('aria-expanded'), 'false');
  await t.page.keyboard.press('Enter');
  assert.equal(await chip.getAttribute('aria-expanded'), 'true');
  await t.panel.getByRole('complementary', { name: 'Source 1' }).waitFor();
  await t.close();
});

test('the length cap is shown and enforced, and an empty question cannot be sent', async () => {
  const t = await open();
  const box = t.panel.getByLabel('Your question');
  const ask = t.panel.getByRole('button', { name: 'Ask', exact: true });
  assert.equal(await ask.isDisabled(), true);
  assert.equal(await box.getAttribute('maxlength'), '1000');
  await box.fill('abcde');
  assert.match(await t.panel.innerText(), /5\s*\/\s*1000/);
  await box.fill('   ');
  assert.equal(await ask.isDisabled(), true);
  await box.press('Enter');
  assert.deepEqual(t.seen.asks, []);
  await t.close();
});

test('history is kept for the session and gone on reload, and says what it can see', async () => {
  const t = await open({ ask: answered('An answer.') });
  await send(t);
  await t.panel.getByText('An answer.').waitFor();
  await send(t, 'And another?');
  assert.equal(await t.panel.locator('ol > li').count(), 2);
  assert.match(await t.panel.innerText(), /this mentorship's material only/);
  assert.match(await t.panel.innerText(), /check the cited source/);

  const stored = await t.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  assert.doesNotMatch(stored, /An answer|How many retries/);

  await t.page.reload();
  await t.page.getByRole('heading', { name: 'Ask about this mentorship' }).waitFor();
  assert.equal(await t.panel.locator('ol > li').count(), 0);
  await t.close();
});
