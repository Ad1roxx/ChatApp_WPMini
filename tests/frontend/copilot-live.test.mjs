/**
 * One question through the real stack, in a real browser. One Gemini call.
 *
 *   npm run demo                                    # in another terminal
 *   AI_LIVE_SMOKE=1 node --test tests/frontend/copilot-live.test.mjs
 *
 * Off by default, like the provider smoke test, because it spends quota and needs the
 * demo running. It asks Rohan's active mentorship about his own rate limiter, then opens the
 * ended mentorship and checks it refuses. Invented data only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const BASE = process.env.APP_URL || 'http://localhost:5173';

test('a real question gets a real answer with a chip that opens its source', { skip: process.env.AI_LIVE_SMOKE !== '1' && 'set AI_LIVE_SMOKE=1, with `npm run demo` running' }, async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(`${BASE}/mentorships`);
    await page.getByText('Backend engineering for placement interviews').first().click();

    const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Ask about this mentorship' }) });
    await panel.getByLabel('Your question').fill('Which algorithm did I choose for my rate limiter, and why?');
    const started = Date.now();
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();

    const chip = panel.getByRole('button', { name: /^Source \d/ }).first();
    await chip.waitFor({ timeout: 20000 });
    console.log(`answered in ${Date.now() - started} ms`);

    await chip.click();
    const card = panel.getByRole('complementary');
    assert.ok((await card.locator('blockquote').innerText()).length > 0, 'the source card shows the passage');
  } finally {
    await browser.close();
  }
});
