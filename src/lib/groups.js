/**
 * Groups are private (server/lib/groupAccess.js). These are the page's side of
 * the same rules: who to offer when making a group, and whether someone is in one.
 * The server decides; this only keeps the page from offering what it would refuse.
 */

const idOf = (x) => String(x?._id || x || '');

/** Whether `userId` is one of the group's members. */
export const isGroupMember = (group, userId) =>
  Boolean(userId) && (group?.members || []).some((m) => idOf(m) === String(userId));

/**
 * The people `me` may put in a group: everyone, for an admin; for a mentor, only
 * their own active mentees (the student in an active mentorship they mentor).
 */
export function addablePeople(me, users, mentorships) {
  if (!me) return [];
  if (me.role === 'admin') return users;
  const mentees = new Set(
    (mentorships || [])
      .filter((m) => m.status === 'active' && idOf(m.mentor) === String(me._id))
      .map((m) => idOf(m.student))
  );
  return users.filter((u) => mentees.has(String(u._id)));
}
