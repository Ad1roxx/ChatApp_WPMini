/**
 * A message the server refuses for being sent too quickly is said to be not sent,
 * and its text goes back in the box (src/lib/notSent.js), in a real browser.
 *
 * Like the other browser tests, every server is stubbed in the browser. Unlike
 * them, the socket is answered rather than refused: `routeWebSocket` speaks just
 * enough of Socket.IO's wire format to accept the connection, confirm a message,
 * and refuse one the way the server does, with `error` and `tooFast: true`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { notSentNotice, refusedText, restoredText, NOT_SENT_TEXT } from '../../src/lib/notSent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = 5196;
const SERVER = 'http://stubbed.invalid';
const ME = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const PEER = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const GROUP = 'cccccccccccccccccccccccc';

const me = { _id: ME, displayName: 'Rohan Kapoor', email: 'r@x.invalid', role: 'student', photoURL: '' };
const peer = { _id: PEER, displayName: 'Meera Iyer', role: 'mentor', photoURL: '', verification: { status: 'unverified' } };
const REFUSAL = { message: 'You are sending messages too quickly. Wait a few seconds.', tooFast: true };

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

/**
 * The app on `pathname`, with REST stubbed and the socket answered. The socket
 * confirms the first `allow` messages and refuses the rest with `refusal`.
 */
async function open(pathname, { allow = 1, refusal = REFUSAL, timeout = 30000, hold = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  page.setDefaultNavigationTimeout(180000);
  const seen = { sent: [], pageErrors: [] };
  page.on('pageerror', (e) => seen.pageErrors.push(e.message));

  const cors = {
    'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*'
  };
  const json = (route, body, code = 200) =>
    route.fulfill({ status: code, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });

  await page.route(`${SERVER}/**`, async (route) => {
    const request = route.request();
    const p = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (p.startsWith('/socket.io')) return route.abort(); // the polling fallback; the WebSocket is answered below
    if (p === '/api/auth/login') return json(route, me);
    if (p === `/api/user/${PEER}`) return json(route, peer);
    if (p === '/api/groups') return json(route, [{ _id: GROUP, name: 'Study group', members: [me, peer], createdBy: PEER }]);
    if (p === '/api/assignments/counts') return json(route, {});
    if (request.method() !== 'GET') return json(route, { ok: true });
    return json(route, []);
  });

  const held = [];
  let answer = null;
  await page.routeWebSocket(/stubbed\.invalid\/socket\.io/, (ws) => {
    const event = (name, payload) => ws.send(`42${JSON.stringify([name, payload])}`);
    answer = event;
    ws.send('0{"sid":"engine-1","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}');
    ws.onMessage((raw) => {
      const text = String(raw);
      if (text.startsWith('40')) return ws.send('40{"sid":"socket-1"}');
      if (text === '2') return ws.send('3');
      if (!text.startsWith('42')) return undefined;
      const [name, payload] = JSON.parse(text.slice(2));
      if (name !== 'send-message' && name !== 'send-group-message') return undefined;
      seen.sent.push(payload.text);
      if (hold) { held.push(payload.text); return undefined; }
      if (seen.sent.length > allow) return event('error', refusal.tooFast ? { ...refusal, text: payload.text } : refusal);
      const message = { _id: `m${seen.sent.length}`, text: payload.text, timestamp: new Date().toISOString(), sender: me };
      return name === 'send-message'
        ? event('message-sent', { ...message, receiver: peer, read: false })
        : event('new-group-message', { ...message, group: GROUP });
    });
  });

  await page.goto(`http://localhost:${PORT}${pathname}`);
  await page.getByPlaceholder('Write a message…').waitFor();
  return { page, seen, held, answer: (name, payload) => answer(name, payload), close: () => context.close() };
}

const send = async (page, text) => {
  const box = page.getByPlaceholder('Write a message…');
  await box.fill(text);
  await box.press('Enter');
};

test.before(async () => {
  vite = spawn(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, VITE_DEV_USER_ID: ME, VITE_SERVER_URL: SERVER }
  });
  await waitForVite();
  browser = await chromium.launch();
  await (await open(`/chat/${PEER}`, { timeout: 180000 })).close(); // Vite's first load, paid for here
});

