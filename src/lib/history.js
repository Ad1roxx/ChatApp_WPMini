/**
 * Paging through a conversation's history.
 *
 * The server sends the latest PAGE messages, oldest first, and the PAGE before a
 * given time on request. A full page means there may be earlier messages; a short
 * one means that was the start of the conversation.
 */

/** The server's default page (server/lib/history.js, DEFAULT_PAGE). */
export const PAGE = 50;

/** Whether a page that came back might have earlier messages behind it. */
export const mayHaveEarlier = (page) => Array.isArray(page) && page.length >= PAGE;

/** The address of the page before the earliest message on screen. */
export const earlierPath = (base, messages) =>
  `${base}?before=${encodeURIComponent(messages[0].timestamp)}` +
  `&beforeId=${encodeURIComponent(messages[0]._id)}`;

/**
 * Where the view is, measured before earlier messages go in front, and put back
 * after: the same messages stay under the reader's eye instead of the view
 * sliding by the height of what was added.
 */
export const placeOf = (el) => (el ? { height: el.scrollHeight, top: el.scrollTop } : null);
export function restorePlace(el, place) {
  if (el && place) el.scrollTop = el.scrollHeight - place.height + place.top;
}

/** Earlier messages in front of the ones on screen, without repeating any. */
export function withEarlier(earlier, current) {
  const have = new Set(current.map((m) => m._id));
  return [...earlier.filter((m) => !have.has(m._id)), ...current];
}
