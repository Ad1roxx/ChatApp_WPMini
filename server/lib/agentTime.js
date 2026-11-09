/**
 * Times in the agent's write dialog: read from what the model wrote, and shown to a person.
 *
 * `formatTime` must say exactly what `readable_time` in ai/agent.py says, so the time
 * in a dialog is the time the model read. ai/tests/test_agent_writes.py compares the
 * two on the same values, by running this file.
 *
 * One fixed zone, the settings the AI service uses, because a record holds UTC and
 * neither service knows where a viewer is.
 */
const OFFSET_MINUTES = Number.parseInt(process.env.AI_AGENT_TIME_OFFSET_MINUTES ?? '330', 10);
const ZONE_NAME = process.env.AI_AGENT_TIME_ZONE_NAME ?? 'IST';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** A moment as a person would say it, e.g. "Tue 10 Nov 2026, 5:30 pm IST". */
function formatTime(value) {
  const at = new Date(new Date(value).getTime() + OFFSET_MINUTES * 60000);
  const hour = at.getUTCHours();
  const minutes = String(at.getUTCMinutes()).padStart(2, '0');
  const year = String(at.getUTCFullYear()).padStart(4, '0');
  return `${DAYS[at.getUTCDay()]} ${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${year}, ` +
    `${hour % 12 || 12}:${minutes} ${hour < 12 ? 'am' : 'pm'} ${ZONE_NAME}`;
}

/**
 * "YYYY-MM-DDTHH:MM" in the shown zone, as a Date, or null if it isn't a real time.
 * 31 February does not roll over into March: what the model wrote is what is meant.
 */
function parseLocal(text) {
  const m = typeof text === 'string' ? LOCAL.exec(text) : null;
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (
    asUtc.getUTCFullYear() !== y || asUtc.getUTCMonth() !== mo - 1 || asUtc.getUTCDate() !== d ||
    asUtc.getUTCHours() !== h || asUtc.getUTCMinutes() !== mi
  ) {
    return null;
  }
  return new Date(asUtc.getTime() - OFFSET_MINUTES * 60000);
}

module.exports = { formatTime, parseLocal };
