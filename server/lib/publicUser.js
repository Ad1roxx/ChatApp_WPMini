/**
 * What one signed-in user may know about another.
 *
 * The user list, a single user's lookup and the `user-added` / `user-updated`
 * broadcasts all used to carry the whole document: the Firebase uid, a mentor's
 * verification evidence and the admin's review note, and why and by whom an
 * account was suspended (the audit, F6). The broadcasts went to every connected
 * socket. Everything that leaves for somebody other than the user themself or an
 * admin now goes through `publicUser`.
 *
 * An allowlist, not a list of things to remove: a field added to the model later
 * stays private until somebody adds it here on purpose.
 *
 * `email` is in the list because the profile page shows it. Whether other users
 * should see it is the human's decision (docs/AUDIT.md, F6); taking it out is
 * this one line and the profile page.
 */

const PUBLIC_FIELDS = [
  '_id',
  'displayName',
  'photoURL',
  'email',
  'role',
  'bio',
  'expertise',
  'availability',
  'isOnline',
  'lastSeen',
  'createdAt'
];

/** For a query: `.select(PUBLIC_SELECT)`, then `publicUser` on each result. */
const PUBLIC_SELECT = [...PUBLIC_FIELDS, 'verification.status'].join(' ');

/** The public view of a user document or plain object; null stays null. */
function publicUser(user) {
  if (!user) return null;
  const source = typeof user.toObject === 'function' ? user.toObject() : user;
  const view = {};
  for (const field of PUBLIC_FIELDS) {
    if (source[field] !== undefined) view[field] = source[field];
  }
  // The badge needs the status and nothing else about a verification.
  view.verification = { status: source.verification?.status || 'unverified' };
  return view;
}

module.exports = { PUBLIC_FIELDS, PUBLIC_SELECT, publicUser };
