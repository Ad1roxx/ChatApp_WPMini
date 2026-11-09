/**
 * How the browser carries out a proposal the person approved (AGENT_PLAN §2.4).
 *
 * ## A fixed table, and nothing from the agent
 *
 * `ACTIONS` maps a tool name to one function that builds one request to one of the
 * app's real routes. The method and the path are written here. Nothing in a
 * proposal can name a URL, a method or a header, and a tool with no entry cannot
 * run. Each function copies named fields, so an extra key in a proposal goes nowhere.
 *
 * The request is built from the signed `args`, the same object the dialog's fields
 * were built from, in the one token the server verifies at the claim.
 *
 * ## In order, and never twice
 *
 *   claim (the server verifies the token and uses it up) -> the real route -> close
 *
 * Nothing is retried after the claim. If the answer to the real request is lost we
 * cannot tell whether it ran, so we say so, and the person looks at the page.
 *
 * ## Only our own sentences
 *
 * Every sentence is below, chosen from a status. No text from any response is shown.
 */

const OBJECT_ID = /^[0-9a-f]{24}$/;
const WRITE_TIMEOUT_MS = 20000;

/** A path segment that can only be an id: nothing in a proposal can reshape the path. */
function id(value) {
  if (typeof value !== 'string' || !OBJECT_ID.test(value)) throw new Error('not an id');
  return value;
}

const ACTIONS = Object.freeze({
  create_assignment: (a) => ({
    method: 'POST',
    path: '/api/assignments',
    body: { title: a.title, instructions: a.instructions, dueAt: a.dueAt, mentorshipIds: a.mentorshipIds.map(id) }
  }),
  extend_assignment_deadline: (a) => ({
    method: 'PATCH',
    path: `/api/assignments/${id(a.assignmentId)}`,
    body: { dueAt: a.dueAt }
  }),
  set_goal: (a) => ({
    method: 'POST',
    path: `/api/mentorships/${id(a.mentorshipId)}/goals`,
    body: { title: a.title, description: a.description, milestones: a.milestones }
  }),
  toggle_milestone: (a) => ({
    method: 'PATCH',
    path: `/api/goals/${id(a.goalId)}/milestones/${id(a.milestoneId)}`,
    body: { done: a.done }
  }),
  propose_session: (a) => ({
    method: 'POST',
    path: `/api/mentorships/${id(a.mentorshipId)}/sessions`,
    body: { title: a.title, agenda: a.agenda, scheduledFor: a.scheduledFor, durationMinutes: a.durationMinutes }
  }),
  confirm_session: (a) => ({
    method: 'PATCH',
    path: `/api/sessions/${id(a.sessionId)}`,
    body: { action: 'confirm' }
  }),
  add_resource: (a) => ({
    method: 'POST',
    path: `/api/mentorships/${id(a.mentorshipId)}/resources`,
    body: { title: a.title, url: a.url, note: a.note }
  })
});

/** The one request this tool makes with these arguments, or null if it can make none. */
export function requestFor(tool, args) {
  if (typeof tool !== 'string' || !Object.hasOwn(ACTIONS, tool)) return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  try {
    return ACTIONS[tool](args);
  } catch {
    return null;
  }
}

/**
 * What a proposal token says, to draw the dialog and build the request, or null.
 * The browser cannot check the signature; the claim route verifies this same token
 * before anything runs.
 */
export function readProposal(token) {
  try {
    const part = String(token).split('.')[1];
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
    const p = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof p.jti !== 'string' || typeof p.tool !== 'string' || typeof p.heading !== 'string' ||
      typeof p.asked !== 'string' || typeof p.exp !== 'number' || !p.args || !Array.isArray(p.fields) ||
      !p.fields.every((f) => typeof f?.label === 'string' && typeof f?.value === 'string')
    ) {
      return null;
    }
    return { id: p.jti, tool: p.tool, args: p.args, heading: p.heading, asked: p.asked, fields: p.fields, expiresAt: p.exp * 1000 };
  } catch {
    return null;
  }
}

