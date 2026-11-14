/**
 * What one signed-in user may know about another.
 *
 * The user list, a single user's lookup and the `user-added` / `user-updated`
 * broadcasts all used to carry the whole document: the email, the Firebase uid,
 * a mentor's verification evidence and the admin's review note, and why and by
 * whom an account was suspended (the audit, F6). The broadcasts went to every
 * connected socket. Everything that leaves for somebody other than the user
 * themself or an admin now goes through `publicUser`.
 *
 * An allowlist, not a list of things to remove: a field added to the model later
 * stays private until somebody adds it here on purpose.
 *
 * ## Email
 *
 * Decided by the human (BUILD_NOTES Entry 156): a user's email is seen by that
 * user, by admins, and by a mentor for their own mentees, and by nobody else.
 * A mentee here is the student in an ACTIVE mentorship with that mentor: not a
 * request still waiting, and not a mentorship that has ended. `userFor` applies
 * the rule; `publicUser` never carries an email, so anything sent to everyone
 * (the broadcasts) cannot.
 */

const PUBLIC_FIELDS = [
  '_id',
  'displayName',
  'photoURL',
  'role',
  'bio',
  'expertise',
  'availability',
  'isOnline',
  'lastSeen',
  'createdAt'
];

/** For a query whose rows go through `userFor`: the public fields, the email and the badge's status. */
const VIEW_SELECT = [...PUBLIC_FIELDS, 'email', 'verification.status'].join(' ');

/** The public view of a user document or plain object; null stays null. Never an email. */
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

/** Whether `viewer` may see `user`'s email. `menteeIds` is a Set of the viewer's mentees' ids, as strings. */
function maySeeEmail(viewer, user, menteeIds) {
  if (!viewer || !user) return false;
  const id = String(user._id);
  if (String(viewer._id) === id) return true;
  if (viewer.role === 'admin') return true;
  return Boolean(menteeIds && menteeIds.has(id));
}

/** `user` as `viewer` may see them: the public view, with the email only where the rule allows. */
function userFor(viewer, user, menteeIds) {
  const view = publicUser(user);
  if (view && maySeeEmail(viewer, user, menteeIds) && user.email) view.email = user.email;
  return view;
}

module.exports = { PUBLIC_FIELDS, VIEW_SELECT, publicUser, maySeeEmail, userFor };
