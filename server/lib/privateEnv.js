/**
 * Settings that name real people, kept outside the repository.
 *
 * Other tools work in the repository folder and can read any file in it, git-ignored
 * or not. So ADMIN_EMAILS is in a file called `server.env`, beside the file the
 * AI_ENV_FILE environment variable names (BUILD_NOTES Entry 103). `server/.env` keeps
 * only settings that say nothing about anyone, and the key scan fails if that changes.
 *
 * If it is missing, either way, the server refuses to start with one plain sentence,
 * as it does without FIREBASE_PROJECT_ID.
 */

const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const SERVER_ENV_NAME = 'server.env';

/** Where the file is, or null when AI_ENV_FILE is not set. */
function serverEnvFile(env = process.env) {
  const named = String(env.AI_ENV_FILE || '').trim();
  return named ? path.join(path.dirname(named), SERVER_ENV_NAME) : null;
}

/** The sentence to refuse with, or null when the file is there. */
function serverEnvProblem(env = process.env, exists = fs.existsSync) {
  const file = serverEnvFile(env);
  if (!file) {
    return (
      'AI_ENV_FILE is not set, so the server cannot find server.env, the file outside the ' +
      'repository that holds ADMIN_EMAILS. See server/.env.example.'
    );
  }
  if (!exists(file)) {
    return `There is no ${SERVER_ENV_NAME} beside the AI_ENV_FILE file. Create it with ADMIN_EMAILS. See server/.env.example.`;
  }
  return null;
}

/**
 * Load the file. Returns the problem, if there is one, for the caller to refuse with.
 * Never overrides what the environment already sets.
 */
function loadServerEnv(env = process.env) {
  const problem = serverEnvProblem(env);
  if (problem) return problem;
  dotenv.config({ path: serverEnvFile(env), quiet: true });
  return null;
}

module.exports = { SERVER_ENV_NAME, serverEnvFile, serverEnvProblem, loadServerEnv };
