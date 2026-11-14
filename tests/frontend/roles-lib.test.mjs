// Which stored addresses may be shown as a link (src/lib/roles.js, isWebLink).
// The admin opens a mentor's profile link from the review queue; a `javascript:`
// address there would run in the admin's page (the audit, F4).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isWebLink } from '../../src/lib/roles.js';

test('http and https addresses are links', () => {
  for (const url of ['https://linkedin.com/in/someone', 'http://example.com', 'HTTPS://EXAMPLE.COM/x', '  https://example.com  ']) {
    assert.equal(isWebLink(url), true, url);
  }
});

test('nothing else is', () => {
  const not = [
    'javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)',
    'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '//evil.example', 'linkedin.com/in/someone',
    'xhttps://example.com', '', null, undefined, 7, { href: 'https://example.com' }, ['https://example.com']
  ];
  for (const url of not) assert.equal(isWebLink(url), false, JSON.stringify(url));
});
