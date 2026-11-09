/**
 * Accept only http(s), and only a URL the platform can actually parse.
 *
 * The important refusal is `javascript:` — the client renders this straight
 * into an `href`, so a stored `javascript:` URL is stored XSS with a one-click
 * path to the other party. `data:` and `file:` are refused for the same
 * family of reasons. Allow-listing two schemes is the version that stays
 * correct as new schemes are invented; a blocklist is not.
 */
function parseSharedUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return { error: 'A link is required' };
  if (value.length > 2000) return { error: 'That link is too long' };

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'That does not look like a link' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'Only http and https links can be shared' };
  }

  return { url: parsed.toString() };
}

module.exports = { parseSharedUrl };
