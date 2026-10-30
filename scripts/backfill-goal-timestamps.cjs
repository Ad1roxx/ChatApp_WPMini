/**
 * Give every goal written before S1.5 an `updatedAt`.
 *
 *     node scripts/backfill-goal-timestamps.cjs                 # dev: chatapp on 27017
 *     node scripts/backfill-goal-timestamps.cjs <mongodb-uri>   # anywhere else
 *     node scripts/backfill-goal-timestamps.cjs --dry-run       # count, change nothing
 *
 * Run by hand, once, against each database that has goals. Safe to run again:
 * it only touches goals that have no `updatedAt`, so a second run finds none.
 *
 * ## Why it exists
 *
 * Goals gained `timestamps: true` in S1.5. Mongoose sets `updatedAt` on the next
 * save, but a goal nobody edits would never get one - and the retrieval
 * service's read-time check drops any chunk it cannot prove is current. Without
 * this, every existing goal would vanish from the Copilot until someone happened
 * to tick one of its milestones.
 *
 * `updatedAt = createdAt` is the honest value: the last time anyone can show the
 * goal changed is when it was made. It is set with an update *pipeline* so the
 * value comes from each document's own `createdAt`, in the database, in one
 * statement - not read out and written back one goal at a time.
 */

const path = require('node:path');
const mongoose = require(path.join(__dirname, '..', 'server', 'node_modules', 'mongoose'));

const DEFAULT_URI = 'mongodb://127.0.0.1:27017/chatapp';

/**
 * Backfill one database. Returns what it found and what it did, so a caller -
 * or a test - can see the difference between "nothing to do" and "did nothing".
 */
async function backfill(db, { dryRun = false } = {}) {
  const goals = db.collection('goals');

  const missing = { updatedAt: { $exists: false } };
  const fixable = { ...missing, createdAt: { $exists: true } };

  const found = await goals.countDocuments(missing);
  // A goal with neither field cannot be dated honestly. Left alone and
  // reported: inventing a date would be worse than the check failing closed.
  const undatable = await goals.countDocuments({ ...missing, createdAt: { $exists: false } });

  let updated = 0;
  if (!dryRun && found > undatable) {
    const result = await goals.updateMany(fixable, [{ $set: { updatedAt: '$createdAt' } }]);
    updated = result.modifiedCount;
  }

  return { found, updated, undatable };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const uri = args.find((a) => !a.startsWith('--')) || DEFAULT_URI;

  await mongoose.connect(uri);
  try {
    const { found, updated, undatable } = await backfill(mongoose.connection.db, { dryRun });
    console.log(`${mongoose.connection.db.databaseName}: ${found} goal(s) without updatedAt`);
    console.log(dryRun ? '  dry run - nothing changed' : `  set updatedAt = createdAt on ${updated}`);
    if (undatable) {
      console.log(`  ${undatable} have no createdAt either - left alone, they cannot be dated`);
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { backfill };