test.after(async () => {
  await browser?.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(vite.pid), '/T', '/F'], { stdio: 'ignore' });
  else vite?.kill();
});

for (const [name, pathname] of [['1-to-1 chat', `/chat/${PEER}`], ['group chat', `/group/${GROUP}`]]) {
  test(`${name}: a message refused for being sent too quickly`, async (t) => {
    const { page, seen, close } = await open(pathname);
    const box = page.getByPlaceholder('Write a message…');
    const notice = page.getByRole('alert');

    await t.test('a message the server accepts appears, with no notice', async () => {
      await send(page, 'the first message');
      await page.getByText('the first message').waitFor();
      assert.equal(await notice.count(), 0);
      assert.equal(await box.inputValue(), '');
    });

    await t.test('a refused one is said to be not sent, and is not shown as sent', async () => {
      await send(page, 'one too many');
      await notice.waitFor();
      assert.equal((await notice.textContent()).trim(), NOT_SENT_TEXT);
      assert.equal(await page.getByText('one too many').count(), 0, 'the refused message is not in the conversation');
    });

    await t.test('its text is back in the box, ready to send again', async () => {
      assert.equal(await box.inputValue(), 'one too many');
    });

    await t.test('the server was asked exactly twice, and nothing broke', () => {
      assert.deepEqual(seen.sent, ['the first message', 'one too many']);
      assert.deepEqual(seen.pageErrors, []);
    });

    await close();
  });
}

test('another kind of socket error shows no "not sent" notice', async () => {
  const { page, close } = await open(`/chat/${PEER}`, { allow: 0, refusal: { message: 'You are not a member of that group' } });
  await send(page, 'hello');
  await page.waitForTimeout(800);
  assert.equal(await page.getByRole('alert').count(), 0);
  await close();
});

test('with two messages on their way, the one refused is the one put back', async () => {
  // The server holds its answers until both have been sent, then refuses the FIRST only.
  const { page, held, answer, close } = await open(`/chat/${PEER}`, { hold: true });
  await send(page, 'the earlier one');
  await send(page, 'the later one');

  for (let i = 0; i < 50 && held.length < 2; i++) await page.waitForTimeout(50);
  assert.deepEqual(held, ['the earlier one', 'the later one']);

  answer('error', { ...REFUSAL, text: 'the earlier one' });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByPlaceholder('Write a message…').inputValue(), 'the earlier one');
  await close();
});

test('what was typed since is not overwritten by a refusal', async () => {
  const { page, held, answer, close } = await open(`/chat/${PEER}`, { hold: true });
  await send(page, 'refused text');
  for (let i = 0; i < 50 && held.length < 1; i++) await page.waitForTimeout(50);
  await page.getByPlaceholder('Write a message…').fill('typing the next one');
  answer('error', { ...REFUSAL, text: 'refused text' });
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByPlaceholder('Write a message…').inputValue(), 'typing the next one');
  await close();
});

test('the helpers', () => {
  assert.equal(refusedText({ tooFast: true, text: 'x' }), 'x');
  for (const none of [null, {}, { text: 7 }, { text: { a: 1 } }]) assert.equal(refusedText(none), '');
  assert.equal(notSentNotice(REFUSAL), NOT_SENT_TEXT);
  for (const other of [null, undefined, {}, { message: 'x' }, { tooFast: 'true' }, { tooFast: 1 }]) {
    assert.equal(notSentNotice(other), null);
  }
  assert.equal(restoredText('', 'the refused text'), 'the refused text');
  assert.equal(restoredText('typed since', 'the refused text'), 'typed since', 'what was typed since is not overwritten');
  assert.equal(restoredText('', ''), '');
});
