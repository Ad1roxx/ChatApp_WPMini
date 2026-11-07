/**
 * What the assistant panel decides, kept apart from how it draws it.
 *
 * ## Model text is never markup
 *
 * An answer is untrusted: it is built from text a student wrote, and a hand-in can
 * be written to shape it. So it is split here into plain strings and citation
 * references, and React renders the strings as text. Nothing in this path can
 * become an element except a citation chip our own code makes, and only for a
 * handle the response actually listed.
 *
 * ## Only our own sentences
 *
 * The panel takes two things from a response: an answer's text and its citation
 * fields, both rendered as plain text. Everything else it says is one of the sentences
 * below, chosen from the status code or from `status === 'abstained'`. A response's
 * own messages are neither shown nor compared against.
 */

export const MAX_QUESTION = 1000;
export const REQUEST_TIMEOUT_MS = 15000; // above Express's 10 s, so that answers first
// An agent turn: above Express's own 35 s wait for one (COPILOT_AGENT_TIMEOUT_MS), so that answers
// first. Measured turns took 2.5 s typically and 10.4 s at most (BUILD_NOTES Entry 101).
export const AGENT_REQUEST_TIMEOUT_MS = 40000;

export const MESSAGES = {
  abstained: "I couldn't find an answer to that in what I can search in this mentorship.",
  ended: "The assistant isn't available for ended mentorships.",
  notActive: 'The assistant is only available in active mentorships.',
  limited: 'The assistant has reached its limit for now. Try again later.',
  stopped: "I couldn't finish looking that up within my limits. Try a narrower question.",
  unavailable: "The assistant isn't available right now. The rest of this page still works.",
  failed: "The assistant couldn't answer that. Try again."
};

/** The message for a mentorship the assistant does not work in, or null. */
export function refusalFor(status) {
  if (status === 'active') return null;
  return status === 'ended' ? MESSAGES.ended : MESSAGES.notActive;
}

/**
 * One turn's outcome from a response's status and parsed body.
 *
 * Returns `{ state, ... }`. Only `answered` carries anything from the response,
 * and only after checking its shape; everything else is one of our sentences.
 */
export function outcomeOf(httpStatus, body) {
  if (httpStatus === 200) {
    if (body?.status === 'answered' && typeof body.answer === 'string' && body.answer.trim()) {
      return {
        state: 'answered',
        answer: body.answer,
        citations: Array.isArray(body.citations) ? body.citations : [],
        // Agent turns: what a file summary covered, in sentences our service's code
        // wrote, never the model. Plain text, like everything else here.
        notes: Array.isArray(body.notes) ? body.notes.filter((n) => typeof n === 'string') : []
      };
    }
    if (body?.status === 'abstained') return { state: 'abstained', message: MESSAGES.abstained };
    // Agent turns only: a cap stopped it, or a check refused it partway (the
    // mentorship ended, say). Our sentences, never the turn's own.
    if (body?.status === 'stopped') return { state: 'stopped', message: MESSAGES.stopped };
    if (body?.status === 'refused' && body.httpStatus === 409) return { state: 'refused', message: MESSAGES.ended };
    return { state: 'failed', message: MESSAGES.failed };
  }
  // Only reachable if the mentorship stopped being active while this page was open,
  // and an active one can only end. Any other status never gets as far as asking.
  if (httpStatus === 409) return { state: 'refused', message: MESSAGES.ended };
  if (httpStatus === 429) return { state: 'limited', message: MESSAGES.limited };
  if (httpStatus === 503) return { state: 'unavailable', message: MESSAGES.unavailable };
  return { state: 'failed', message: MESSAGES.failed };
}

/**
 * Split an answer into plain text and citation references:
 *
 *   'Five [1], then [7].' -> ['Five ', { handle: 1, citation }, ', then [7].']
 *
 * An agent's answer also cites records it looked up, as `[T1]`; S2's handles are
 * numbers and the agent's are strings, so both are matched by their text. A handle
 * the response does not list stays part of the text. It is a number in brackets,
 * not a link to anything.
 */
