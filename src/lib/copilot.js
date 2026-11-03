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
 * What the panel says about a failure is chosen from the status code, from the
 * table below. A response's body is not shown, whatever it holds.
 */

export const MAX_QUESTION = 1000;
export const REQUEST_TIMEOUT_MS = 15000; // above Express's 10 s, so that answers first

export const MESSAGES = {
  abstained: "I couldn't find an answer to that in what I can search in this mentorship.",
  ended: "The assistant isn't available for ended mentorships.",
  notActive: 'The assistant is only available in active mentorships.',
  limited: 'The assistant has reached its limit for now. Try again in a minute.',
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
        citations: Array.isArray(body.citations) ? body.citations : []
      };
    }
    if (body?.status === 'abstained') return { state: 'abstained', message: MESSAGES.abstained };
    return { state: 'failed', message: MESSAGES.failed };
  }
  if (httpStatus === 409) {
    // The same two sentences the page shows, picked by comparing rather than by
    // showing whatever came back.
    return { state: 'refused', message: body?.error === MESSAGES.notActive ? MESSAGES.notActive : MESSAGES.ended };
  }
  if (httpStatus === 429) return { state: 'limited', message: MESSAGES.limited };
  if (httpStatus === 503) return { state: 'unavailable', message: MESSAGES.unavailable };
  return { state: 'failed', message: MESSAGES.failed };
}

/**
 * Split an answer into plain text and citation references:
 *
 *   'Five [1], then [7].' -> ['Five ', { handle: 1, citation }, ', then [7].']
 *
 * A handle the response does not list stays part of the text. It is a number in
 * brackets, not a link to anything.
 */
export function splitAnswer(answer, citations) {
  const byHandle = new Map((citations || []).map((c) => [c.handle, c]));
  const parts = [];
  let last = 0;

  for (const match of String(answer).matchAll(/\[(\d+)\]/g)) {
    const citation = byHandle.get(Number(match[1]));
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

/** The passage for the card, about `limit` characters, cut at a word. */
export function shortenPassage(text, limit = 300) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
