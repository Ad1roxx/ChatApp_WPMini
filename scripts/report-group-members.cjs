/**
 * List the existing groups whose members do not fit the private-group rule.
 *
 *     node scripts/report-group-members.cjs                 # dev: chatapp on 27017
 *     node scripts/report-group-members.cjs <mongodb-uri>   # anywhere else
 *     node scripts/report-group-members.cjs --names         # with group and display names
 *
 * READ-ONLY. It runs `find` and nothing else: no group, member or message is
 * changed or deleted, whatever it finds. By default it prints ids and counts
 * only, no names and never an email, so its output can be pasted into a note.
 *
 * ## Why it exists
 *
 * Groups became private in BUILD_NOTES Entry 159: a mentor can add only their own
 * active mentees, an admin anyone, and nobody joins a group themselves. Groups
 * made before that were filled under the old rules, where anyone could join any
 * group and a mentor could add anyone. The new rule is enforced when someone is
 * ADDED. It does not reach back: everyone already in a group stays in it, can
 * still read and post, and can now leave or be removed. This lists who that is,
 * so the person who made each group, or an admin, can decide.
 *
 * A member "fits" if they could be added today by the group's creator: the
 * creator themself; anyone, when the creator is an admin; the creator's active
 * mentee, when the creator is a mentor.
 */

const path = require('node:path');
const mongoose = require(path.join(__dirname, '..', 'server', 'node_modules', 'mongoose'));

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/chatapp';

/** Every group, with the members that would not be allowed in today and why. Reads only. */
async function report(db) {
  const groups = await db.collection('groups').find({}).sort({ createdAt: 1 }).toArray();
  const users = new Map(
    (await db.collection('users').find({}, { projection: { role: 1, displayName: 1, suspended: 1 } }).toArray())
      .map((u) => [String(u._id), u])
  );
  const active = await db.collection('mentorships')
    .find({ status: 'active' }, { projection: { mentor: 1, student: 1 } }).toArray();
  const menteesOf = new Map();
  for (const m of active) {
    const key = String(m.mentor);
    if (!menteesOf.has(key)) menteesOf.set(key, new Set());
    menteesOf.get(key).add(String(m.student));
  }

  return groups.map((g) => {
    const creatorId = String(g.createdBy);
    const creator = users.get(creatorId);
    const memberIds = (g.members || []).map(String);
    const mentees = menteesOf.get(creatorId) || new Set();
    const misfits = [];

    for (const id of memberIds) {
      if (id === creatorId) continue;
      const user = users.get(id);
      let why = null;
      if (!user) why = 'no such user any more';
      else if (!creator) why = 'the group\'s creator no longer exists';
      else if (creator.role === 'admin') why = null;
      else if (creator.role !== 'mentor') why = `the creator is now a ${creator.role || 'user with no role'}, who cannot add anyone`;
      else if (!mentees.has(id)) why = `not an active mentee of the creator (their role: ${user.role || 'none'})`;
      if (why) misfits.push({ id, name: user ? user.displayName : null, why });
    }

    return {
      id: String(g._id),
      name: g.name,
      creatorId,
      creatorRole: creator ? creator.role || 'none' : 'missing',
      creatorIsMember: memberIds.includes(creatorId),
      members: memberIds.length,
      misfits
    };
  });
}

/** The report as lines of text. Names only when asked for. */
function lines(rows, { names = false } = {}) {
  const out = [];
  const withMisfits = rows.filter((r) => r.misfits.length > 0);
  const noCreator = rows.filter((r) => !r.creatorIsMember);
  out.push(`${rows.length} group(s); ${withMisfits.length} with at least one member who could not be added today; ` +
    `${noCreator.length} whose creator is not a member (only an admin can manage those).`);
  for (const r of rows) {
    if (r.misfits.length === 0 && r.creatorIsMember) continue;
    out.push('');
    out.push(`group ${r.id}${names ? ` "${r.name}"` : ''}: ${r.members} member(s), creator ${r.creatorId} (${r.creatorRole})` +
      `${r.creatorIsMember ? '' : ', NOT a member'}`);
    for (const m of r.misfits) out.push(`  member ${m.id}${names && m.name ? ` "${m.name}"` : ''}: ${m.why}`);
  }
  if (withMisfits.length === 0 && noCreator.length === 0) out.push('Every member of every group fits the rule.');
  return out;
}

module.exports = { report, lines };

if (require.main === module) {
  const args = process.argv.slice(2);
  const names = args.includes('--names');
  const uri = args.find((a) => !a.startsWith('--')) || DEFAULT_URI;
  (async () => {
    await mongoose.connect(uri);
    try {
      console.log(`Database: ${mongoose.connection.name}. Read-only: nothing is changed.`);
      for (const line of lines(await report(mongoose.connection.db), { names })) console.log(line);
    } finally {
      await mongoose.disconnect();
    }
  })().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
