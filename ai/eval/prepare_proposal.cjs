/**
 * The dialog Express would build for a model's write call, for the S5 evaluation.
 *
 * Runs the shipped server/lib/agentWrites.js against chatapp_agent_eval and prints
 * { args, heading, fields } or { refuse }. Reads only, and refuses any other database.
 *
 * stdin: { tool, input, userId, mentorshipId, role, parties }
 */
const path = require('node:path');
const fs = require('node:fs');

const SERVER = path.join(__dirname, '..', '..', 'server');
const mongoose = require(path.join(SERVER, 'node_modules', 'mongoose'));

async function main() {
  const db = process.env.EVAL_DB;
  if (db !== 'chatapp_agent_eval') throw new Error('this helper only reads chatapp_agent_eval');
  const { tool, input, userId, mentorshipId, role, parties } = JSON.parse(fs.readFileSync(0, 'utf8'));
  await mongoose.connect(`mongodb://127.0.0.1:27017/${db}`, { serverSelectionTimeoutMS: 5000 });
  const Mentorship = require(path.join(SERVER, 'models', 'Mentorship'));
  const User = require(path.join(SERVER, 'models', 'User'));
  const { prepare } = require(path.join(SERVER, 'lib', 'agentWrites'));
  const [user, mentorship] = await Promise.all([User.findById(userId), Mentorship.findById(mentorshipId)]);
  const out = await prepare(tool, { input, user, mentorship, role, parties });
  process.stdout.write(JSON.stringify(out));
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
