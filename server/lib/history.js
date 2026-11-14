/**
 * One page of a conversation's history: the NEWEST messages, oldest first.
 *
 * Both history routes used to sort oldest-first and then take 50, and the pages
 * asked for nothing more: once a conversation passed 50 messages, a reload
 * showed the first 50 ever sent and none after (the audit, F2). A page is now
 * the latest `limit` messages before `before` (and, at that same millisecond,
 * before `beforeId`), returned oldest first so the page still renders top to
 * bottom.
 */

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const OBJECT_ID = /^[0-9a-f]{24}$/;

/** `{ limit, before }` from a query string, or `{ error }`. `before` is null for the latest page. */
function parsePage(query = {}) {
  let limit = DEFAULT_PAGE;
  if (query.limit !== undefined) {
    limit = Number(query.limit);
    if (typeof query.limit !== 'string' || !Number.isInteger(limit) || limit < 1) {
      return { error: 'limit must be a whole number, 1 or more' };
    }
    limit = Math.min(limit, MAX_PAGE);
  }

  let before = null;
  if (query.before !== undefined) {
    before = typeof query.before === 'string' ? new Date(query.before) : new Date(NaN);
    if (Number.isNaN(before.getTime())) {
      return { error: 'before must be a date' };
    }
  }

  // Two messages can share a millisecond. `beforeId` is the id of the earliest
  // message on screen, so the page before it can include the others sent at that
  // same time instead of skipping them.
  let beforeId = null;
  if (query.beforeId !== undefined) {
    if (before === null || typeof query.beforeId !== 'string' || !OBJECT_ID.test(query.beforeId)) {
      return { error: 'beforeId must be a message id, sent with before' };
    }
    beforeId = query.beforeId;
  }

  return { limit, before, beforeId };
}

/**
 * Run `find(filter)` on `Model` for one page. `populate` is a list of
 * `[path, select]` pairs.
 */
async function historyPage(Model, filter, { limit, before, beforeId = null }, populate = []) {
  let query = filter;
  if (before && beforeId) {
    const earlier = {
      $or: [
        { timestamp: { $lt: before } },
        { timestamp: before, _id: { $lt: new Model.base.Types.ObjectId(beforeId) } }
      ]
    };
    query = { $and: [filter, earlier] };
  } else if (before) {
    query = { $and: [filter, { timestamp: { $lt: before } }] };
  }
  let find = Model.find(query).sort({ timestamp: -1, _id: -1 }).limit(limit);
  for (const [path, select] of populate) find = find.populate(path, select);
  return (await find).reverse();
}

module.exports = { DEFAULT_PAGE, MAX_PAGE, parsePage, historyPage };
