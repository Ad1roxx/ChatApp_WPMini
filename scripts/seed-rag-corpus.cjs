/**
 * A corpus to retrieve from and to evaluate against.
 *
 * Written into the Atlas Local container (27018), database `chatapp_rag`, so
 * the real development database on 27017 is never touched.
 *
 * Two mentorships, deliberately about the SAME topics: Priya→Aditya and
 * Karan→Zara both cover indexing and caching. If retrieval ever leaks across
 * mentorships, similar wording is how it will happen, so the corpus is built
 * to make that failure visible rather than unlikely.
 *
 * Files are NOT seeded here. The synthetic PDFs and Word documents are built
 * by `ai/eval/seed_documents.py`, which runs after this and attaches them to
 * these hand-ins. Writing a PDF needs PyMuPDF, which the Python service
 * already depends on; a second PDF writer in Node, for test fixtures, would
 * be a dependency bought to avoid crossing a language boundary once.
 *
 *     node scripts/seed-rag-corpus.cjs
 *     cd ai && .venv/Scripts/python.exe eval/seed_documents.py
 */

const ROOT = 'C:/Users/Aditya Dubey/Documents/Aditya_dubey_16010423006/chat_app_miniproject/server';
const mongoose = require(ROOT + '/node_modules/mongoose');

const URI = 'mongodb://127.0.0.1:27018/chatapp_rag?directConnection=true';

const oid = (hex) => new mongoose.Types.ObjectId(hex);
const nid = () => new mongoose.Types.ObjectId();
const days = (n) => new Date(Date.now() + n * 86400000);

const PRIYA = '0000000000000000000000b1';
const ADITYA = '0000000000000000000000a1';
const KARAN = '0000000000000000000000c1';
const ZARA = '0000000000000000000000c2';

const M1 = 'd00000000000000000000001'; // Priya  → Aditya
const M2 = 'd00000000000000000000002'; // Karan  → Zara

const user = (id, name, role) => ({
  _id: oid(id),
  firebaseUid: 'rag-' + id,
  email: `${name.split(' ')[0].toLowerCase()}@rag.local`,
  displayName: name,
  photoURL: '',
  role,
  isOnline: false,
  bio: '',
  expertise: '',
  availability: '',
  createdAt: days(-90)
});

const mentorship = (id, mentor, student, topic) => ({
  _id: oid(id),
  mentor: oid(mentor),
  student: oid(student),
  topic,
  message: '',
  status: 'active',
  initiatedBy: 'mentor',
  requestedAt: days(-80),
  respondedAt: days(-80),
  responseNote: '',
  endedAt: null,
  endedBy: null,
  optOut: { status: 'none', reason: '', requestedAt: null, responseNote: '', respondedAt: null }
});

const assignment = (mentorId, mentorshipId, title, instructions, dueInDays) => ({
  _id: nid(),
  mentor: oid(mentorId),
  mentorships: [oid(mentorshipId)],
  title,
  instructions,
  dueAt: days(dueInDays),
  createdAt: days(dueInDays - 7),
  updatedAt: days(dueInDays - 7)
});

const submission = (assignmentDoc, mentorshipId, studentId, text, review) => ({
  _id: nid(),
  assignment: assignmentDoc._id,
  mentorship: oid(mentorshipId),
  student: oid(studentId),
  status: review ? 'accepted' : 'submitted',
  text,
  url: '',
  attachments: [],
  submittedAt: days(-3),
  draftSavedAt: null,
  review: review ? { note: review, reviewedAt: days(-2) } : { note: '', reviewedAt: null },
  history: [],
  createdAt: days(-5),
  updatedAt: days(-2)
});

const resource = (mentorshipId, addedBy, title, url, note) => ({
  _id: nid(),
  mentorship: oid(mentorshipId),
  title,
  url,
  note,
  addedBy: oid(addedBy),
  createdAt: days(-20),
  updatedAt: days(-20)
});

const goal = (mentorshipId, title, milestones) => ({
  _id: nid(),
  mentorship: oid(mentorshipId),
  title,
  description: '',
  status: 'active',
  milestones: milestones.map(([t, done]) => ({
    _id: nid(),
    title: t,
    done,
    doneBy: done ? oid(ADITYA) : null,
    doneAt: done ? days(-10) : null
  })),
  createdBy: oid(PRIYA),
  createdAt: days(-40),
  updatedAt: days(-10)
});

