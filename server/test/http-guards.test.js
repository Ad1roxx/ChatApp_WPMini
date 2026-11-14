/**
 * Which origins may call the server, and the headers every response carries
 * (lib/httpGuards.js). Run on the default configuration: no CORS_ORIGINS, so the
 * two local front-end addresses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { io } = require('socket.io-client');
const { USERS, BASE, start, stop, api } = require('./helpers/harness');
const {
  DEFAULT_ORIGINS, SECURITY_HEADERS, allowedOrigins, originAllowed
} = require('../lib/httpGuards');

test.before(() => start());
test.after(() => stop());

const LISTED = 'http://localhost:5173';
const UNLISTED = [
  'http://evil.example',
  'https://localhost:5173',          // the scheme is part of an origin
  'http://localhost:5174',           // so is the port
  'http://localhost:5173.evil.example',
  'http://evil.example/http://localhost:5173',
  'null'
];

const from = (origin, path = '/api/users', options = {}) =>
  api(path, { as: USERS.student, ...options, headers: { ...(options.headers || {}), Origin: origin } });

test('origins', async (t) => {
  await t.test('a listed origin is answered, and named in the CORS header', async () => {
    for (const origin of DEFAULT_ORIGINS) {
      const res = await from(origin);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
    }
  });

  for (const origin of UNLISTED) {
    await t.test(`${origin} is refused, and gets no CORS header`, async () => {
      const res = await from(origin);
      assert.equal(res.status, 403);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.deepEqual(await res.json(), { error: 'That origin is not allowed' });
    });
  }

  await t.test('an unlisted origin cannot write either: the request does not run', async () => {
    const res = await from('http://evil.example', `/api/users/${USERS.student._id}/profile`, {
      method: 'PUT', body: { bio: 'written from another site' }
    });
    assert.equal(res.status, 403);
    const me = await (await api(`/api/user/${USERS.student._id}`, { as: USERS.student })).json();
    assert.notEqual(me.bio, 'written from another site');
  });

  await t.test('a preflight from an unlisted origin is refused', async () => {
    const res = await fetch(`${BASE}/api/users`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' }
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  await t.test('a preflight from a listed origin is allowed', async () => {
    const res = await fetch(`${BASE}/api/users`, {
      method: 'OPTIONS',
      headers: { Origin: LISTED, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }
    });
    assert.ok(res.status < 300);
    assert.equal(res.headers.get('access-control-allow-origin'), LISTED);
  });

  await t.test('a request with no origin is not from another site, and passes', async () => {
    assert.equal((await api('/api/users', { as: USERS.student })).status, 200);
  });
});

test('the socket handshake follows the same list', async (t) => {
  const handshake = (origin) => new Promise((resolve) => {
    const socket = io(BASE, {
      transports: ['websocket'], auth: { devUserId: USERS.student._id }, reconnection: false,
      extraHeaders: origin ? { Origin: origin } : {}
    });
    socket.on('connect', () => { socket.close(); resolve('connected'); });
    socket.on('connect_error', () => resolve('refused'));
  });

  await t.test('a listed origin connects', async () => {
    assert.equal(await handshake(LISTED), 'connected');
  });
  await t.test('no origin connects', async () => {
    assert.equal(await handshake(null), 'connected');
  });
  await t.test('an unlisted origin is refused', async () => {
    assert.equal(await handshake('http://evil.example'), 'refused');
  });
});

test('every response carries the security headers', async (t) => {
  const check = (res, what) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      assert.equal(res.headers.get(name), value, `${name} on ${what}`);
    }
    assert.equal(res.headers.get('x-powered-by'), null, `x-powered-by on ${what}`);
  };

  await t.test('an answer', async () => check(await api('/api/users', { as: USERS.student }), 'a 200'));
  await t.test('a refusal for no sign-in', async () => check(await api('/api/users'), 'a 401'));
  await t.test('a refusal for the origin', async () => check(await from('http://evil.example'), 'a 403'));
  await t.test('a route that does not exist', async () => check(await api('/api/nothing-here', { as: USERS.student }), 'a 404'));
  await t.test('a body that is not JSON', async () => {
    const res = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-User-Id': USERS.student._id }, body: '{not json'
    });
    check(res, 'a 400');
  });
});

test('what no route answers, and a body that cannot be read, are answered in JSON', async (t) => {
  await t.test('a route that does not exist is a 404', async () => {
    const res = await api('/api/nothing-here', { as: USERS.student });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: 'Not found' });
  });

  await t.test('a body that is not JSON is a 400, and says nothing about the server', async () => {
    const res = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-User-Id': USERS.student._id }, body: '{not json'
    });
    assert.equal(res.status, 400);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), { error: 'That request body is not valid JSON' });
    assert.doesNotMatch(text, /SyntaxError|node_modules|at JSON/);
  });

  await t.test('a body that is too large is a 413', async () => {
    const res = await fetch(`${BASE}/api/reports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-User-Id': USERS.student._id },
      body: JSON.stringify({ details: 'x'.repeat(200 * 1024) })
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: 'That request is too large' });
  });

  await t.test('they say what they are meant to', () => {
    assert.equal(SECURITY_HEADERS['X-Content-Type-Options'], 'nosniff');
    assert.equal(SECURITY_HEADERS['X-Frame-Options'], 'DENY');
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /default-src 'none'/);
    assert.match(SECURITY_HEADERS['Content-Security-Policy'], /frame-ancestors 'none'/);
    assert.equal(SECURITY_HEADERS['Referrer-Policy'], 'no-referrer');
  });
});

test('the origin list comes from configuration', async (t) => {
  await t.test('unset or empty is the two local front-end addresses', () => {
    for (const none of [undefined, '', '  ', ',', null]) assert.deepEqual(allowedOrigins(none), [...DEFAULT_ORIGINS]);
    assert.deepEqual([...DEFAULT_ORIGINS], ['http://localhost:5173', 'http://localhost:3000']);
  });

  await t.test('a list replaces the defaults, trimmed, without trailing slashes', () => {
    assert.deepEqual(allowedOrigins(' https://app.example.com/ , https://other.example.com'),
      ['https://app.example.com', 'https://other.example.com']);
  });

  await t.test('a star is not a wildcard', () => {
    const allowed = allowedOrigins('*');
    assert.equal(originAllowed('http://evil.example', allowed), false);
  });

  await t.test('only an exact match is allowed', () => {
    const allowed = allowedOrigins('https://app.example.com');
    assert.equal(originAllowed('https://app.example.com', allowed), true);
    assert.equal(originAllowed(undefined, allowed), true);
    for (const bad of ['https://app.example.com.evil.example', 'http://app.example.com', 'https://APP.example.com',
      'http://localhost:5173', ['https://app.example.com'], {}]) {
      assert.equal(originAllowed(bad, allowed), false, JSON.stringify(bad));
    }
  });
});
