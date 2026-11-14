/**
 * scripts/report-group-members.cjs: which existing members would not be allowed
 * into their group today, and proof that listing them changes nothing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { USERS, start, stop, db, mongoose } = require('./helpers/harness');
const { report, lines } = require('../../scripts/report-group-members.cjs');

const id = (hex) => new mongoose.Types.ObjectId(hex);
const GONE = '0000000000000000000000ff';
const G = {
  fits: '0000000000000000000000c1',        // mentor + their active mentee
  joined: '0000000000000000000000c2',      // mentor + their mentee + a student who joined under the old rule
  admins: '0000000000000000000000c3',      // made by an admin: anyone fits
  left: '0000000000000000000000c4',        // the creator is no longer in it
  demoted: '0000000000000000000000c5',     // made by someone who is a student now
  ghost: '0000000000000000000000c6'        // a member who no longer exists
};

test.before(async () => {
  await start();
  await db().collection('mentorships').insertMany([
    { _id: id('0000000000000000000000e1'), mentor: id(USERS.mentor._id), student: id(USERS.student._id), status: 'active', topic: 'T' },
    { _id: id('0000000000000000000000e2'), mentor: id(USERS.mentor._id), student: id(USERS.student2._id), status: 'ended', topic: 'T' }
  ]);
  const group = (hex, name, createdBy, members) =>
    ({ _id: id(hex), name, createdBy: id(createdBy), members: members.map(id), createdAt: new Date(Number.parseInt(hex.slice(-2), 16) * 1000) });
  await db().collection('groups').insertMany([
    group(G.fits, 'Fits', USERS.mentor._id, [USERS.mentor._id, USERS.student._id]),
    group(G.joined, 'Joined', USERS.mentor._id, [USERS.mentor._id, USERS.student._id, USERS.student2._id]),
    group(G.admins, 'Admins', USERS.admin._id, [USERS.admin._id, USERS.student2._id, USERS.mentor._id]),
    group(G.left, 'Left', USERS.mentor._id, [USERS.student._id]),
    group(G.demoted, 'Demoted', USERS.student._id, [USERS.student._id, USERS.student2._id]),
    group(G.ghost, 'Ghost', USERS.admin._id, [USERS.admin._id, GONE])
  ]);
});
test.after(() => stop());

const byId = async () => Object.fromEntries((await report(db())).map((r) => [r.id, r]));

test('which members do not fit', async (t) => {
  const rows = await byId();

  await t.test('a mentor\'s group of their own active mentees fits', () => {
    assert.deepEqual(rows[G.fits].misfits, []);
    assert.equal(rows[G.fits].creatorIsMember, true);
  });

  await t.test('a student who joined under the old rule, and is not the creator\'s active mentee, is listed', () => {
    assert.deepEqual(rows[G.joined].misfits.map((m) => m.id), [USERS.student2._id]);
    assert.match(rows[G.joined].misfits[0].why, /not an active mentee/);
  });

  await t.test('an admin\'s group fits whoever is in it', () => {
    assert.deepEqual(rows[G.admins].misfits, []);
  });

  await t.test('a group whose creator has left is flagged, its members are not', () => {
    assert.equal(rows[G.left].creatorIsMember, false);
    assert.deepEqual(rows[G.left].misfits, []);
  });

  await t.test('a group made by someone who is no longer a mentor: every other member is listed', () => {
    assert.deepEqual(rows[G.demoted].misfits.map((m) => m.id), [USERS.student2._id]);
    assert.match(rows[G.demoted].misfits[0].why, /cannot add anyone/);
  });

  await t.test('a member who no longer exists is listed', () => {
    assert.deepEqual(rows[G.ghost].misfits.map((m) => m.id), [GONE]);
  });
});

test('the printed report', async (t) => {
  const rows = await report(db());

  await t.test('by default carries ids and counts, and no name or email', () => {
    const text = lines(rows).join('\n');
    assert.match(text, /6 group\(s\); 3 with at least one member who could not be added today; 1 whose creator is not a member/);
    assert.ok(text.includes(G.joined) && text.includes(USERS.student2._id));
    for (const name of ['Joined', 'Second Student', 'Test Student', '@test.local']) assert.ok(!text.includes(name), name);
    assert.ok(!text.includes(G.fits), 'a group that fits is not listed');
  });

  await t.test('with names when asked, and still no email', () => {
    const text = lines(rows, { names: true }).join('\n');
    assert.ok(text.includes('"Joined"') && text.includes('"Second Student"'));
    assert.ok(!text.includes('@test.local'));
  });

  await t.test('says so when everything fits', () => {
    assert.match(lines([rows.find((r) => r.id === G.fits)]).join('\n'), /Every member of every group fits the rule/);
  });
});

test('it changes nothing', async (t) => {
  await t.test('the database is the same after as before', async () => {
    const snapshot = async () => JSON.stringify({
      groups: await db().collection('groups').find({}).sort({ _id: 1 }).toArray(),
      users: await db().collection('users').find({}).sort({ _id: 1 }).toArray(),
      mentorships: await db().collection('mentorships').find({}).sort({ _id: 1 }).toArray()
    });
    const before = await snapshot();
    await report(db());
    assert.equal(await snapshot(), before);
  });

  await t.test('the script calls nothing that writes', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'report-group-members.cjs'), 'utf8');
    for (const write of ['insert', 'update', 'delete', 'remove', 'replace', 'drop', 'bulkWrite', '.save(', '$pull', '$set', 'findOneAnd', 'createIndex']) {
      assert.ok(!src.replace(/\/\*[\s\S]*?\*\//g, '').includes(write), `the script mentions ${write}`);
    }
  });
});