(async () => {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;

  for (const c of await db.listCollections().toArray()) {
    if (!c.name.startsWith('knowledge_chunks')) await db.collection(c.name).deleteMany({});
  }

  await db.collection('users').insertMany([
    user(PRIYA, 'Priya Nair', 'mentor'),
    user(ADITYA, 'Aditya Dubey', 'student'),
    user(KARAN, 'Karan Shah', 'mentor'),
    user(ZARA, 'Zara Khan', 'student')
  ]);

  await db.collection('mentorships').insertMany([
    mentorship(M1, PRIYA, ADITYA, 'Backend interview preparation'),
    mentorship(M2, KARAN, ZARA, 'Backend fundamentals')
  ]);

  // ---------------- Mentorship 1: Priya → Aditya ----------------
  const a1 = assignment(
    PRIYA,
    M1,
    'Database indexing exercise',
    `Work through the three queries in the repo and make each one use an index.

Start with EXPLAIN on every query and note which ones do a collection scan. A
compound index only helps when the query's fields are a prefix of it, in that
order, so check the order before adding anything.

Write down, for each query: the plan before, the index you added, and the plan
after. I care more about the reasoning than the timings — a query that got
faster for the wrong reason is worth less than one you can explain.`,
    4
  );

  const a2 = assignment(
    PRIYA,
    M1,
    'Add caching to the reading list endpoint',
    `Put a cache in front of the endpoint that currently hits the database on
every request.

Decide the invalidation rule first and write it in a comment: when an item is
added, what exactly becomes stale? A cache you cannot explain the invalidation
of is a bug you have not met yet.

Use an in-process cache. Redis is the right answer at scale and the wrong
answer for learning what a cache actually does.`,
    -2
  );

  const a3 = assignment(
    PRIYA,
    M1,
    'REST authentication with refresh tokens',
    `Add sign-in to the practice API: an access token that expires in fifteen
minutes and a refresh token that does not sit in local storage.

Explain in your hand-in why the refresh token belongs in an httpOnly cookie,
and what an attacker with XSS on your page can and cannot do in each design.`,
    9
  );

  const a4 = assignment(
    PRIYA,
    M1,
    'Explain N+1 queries with a worked example',
    `Find an N+1 in the sample repository, show the query log that proves it, fix
it, and show the log afterwards.

A paragraph on why an ORM makes this easy to write by accident would be a good
addition.`,
    -9
  );

  await db.collection('assignments').insertMany([a1, a2, a3, a4]);

  await db.collection('submissions').insertMany([
    // A hand-in whose substance is in the attached report rather than in the
    // text box. Common in real coursework, and the case that used to be
    // skipped entirely before an attachment could be indexed.
    submission(
      a1,
      M1,
      ADITYA,
      'Report attached. The plans before and after are in it, with the row counts.',
      'Read it — the third query is the interesting one. See my note on the table.'
    ),
    submission(
      a3,
      M1,
      ADITYA,
      'Design document attached. Still unsure about the refresh token rotation.',
      ''
    ),
    submission(
      a2,
      M1,
      ADITYA,
      `Added an in-process LRU with a sixty second TTL. Invalidation: adding an
item clears the list for that user only, because the endpoint is per-user.

Stuck on one thing — two requests arriving together on a cold cache both hit
the database. I think that is the thundering herd problem but I did not fix it.`,
      `Good, and you spotted the herd yourself. The fix is to cache the promise
rather than the value, so the second caller waits on the first. Try that before
our next session.`
    ),
    submission(
      a4,
      M1,
      ADITYA,
      `The N+1 was in the comments loader: one query for posts, then one per post
for its author. Fixed with a single $lookup, 41 queries down to 2.`,
      `That is the right fix. Note the lookup is fine here because the collections
are small; at a million posts you would denormalise the author's name instead.`
    )
  ]);

  await db.collection('goals').insertOne(
    goal(M1, 'Be ready for backend interviews', [
      ['Explain indexing and query plans', true],
      ['Explain caching and invalidation', true],
      ['Explain authentication and sessions', false],
      ['Design a rate limiter', false]
    ])
  );

  await db.collection('resources').insertMany([
    resource(
      M1,
      PRIYA,
      'Use The Index, Luke',
      'https://use-the-index-luke.com/',
      'The B-tree chapter is the one to read before the indexing exercise. Skip the Oracle-specific parts.'
    ),
    resource(
      M1,
      PRIYA,
      'MongoDB compound index docs',
      'https://www.mongodb.com/docs/manual/core/index-compound/',
      'Read this for the prefix rule: an index on (a, b) helps a query on a, and on a with b, but not on b alone.'
    ),
    resource(
      M1,
      ADITYA,
      'A post on cache invalidation',
      'https://example.com/cache-invalidation',
      'The part about write-through versus write-around is what finally made the second assignment click for me.'
    ),
    resource(
      M1,
      PRIYA,
      'OWASP cheat sheet on token storage',
      'https://cheatsheetseries.owasp.org/',
      'Background for the refresh token assignment. The httpOnly cookie argument is in the session management sheet.'
    )
  ]);

  // ---------------- Mentorship 2: Karan → Zara, same topics on purpose ----------------
  const b1 = assignment(
    KARAN,
    M2,
    'Indexing homework',
    `Add indexes to the three slow queries in your project and explain each plan.

Zara: your compound index on (status, createdAt) is the one to look at first —
the prefix rule means it does nothing for a query on createdAt alone.`,
    5
  );

  const b2 = assignment(
    KARAN,
    M2,
    'Caching exercise',
    `Add a cache to your feed endpoint and write down the invalidation rule.

Remember our conversation about stale reads: a sixty second TTL is a decision
about how wrong you are willing to be, not a default to copy.`,
    -1
  );

  await db.collection('assignments').insertMany([b1, b2]);

  await db.collection('submissions').insertOne(
    submission(
      b1,
      M2,
      ZARA,
      'Added three indexes. The second one made no difference, which I think is the prefix rule you mentioned.',
      'Exactly right. Drop it rather than leaving a index nothing uses - every index costs you on every write.'
    )
  );

  await db.collection('resources').insertOne(
    resource(
      M2,
      KARAN,
      'Indexing basics',
      'https://example.com/indexing-basics',
      "Zara's reading for this week: how a B-tree keeps lookups logarithmic, and why that stops being true for low-cardinality fields."
    )
  );

  const counts = {};
  for (const name of ['users', 'mentorships', 'assignments', 'submissions', 'goals', 'resources']) {
    counts[name] = await db.collection(name).countDocuments();
  }
  console.log('seeded chatapp_rag:', JSON.stringify(counts));
  console.log('mentorship 1 (Priya -> Aditya):', M1);
  console.log('mentorship 2 (Karan  -> Zara  ):', M2);

  await mongoose.disconnect();
})();
