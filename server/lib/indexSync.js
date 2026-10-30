/**
 * indexSync — tell the retrieval service that a record changed
 *
 * Called after a write has succeeded, never before, and never awaited by the
 * route: the user's request finishes whether or not the retrieval service is
 * running, answering, or slow. With it switched off or down, the app behaves
 * exactly as it did before S1.5.
 *
 * ## Identifiers, never content
 *
 * The body is `{ sourceType, sourceId }` or `{ mentorshipId }`, and nothing
 * else. The service reads the record from the database itself and decides what
 * to index and who may see it; it refuses a body carrying anything more. So a
 * bug here — or anyone who reaches that endpoint — can say *which* record
 * changed, but never *what* it says or *who* may read it.
 *
 * ## Why losing one is acceptable
 *
 * There is no retry and no queue. If this call fails the index is late, not
 * wrong: every search checks its results against the records as they are now,
 * so a removal is honoured with or without this, and the service's start-up
 * catch-up re-adds whatever was missed. What a failure costs is freshness, so
 * it is logged — naming the record left stale — and nothing more.
 */

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || '';
const AI_SERVICE_SECRET = process.env.AI_SERVICE_SECRET || '';

/**
 * Short, because nothing waits on it but a log line. The service answers 202
 * as soon as the sync is queued, so a healthy one replies in milliseconds;
 * anything slower than this is a service in trouble, and the request it came
 * from has long since been answered.
 */
const TIMEOUT_MS = 1500;

function describe(body) {
  return body.mentorshipId
    ? `mentorship ${body.mentorshipId}`
    : `${body.sourceType} ${body.sourceId}`;
}

/**
 * Fire the notification. Resolves true if the service accepted it, false
 * otherwise — and never rejects, so a caller that forgets to handle it cannot
 * turn an indexing hiccup into an unhandled rejection.
 */
function notify(body) {
  if (!AI_SERVICE_URL || !AI_SERVICE_SECRET) return Promise.resolve(false);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  return fetch(`${AI_SERVICE_URL}/index/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AI-Secret': AI_SERVICE_SECRET
    },
    body: JSON.stringify(body),
    signal: controller.signal
  })
    .then((res) => {
      if (!res.ok) {
        console.warn(`Index not told about ${describe(body)}: the service answered ${res.status}`);
      }
      return res.ok;
    })
    .catch((err) => {
      const why = err.name === 'AbortError' ? `no answer in ${TIMEOUT_MS} ms` : err.message;
      console.warn(`Index not told about ${describe(body)}: ${why}`);
      return false;
    })
    .finally(() => clearTimeout(timer));
}

/** A record changed: assignment, submission, goal or resource. */
const syncSource = (sourceType, sourceId) =>
  notify({ sourceType, sourceId: String(sourceId) });

/** The mentorship itself changed: accepted, declined, ended. */
const syncMentorship = (mentorshipId) => notify({ mentorshipId: String(mentorshipId) });

module.exports = { syncSource, syncMentorship, TIMEOUT_MS };
