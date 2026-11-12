/**
 * Turning what the mentor sends on "Confirm" into the next confirmed version
 * of a checklist (S8 Step 2, D6). Pure, so the rules are tested on their own.
 *
 * The client sends, per criterion, only `{ text, from, marks, weight }`:
 * - `text`: the mentor's wording (required);
 * - `from`: the ids it came from: extracted ids (`c1`...) and/or ids in the
 *   latest confirmed version (`k1`...). Empty for a criterion the mentor added.
 * Everything else is decided here:
 * - `sourceText` is COPIED from those sources, never taken from the client:
 *   one source's quote, or several joined for a merge; null if none has one.
 * - `origin`: `added` (no source), `merged` (two or more), `edited` (one,
 *   text changed), or, unchanged from one source, that source's origin
 *   (`extracted` for an extracted criterion).
 * - ids are `k1`, `k2`, ... in the order sent.
 * A deleted criterion is simply one not sent.
 */

const MAX_CRITERIA = 40;
const MAX_TEXT = 1000;
const JOIN = '\n…\n';

function fail(error) {
  return { error };
}

function number(value, max, name) {
  if (value === undefined || value === null || value === '') return { value: null };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) {
    return { error: `${name} must be a number from 0 to ${max}` };
  }
  return { value };
}

/**
 * @param set the CriteriaSet (plain object or document): `extracted.criteria`, `versions`
 * @param sent the request body's `criteria`
 * @returns `{ criteria }` for the next version, or `{ error }`
 */
function nextVersion(set, sent) {
  if (!Array.isArray(sent) || sent.length === 0) return fail('Confirm at least one criterion');
  if (sent.length > MAX_CRITERIA) return fail(`At most ${MAX_CRITERIA} criteria`);

  const sources = new Map();
  for (const c of (set.extracted && set.extracted.criteria) || []) {
    sources.set(c.id, { quote: c.sourceText, text: c.sourceText, origin: 'extracted' });
  }
  const versions = set.versions || [];
  const latest = versions.length ? versions[versions.length - 1] : null;
  for (const c of (latest && latest.criteria) || []) {
    sources.set(c.id, { quote: c.sourceText, text: c.text, origin: c.origin });
  }

  const criteria = [];
  for (const [i, item] of sent.entries()) {
    const where = `Criterion ${i + 1}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) return fail(`${where} is not a criterion`);
    const unknown = Object.keys(item).filter((k) => !['text', 'from', 'marks', 'weight'].includes(k));
    if (unknown.length) return fail(`${where}: unknown field ${unknown[0]}`);

    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) return fail(`${where} has no text`);
    if (text.length > MAX_TEXT) return fail(`${where} is longer than ${MAX_TEXT} characters`);

    const from = item.from === undefined ? [] : item.from;
    if (!Array.isArray(from) || from.some((id) => typeof id !== 'string')) {
      return fail(`${where}: from must be a list of criterion ids`);
    }
    if (new Set(from).size !== from.length) return fail(`${where} names one source twice`);
    const missing = from.find((id) => !sources.has(id));
    if (missing) return fail(`${where} comes from ${missing}, which is not in this checklist`);

    const marks = number(item.marks, 1000, `${where}: marks`);
    if (marks.error) return fail(marks.error);
    const weight = number(item.weight, 100, `${where}: weight`);
    if (weight.error) return fail(weight.error);

    const quotes = from.map((id) => sources.get(id).quote).filter(Boolean);
    let origin;
    if (from.length === 0) origin = 'added';
    else if (from.length > 1) origin = 'merged';
    // Unchanged keeps where it came from (a carried-over edit stays an edit).
    else origin = sources.get(from[0]).text === text ? sources.get(from[0]).origin : 'edited';

    criteria.push({
      id: `k${i + 1}`,
      text,
      sourceText: quotes.length ? quotes.join(JOIN) : null,
      marks: marks.value,
      weight: weight.value,
      origin,
      from: [...from]
    });
  }
  return { criteria };
}

module.exports = { nextVersion, MAX_CRITERIA, MAX_TEXT, JOIN };
