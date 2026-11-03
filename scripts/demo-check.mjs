/**
 * Ask the running demo real questions through the panel, in a real browser.
 *
 *   npm run demo                    # in another terminal
 *   node scripts/demo-check.mjs
 *
 * Five questions as the student and five as the mentor, typed into the panel and timed
 * from the click to the result on screen. Spends up to ten Gemini calls on invented data.
 * Writes `ai/eval/s3-demo-log.txt` and the README's screenshots in `docs/images/`.
 *
 * It paces itself at one question every 13 seconds, because the route allows a person
 * five a minute. That limit is the app working, and this should not trip it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://127.0.0.1:3101';
const STUDENT = { id: '00000000000000000000d002', name: 'Rohan Kapoor (student)', url: 'http://localhost:5173' };
const MENTOR = { id: '00000000000000000000d001', name: 'Meera Iyer (mentor)', url: 'http://localhost:3000' };
const IMAGES = path.join(ROOT, 'docs/images');

const STUDENT_QUESTIONS = [
  'Which algorithm did I choose for my rate limiter, and why?',
  'What does Meera want me to change in my rate limiter design?',
  'What caused the lunch-rush outage?',
  'How long does the server remember an idempotency key?',
  "What is the canteen's refund policy?"
];
const MENTOR_QUESTIONS = [
  'How did Rohan test his rate limiter, and what were the results?',
  "What is still open in Rohan's rate limiter design?",
  'What action items came out of the postmortem?',
  "Which milestones on Rohan's goal are still to do?",
  'What did Ananya find in the hostel survey?'
];

const lines = [];
const log = (line = '') => {
  lines.push(line);
  console.log(line);
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function mentorships(person) {
  const res = await fetch(`${API}/api/mentorships`, { headers: { 'X-Dev-User-Id': person.id } });
  return res.json();
}

const panelOf = (page) => page.locator('section', { has: page.getByRole('heading', { name: 'Ask about this mentorship' }) });

async function askAll(browser, person, mentorshipId, questions, shots = {}) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  await page.goto(`${person.url}/mentorships/${mentorshipId}`);
  const panel = panelOf(page);
  await panel.getByLabel('Your question').waitFor();

  log(`\n== ${person.name}, mentorship ${mentorshipId}`);
  for (const [i, question] of questions.entries()) {
    const turns = panel.locator('ol > li');
    const before = await turns.count();
    await panel.getByLabel('Your question').fill(question);
    const started = Date.now();
    await panel.getByRole('button', { name: 'Ask', exact: true }).click();
    const turn = turns.nth(before);
    await turn.waitFor();
    await turn.getByText("Searching this mentorship's material…").waitFor({ state: 'detached', timeout: 20000 });
    const ms = Date.now() - started;

    const words = (await turn.innerText()).replace(/\s+/g, ' ').trim();
    const chips = turn.getByRole('button', { name: /^Source \d/ });
    const count = await chips.count();
    const state = count ? 'answered' : words.includes("I couldn't find") ? 'abstained' : 'other';
    log(`\nQ${i + 1}: ${question}`);
    log(`  ${state}, ${ms} ms`);
    log(`  ${words.replace(`You: ${question}`, '').trim()}`);

    for (let c = 0; c < count; c++) {
      const label = await chips.nth(c).getAttribute('aria-label');
      if (c === 0) {
        await chips.nth(0).click();
        const card = turn.getByRole('complementary');
        const action = await card.getByRole('button').first().innerText();
        const passage = await card.locator('blockquote').innerText().catch(() => '');
        log(`  [chip] ${label} -> "${action}"; passage: ${passage.slice(0, 110)}…`);
        if (shots.answer === i) await page.screenshot({ path: path.join(IMAGES, 'copilot-answer.png') });
        if (action.startsWith('Open at page')) {
          await card.getByRole('button').first().click();
          const frame = page.locator('dialog iframe');
          await frame.waitFor();
          log(`  [preview] iframe at ${(await frame.getAttribute('src')).replace(/^blob:.*#/, 'blob…#')}`);
          await page.locator('dialog').getByRole('button', { name: 'Close' }).click();
        }
      } else {
        log(`  [chip] ${label}`);
      }
    }
    if (state === 'abstained' && shots.abstained === i) await page.screenshot({ path: path.join(IMAGES, 'copilot-abstention.png') });
    if (i < questions.length - 1) await pause(13000);
  }
  if (consoleErrors.length) log(`  page errors: ${consoleErrors.join('; ')}`);
  await page.close();
}

const browser = await chromium.launch();
mkdirSync(IMAGES, { recursive: true });
const startedAt = new Date().toISOString();
log(`S3 step 5: real questions through the panel, in a browser, on the demo stack. Started ${startedAt}. Invented data.`);

const rohans = await mentorships(STUDENT);
const backend = rohans.find((m) => m.topic.startsWith('Backend') && m.status === 'active');
const ended = rohans.find((m) => m.status === 'ended');

await askAll(browser, STUDENT, backend._id, STUDENT_QUESTIONS, { abstained: 4 });
await pause(13000);
await askAll(browser, MENTOR, backend._id, MENTOR_QUESTIONS, { answer: 0 });

const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(`${STUDENT.url}/mentorships/${ended._id}`);
const panel = panelOf(page);
await panel.getByText("The assistant isn't available for ended mentorships.").waitFor();
log(`\n== the ended mentorship: refusal shown, question boxes: ${await panel.getByLabel('Your question').count()}`);
await page.screenshot({ path: path.join(IMAGES, 'copilot-ended.png') });
const direct = await fetch(`${API}/api/mentorships/${ended._id}/copilot/ask`, {
  method: 'POST',
  headers: { 'X-Dev-User-Id': STUDENT.id, 'Content-Type': 'application/json' },
  body: JSON.stringify({ question: 'Anything?' })
});
log(`  the route itself: HTTP ${direct.status} ${JSON.stringify(await direct.json())}`);

await browser.close();
writeFileSync(path.join(ROOT, 'ai/eval/s3-demo-log.txt'), `${lines.join('\n')}\n`);