export const OUTCOMES = {
  done: {
    create_assignment: 'Done. The work has been set.',
    extend_assignment_deadline: 'Done. The deadline has been moved.',
    set_goal: 'Done. The goal has been set.',
    toggle_milestone: 'Done. The milestone has been updated.',
    propose_session: "Done. The session has been proposed, and they'll need to confirm it.",
    confirm_session: 'Done. The session is confirmed.',
    add_resource: 'Done. The link has been pinned.'
  },
  refused: "That wasn't done. The app refused it, and nothing changed.",
  unknown: "I can't tell whether that went through. Check the page before trying again.",
  expired: 'That proposal has expired, and nothing was done. Ask again if you still want it.',
  used: 'That proposal has already been used, so nothing more was done.',
  changed: 'That has changed since it was proposed, so nothing was done. Ask again if you still want it.',
  ended: "The assistant isn't available for ended mentorships, so nothing was done.",
  notAllowed: "You can't do that here, and nothing was done.",
  unavailable: "The assistant isn't available right now, and nothing was done.",
  failed: "That couldn't be started, and nothing was done. Try asking again.",
  dismissed: "Dismissed. Nothing was done."
};

/** The state a refused claim leaves us in. Nothing has run. */
function claimRefusal(status, reason) {
  if (status === 410) return 'expired';
  if (status === 409) {
    if (reason === 'changed') return 'changed';
    if (reason === 'ended') return 'ended';
    return 'used';
  }
  if (status === 403) return 'notAllowed';
  if (status === 503) return 'unavailable';
  return 'failed';
}

const post = (authFetch, path, body) => authFetch(path, { method: 'POST', body: JSON.stringify(body) });

/** Tell the server this one is finished. It decides nothing, and its failure changes nothing. */
async function close(authFetch, token, decision) {
  try {
    await post(authFetch, '/api/copilot/proposals/close', { proposal: token, decision });
  } catch (err) {
    console.error('Closing a proposal failed:', err.name);
  }
}

/**
 * Carry out one approved proposal, once. Returns `{ state, message }`, and
 * `state: 'done'` only when the real route itself said so.
 */
export async function approveProposal(authFetch, token, { timeoutMs = WRITE_TIMEOUT_MS } = {}) {
  const proposal = readProposal(token);
  const request = proposal && requestFor(proposal.tool, proposal.args);
  if (!request) return { state: 'failed', message: OUTCOMES.failed };
  if (Date.now() >= proposal.expiresAt) return { state: 'expired', message: OUTCOMES.expired };

  let claim;
  try {
    claim = await post(authFetch, '/api/copilot/proposals/claim', { proposal: token });
  } catch (err) {
    console.error('Claiming a proposal failed:', err.name);
    return { state: 'failed', message: OUTCOMES.failed };
  }
  if (!claim.ok) {
    const body = await claim.json().catch(() => null);
    const state = claimRefusal(claim.status, body?.reason);
    return { state, message: OUTCOMES[state] };
  }

  // Claimed: from here it is never retried.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let state;
  try {
    const res = await authFetch(request.path, {
      method: request.method,
      body: JSON.stringify(request.body),
      signal: controller.signal
    });
    state = res.ok ? 'done' : 'refused';
  } catch (err) {
    console.error('Running a proposal failed:', err.name);
    state = 'unknown';
  } finally {
    clearTimeout(timer);
  }

  await close(authFetch, token, 'approved');
  return { state, message: state === 'done' ? OUTCOMES.done[proposal.tool] : OUTCOMES[state] };
}

/** The person said no. Nothing runs. */
export async function dismissProposal(authFetch, token) {
  await close(authFetch, token, 'dismissed');
  return { state: 'dismissed', message: OUTCOMES.dismissed };
}
