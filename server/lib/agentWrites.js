/**
 * The agent's write tools, as Express knows them (AGENT_PLAN §3.2, §4.4).
 *
 * Nothing here writes. A write tool only ever becomes a signed proposal, which a
 * person approves and their own browser runs against the real route.
 *
 * Only what is listed here can be proposed or claimed. §4.4 is stricter than the
 * API on purpose: submitting or editing a hand-in, accepting or requesting
 * changes, deleting or withdrawing anything, unsubmitting, opt-outs, announcements,
 * groups and adding a student are never tools, whatever the API allows.
 */
const BOTH = Object.freeze(['mentor', 'student']);
const MENTOR = Object.freeze(['mentor']);

const WRITE_TOOLS = {
  create_assignment: { roles: MENTOR },
  extend_assignment_deadline: { roles: MENTOR },
  set_goal: { roles: MENTOR },
  toggle_milestone: { roles: BOTH },
  propose_session: { roles: BOTH },
  confirm_session: { roles: BOTH },
  add_resource: { roles: BOTH }
};

for (const spec of Object.values(WRITE_TOOLS)) Object.freeze(spec);
Object.freeze(WRITE_TOOLS);

/** The tool by name, as an own property only: `constructor` is not a tool. */
function writeTool(name) {
  return typeof name === 'string' && Object.hasOwn(WRITE_TOOLS, name) ? WRITE_TOOLS[name] : null;
}

module.exports = { WRITE_TOOLS, writeTool };
