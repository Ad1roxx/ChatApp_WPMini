/**
 * Role helpers.
 *
 * These exist because "is this person allowed to do mentor things?" stopped
 * being `role === 'mentor'` the moment admins arrived. That comparison was
 * written in four different pages, and four places is exactly where an
 * inconsistency hides.
 *
 * These are CONVENIENCE ONLY. The server re-checks every one of them against
 * the role stored in MongoDB — see `server/index.js`. Nothing here is a
 * security boundary; it decides what to render, not what is permitted.
 */

/** Mentors and admins can create groups and post announcements. */
export const canMentor = (role) => role === 'mentor' || role === 'admin';

/** Admins additionally see the dashboard and can change other people's roles. */
export const isAdmin = (role) => role === 'admin';

/**
 * Roles a user may choose for themselves.
 *
 * Admin is absent on purpose: it is granted by the server's ADMIN_EMAILS
 * allowlist, never picked. The server rejects it too, so this list is a
 * reflection of that rule rather than the rule itself.
 */
export const SELECTABLE_ROLES = ['student', 'mentor'];

/** Display label for a role. */
export function roleLabel(role) {
  if (role === 'admin') return 'Admin';
  if (role === 'mentor') return 'Mentor';
  if (role === 'student') return 'Student';
  return null;
}

/**
 * Has an administrator approved this mentor's credentials?
 *
 * Takes the whole user rather than a status string, because callers have the
 * user and the field is nested — and because a missing `verification` object
 * (every account created before the feature) must read as "no", not crash.
 */
export const isVerified = (user) => user?.verification?.status === 'approved';

/** Human wording for a verification state, or null when nothing to say. */
export function verificationLabel(status) {
  if (status === 'approved') return 'Verified';
  if (status === 'pending') return 'Awaiting review';
  if (status === 'rejected') return 'Not approved';
  return null;
}
