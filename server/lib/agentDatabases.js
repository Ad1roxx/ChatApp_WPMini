/**
 * The agent and the S2 ask route run on synthetic data only.
 *
 * Decided by the user on 2026-11-07 and 2026-11-09 (BUILD_NOTES Entries 101, 105): the development
 * database `chatapp` holds real people's accounts and messages, and the agent's
 * tools read the app's records through this server. So the agent route refuses,
 * with the same plain "not configured" sentence as any other missing setting,
 * unless the database this server is connected to is one of these: the demo, the
 * evaluation fixtures, and the tests' own databases.
 *
 * Deliberately a list in code and not an environment variable. Putting a real
 * database on it is a change to that decision, made here and reviewed, not a
 * value someone sets. The AI service keeps the same list
 * (ai/config.py, AGENT_SYNTHETIC_DATABASES) and checks its own databases too.
 *
 * Free-tier providers may use what they are sent, so nothing built from real
 * records may reach one: the S2 ask route refuses on the same list.
 */

const SYNTHETIC_DATABASES = Object.freeze([
  'chatapp_demo',
  'chatapp_eval',
  'chatapp_demo_eval',
  'chatapp_eval_ctx',
  'chatapp_agent_eval',
  'chatapp_asklive',
  'chatapp_test',
  'chatapp_rag_pytest',
  'chatapp_rag_pytest_app'
]);

const AGENT_NOT_CONFIGURED = 'The agent is not configured on this server.';

/** The sentence to refuse with, or null if the agent may run on `name`. */
function agentDatabaseRefusal(name) {
  return SYNTHETIC_DATABASES.includes(name) ? null : AGENT_NOT_CONFIGURED;
}

module.exports = { SYNTHETIC_DATABASES, AGENT_NOT_CONFIGURED, agentDatabaseRefusal };