export function splitAnswer(answer, citations) {
  const byHandle = new Map((citations || []).map((c) => [String(c.handle), c]));
  const parts = [];
  let last = 0;

  for (const match of String(answer).matchAll(/\[(T?\d+)\]/g)) {
    const citation = byHandle.get(match[1]);
    if (!citation) continue;
    if (match.index > last) parts.push(answer.slice(last, match.index));
    parts.push({ handle: citation.handle, citation });
    last = match.index + match[0].length;
  }

  if (last < answer.length) parts.push(answer.slice(last));
  return parts;
}

const KIND = {
  assignment: 'assignment brief',
  submission: 'hand-in',
  goal: 'goal',
  resource: 'saved resource'
};

/** Where in the source: "page 2", "pages 2-3", or undefined. */
export function pagesOf(citation) {
  const { startPage, endPage } = citation;
  if (!startPage) return undefined;
  return endPage && endPage !== startPage ? `pages ${startPage}-${endPage}` : `page ${startPage}`;
}

/** The chip's words for a screen reader: "Source 1: queue-retries.pdf, page 2". */
export function chipLabel(citation) {
  const where = pagesOf(citation) || citation.heading;
  return `Source ${citation.handle}: ${citation.title}${where ? `, ${where}` : ''}`;
}

/** "assignment brief", "hand-in", and so on; a file is called by its own name. */
export function kindOf(citation) {
  return KIND[citation.sourceType] || 'record';
}

/** The record's element on this page; see the ids on its rows. */
export function anchorOf(citation) {
  return `source-${citation.sourceType}-${citation.sourceId}`;
}

// ---------------------------------------------------------------------------
// The agent's record citations: `{ handle: 'T1', kind, id, mentorshipId, title }`
// ---------------------------------------------------------------------------

/** Which row a record leads to. A file summary leads to its hand-in. */
const RECORD_ROW = {
  goal: 'goal',
  submission: 'submission',
  assignment: 'assignment',
  resource: 'resource',
  session: 'session',
  file: 'submission'
};

const RECORD_KIND = {
  goal: 'goal',
  submission: 'hand-in',
  assignment: 'assignment',
  resource: 'saved resource',
  session: 'session',
  file: 'hand-in',
  counts: 'summary'
};

/** True for a citation of a record the agent looked up, not a passage. */
export function isRecord(citation) {
  return typeof citation?.handle === 'string' && citation.handle.startsWith('T');
}

/** "goal", "session" and so on, for the card and the button. */
export function recordKindOf(citation) {
  return Object.hasOwn(RECORD_KIND, citation.kind) ? RECORD_KIND[citation.kind] : 'record';
}

/**
 * Where a record citation leads: `{ anchor }` on this page, `{ path }` to its own
 * mentorship's page when it is in another one (the self tools reach across
 * mentorships), or null when there is nothing to go to. Ids must look like ids:
 * they become part of a URL.
 */
export function recordTarget(citation, currentMentorshipId) {
  // Own keys only: a kind of "constructor" must not find Object's.
  const row = Object.hasOwn(RECORD_ROW, citation.kind) ? RECORD_ROW[citation.kind] : null;
  if (!row || !/^[0-9a-f]{24}$/.test(String(citation.id || ''))) return null;
  const anchor = `source-${row}-${citation.id}`;
  const mid = String(citation.mentorshipId || '');
  if (!mid || mid === String(currentMentorshipId)) return { anchor };
  if (!/^[0-9a-f]{24}$/.test(mid)) return null;
  return { path: `/mentorships/${mid}#${anchor}` };
}

/** The chip's words for a screen reader: "Record T1: Ready for interviews, goal". */
export function recordChipLabel(citation) {
  return `Record ${citation.handle}: ${citation.title || recordKindOf(citation)}, ${recordKindOf(citation)}`;
}

/** The passage for the card, about `limit` characters, cut at a word. */
export function shortenPassage(text, limit = 300) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
