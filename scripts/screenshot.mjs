/**
 * Screenshot the running app.
 *
 * Google sign-in cannot be automated — the popup needs a real person — so
 * every signed-in screen is unreachable to a browser unless auth is bypassed.
 * That is what the two dev switches are for:
 *
 *   server:   ALLOW_DEV_AUTH=true      (accepts an X-Dev-User-Id header)
 *   frontend: VITE_DEV_USER_ID=<id>    (sends it, skips Google)
 *
 * Both are dev-only and off by default. The frontend half is compiled out of
 * production builds entirely.
 *
 * Usage — with the backend and `npm run dev` already running:
 *
 *   node scripts/screenshot.mjs                    # every route
 *   node scripts/screenshot.mjs /users /profile    # just these
 *
 * Images land in screenshots/ (gitignored), each captured at a desktop and a
 * mobile width so the responsive layout is checked too.
 */

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.APP_URL || 'http://localhost:5173';
const OUT = 'screenshots';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'mobile', width: 390, height: 844 }
];

const DEFAULT_ROUTES = [
  '/users',
  '/groups',
  '/announcements',
  '/profile'
];

const routes = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ROUTES;

/** Turn '/users/abc123' into 'users-abc123' for a filename. */
const slug = (route) => route.replace(/^\/|\/$/g, '').replace(/\//g, '-') || 'home';

const browser = await chromium.launch();
const problems = [];

await mkdir(OUT, { recursive: true });

for (const viewport of VIEWPORTS) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 2
  });

  const page = await context.newPage();

  // Surface anything the app logs as an error — a screenshot can look fine
  // while the console is full of failures.
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(`UNCAUGHT: ${err.message}`));

  for (const route of routes) {
    const url = BASE + route;
    consoleErrors.length = 0;

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
      // Let any post-load fetch settle and the fonts swap in
      await page.waitForTimeout(700);

      const file = path.join(OUT, `${slug(route)}-${viewport.name}.png`);
      await page.screenshot({ path: file, fullPage: true });

      const landed = new URL(page.url()).pathname;
      const redirected = landed !== route ? `  (redirected to ${landed})` : '';
      console.log(`  ${file}${redirected}`);

      if (landed !== route) {
        problems.push(`${route} [${viewport.name}] redirected to ${landed}`);
      }
      for (const err of consoleErrors) {
        problems.push(`${route} [${viewport.name}] console: ${err.slice(0, 140)}`);
      }
    } catch (err) {
      problems.push(`${route} [${viewport.name}] FAILED: ${err.message.split('\n')[0]}`);
      console.log(`  ${route} [${viewport.name}] FAILED`);
    }
  }

  await context.close();
}

await browser.close();

if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log('  - ' + p);
  await writeFile(path.join(OUT, 'problems.txt'), problems.join('\n'));
  process.exit(1);
}

console.log('\nNo redirects and no console errors.');
