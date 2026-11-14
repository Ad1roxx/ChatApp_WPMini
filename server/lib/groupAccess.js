/**
 * Who may see a group, who may be put in one, and taking someone out of its
 * live room.
 *
 * Groups are private (the human's decision, BUILD_NOTES Entry 159). Before it,
 * every signed-in user could list every group with its members, anyone could
 * join any group and read its whole history, and a mentor could add anyone at
 * all without their knowing (the audit's report on consent, Entry 156).
 *
 * The rules, each written once here and used by the REST routes and the socket
 * handlers alike:
 * - **Seeing** a group, its member list and its history: its members, and admins.
 * - **Adding**: an admin can add anyone. A mentor can add only their own active
 *   mentees: the student in a mentorship with them whose status is `active`,
 *   not a request still waiting and not one that has ended.
 * - **Managing** (adding to, or removing from, an existing group): admins, and
 *   the group's creator while they are still a member of it.
 * - Nobody joins a group themselves.
 */

const mongoose = require('mongoose');
const Group = require('../models/Group');
const Mentorship = require('../models/Mentorship');

const isMember = (group, userId) => group.members.some((m) => String(m) === String(userId));

/**
 * `{ group, member, admin }` for a group this user may SEE, or `{ error, status }`.
 * An admin who is not a member may see it and is not a member of it.
 */
async function seeGroup(groupId, user, select = 'members createdBy name') {
  if (typeof groupId !== 'string' || !mongoose.isValidObjectId(groupId)) {
    return { error: 'Group not found', status: 404 };
  }
  const group = await Group.findById(groupId).select(select);
  if (!group) return { error: 'Group not found', status: 404 };

  const member = isMember(group, user._id);
  const admin = user.role === 'admin';
  if (!member && !admin) return { error: 'You are not a member of that group', status: 403 };
  return { group, member, admin };
}

/** Whether this user may add to and remove from this group. */
function canManage(group, user) {
  if (user.role === 'admin') return true;
  return String(group.createdBy) === String(user._id) && isMember(group, user._id);
}

/**
 * Why `adder` may not add these people, or null. `userIds` are valid ids of
 * users that exist; the adder themself is always allowed.
 */
async function addProblem(adder, userIds) {
  if (adder.role === 'admin') return null;
  const others = userIds.map(String).filter((id) => id !== String(adder._id));
  if (others.length === 0) return null;
  if (adder.role !== 'mentor') return 'Only mentors can add people to a group';

  const mentees = new Set(
    (await Mentorship.distinct('student', { mentor: adder._id, status: 'active' })).map(String)
  );
  return others.every((id) => mentees.has(id)) ? null : 'You can only add your own mentees to a group';
}

/**
 * Take every socket this user has open out of the group's room, now. Without
 * it a removal would only reach them when they next reconnected, and until then
 * they would go on receiving what the group says, which is not what "removed"
 * means. The same idea as cutting a suspended account's sockets.
 */
function dropFromRoom(io, onlineUsers, userId, groupId) {
  const sockets = onlineUsers.get(String(userId));
  if (!sockets) return;
  for (const socketId of sockets) {
    io.sockets.sockets.get(socketId)?.leave(`group:${groupId}`);
  }
}

module.exports = { isMember, seeGroup, canManage, addProblem, dropFromRoom };
