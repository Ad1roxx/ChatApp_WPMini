/**
 * The one secret the demo must be given rather than make up: the key that signs the
 * agent's write proposals. It lives in `server.env`, the file outside the repository
 * beside the AI_ENV_FILE file.
 *
 * It is read here, and passed to Express alone. `server.env` is deliberately not loaded
 * into this process's environment, because the AI service is started from that
 * environment and must never hold a key that can sign a proposal.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MIN_LENGTH = 32;
const HOW = 'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"';

export const MISSING_PROPOSAL_SECRET =
  `AGENT_PROPOSAL_SECRET is missing from server.env, the file beside your AI_ENV_FILE file. The demo needs it to let you approve what the assistant proposes. Add it as AGENT_PROPOSAL_SECRET=<a random value>, and start the demo again. ${HOW}`;
export const NO_ENV_FILE = 'AI_ENV_FILE must name the file outside the repository that holds the keys. See ai/.env.example.';
export const SHORT_PROPOSAL_SECRET =
  `AGENT_PROPOSAL_SECRET in server.env is too short: it needs at least ${MIN_LENGTH} characters. ${HOW}`;

/**
 * The value of one setting in an env file. Read here rather than with dotenv, which only
 * `server/` depends on: this also runs in CI's frontend job, where only the root packages exist.
 */
function settingIn(text, name) {
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match?.[1] !== name) continue;
    const quoted = match[2].match(/^(["'])(.*)\1$/);
    return quoted ? quoted[2] : match[2].replace(/\s+#.*$/, '');
  }
  return '';
}

/** `{ secret }`, or `{ problem }`: one plain sentence for the person starting the demo. Never says the value. */
export function proposalSecret(env = process.env, read = (file) => readFileSync(file, 'utf8')) {
  const named = String(env.AI_ENV_FILE || '').trim();
  if (!named) return { problem: NO_ENV_FILE };
  let text;
  try {
    text = read(path.join(path.dirname(named), 'server.env'));
  } catch {
    return { problem: MISSING_PROPOSAL_SECRET };
  }
  const secret = settingIn(text, 'AGENT_PROPOSAL_SECRET').trim();
  if (!secret) return { problem: MISSING_PROPOSAL_SECRET };
  if (secret.length < MIN_LENGTH) return { problem: SHORT_PROPOSAL_SECRET };
  return { secret };
}
