// The page's side of the private-group rules (src/lib/groups.js): who is offered
// when making a group, and who is a member. The server
// decides (server/lib/groupAccess.js); this keeps the page from offering what it
// would refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { addablePeople, isGroupMember } from '../../src/lib/groups.js';

const mentor = { _id: 'm1', role: 'mentor' };
const admin = { _id: 'a1', role: 'admin' };
const users = [{ _id: 's1' }, { _id: 's2' }, { _id: 's3' }, { _id: 'm2' }];
const mentorships = [
  { status: 'active', mentor: { _id: 'm1' }, student: { _id: 's1' } },   // my mentee
  { status: 'pending', mentor: { _id: 'm1' }, student: { _id: 's2' } },  // asked, not yet
  { status: 'ended', mentor: 'm1', student: 's3' },                      // over
  { status: 'active', mentor: { _id: 'm2' }, student: { _id: 's2' } },   // somebody else's
  { status: 'active', mentor: { _id: 'm2' }, student: { _id: 'm1' } }    // I am the student here
];
const ids = (list) => list.map((u) => u._id);

test('a mentor is offered only their own active mentees', () => {
  assert.deepEqual(ids(addablePeople(mentor, users, mentorships)), ['s1']);
});

test('ids that came populated or bare are treated alike', () => {
  const bare = [{ status: 'active', mentor: 'm1', student: 's3' }];
  assert.deepEqual(ids(addablePeople(mentor, users, bare)), ['s3']);
});

test('with no mentorships, a mentor is offered nobody', () => {
  assert.deepEqual(addablePeople(mentor, users, []), []);
  assert.deepEqual(addablePeople(mentor, users, undefined), []);
});

test('an admin is offered everyone', () => {
  assert.deepEqual(ids(addablePeople(admin, users, [])), ids(users));
});

test('nobody signed in is offered nobody', () => {
  assert.deepEqual(addablePeople(null, users, mentorships), []);
});

test('membership', () => {
  const group = { members: [{ _id: 'm1' }, 's1'] };
  assert.equal(isGroupMember(group, 'm1'), true);
  assert.equal(isGroupMember(group, 's1'), true);
  assert.equal(isGroupMember(group, 's2'), false);
  assert.equal(isGroupMember(group, undefined), false);
  assert.equal(isGroupMember(null, 'm1'), false);
});
