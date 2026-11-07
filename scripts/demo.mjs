/**
 * The whole app, with invented data, from one command.
 *
 *   npm run demo                       # Rohan (student) and Meera (mentor)
 *   npm run demo -- --student ananya   # the other student
 *   npm run demo -- --reseed           # rebuild the demo data first
 *   npm run demo -- --agent            # the panel uses the agent (COPILOT_AGENT)
 *
 * Checks Docker and MongoDB, starts the Atlas container if it is stopped, starts
 * the AI service, Express and two copies of the front end, waits until the service
 * has its models loaded, seeds the demo data if it is not there, and prints the
 * addresses. Ctrl+C stops everything it started, the container included if it was
 * the one to start it.
 *
 * It keeps out of the way of normal development: its own databases
 * (`chatapp_demo`) and its own API and service ports, so it cannot write to
 * `chatapp` or `chatapp_rag` and can run beside a dev server, apart from the two
 * front-end ports. Those are 5173 and 3000 because they are the two the server's
 * socket accepts, and one signed-in person per address is how the dev sign-in
 * works: the id is fixed when Vite starts.
 *
 * No new dependency: Node's own child_process is enough for this.
 */

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const AI = path.join(ROOT, 'ai');
const PYTHON = path.join(AI, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const VITE = path.join(ROOT, 'node_modules/vite/bin/vite.js');
const LOGS = path.join(tmpdir(), 'mentorconnect-demo');

const DB = 'chatapp_demo';
const API_PORT = 3101;
const AI_PORT = 8101;
const API = `http://127.0.0.1:${API_PORT}`;
const CONTAINER = 'mc-atlas';

const MENTOR = { id: '00000000000000000000d001', name: 'Meera Iyer', port: 3000 };
const STUDENTS = {
  rohan: { id: '00000000000000000000d002', name: 'Rohan Kapoor' },
  ananya: { id: '00000000000000000000d003', name: 'Ananya Rao' }
};

const args = process.argv.slice(2);
const studentArg = args.includes('--student') ? args[args.indexOf('--student') + 1] : 'rohan';
const STUDENT = { ...STUDENTS[studentArg], port: 5173 };

const started = [];
let startedContainer = false;
let stopping = false;

const fail = (message) => {
  console.error(`\n${message}\n`);
  stop(1);
};

const portOpenOn = (port, host) =>
  new Promise((resolve) => {
    const socket = connect({ port, host });
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
    socket.on('error', () => resolve(false));
  });

// Both, because Vite listens on `localhost`, which on Windows is IPv6.
const portOpen = async (port) => (await portOpenOn(port, '127.0.0.1')) || portOpenOn(port, '::1');

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, check, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (stopping) return;
    if (await check()) return;
    await pause(500);
  }
  fail(`${what} did not come up in ${seconds} seconds. Logs: ${LOGS}`);
}

const docker = (...a) => spawnSync('docker', a, { encoding: 'utf8' });

function run(name, command, commandArgs, options) {
  const log = createWriteStream(path.join(LOGS, `${name}.log`));
  const child = spawn(command, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => {
    if (!stopping) fail(`${name} stopped unexpectedly (exit ${code}). See ${path.join(LOGS, `${name}.log`)}`);
  });
  started.push(child);
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (started.length || startedContainer) console.log('\nStopping everything the demo started…');
  for (const child of started) {
    if (child.exitCode !== null) continue;
    // On Windows a signal does not reach a child's own children.
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill();
  }
  if (startedContainer) docker('stop', CONTAINER);
  process.exit(code);
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
process.on('SIGBREAK', () => stop(0)); // Windows: Ctrl+Break, and how a script can stop this

async function main() {
  if (!STUDENTS[studentArg]) fail(`Unknown student '${studentArg}'. Use one of: ${Object.keys(STUDENTS).join(', ')}.`);
  if (!existsSync(PYTHON)) fail(`The Python environment is missing. Create it first: see ai/README.md (${PYTHON}).`);
  mkdirSync(LOGS, { recursive: true });

  // ---- what has to be there already
  if (docker('info').status !== 0) {
    fail('Docker is not running. Start Docker Desktop, wait for it to say it is running, and run this again.');
  }
  if (!(await portOpen(27017))) {
    fail('MongoDB is not answering on port 27017. Start the MongoDB service and run this again.');
  }
  for (const [port, name] of [[API_PORT, 'the demo API'], [AI_PORT, 'the demo AI service'], [5173, 'the student front end'], [3000, 'the mentor front end']]) {
    if (await portOpen(port)) fail(`Port ${port}, needed for ${name}, is already in use. Is a dev server or another demo running?`);
  }

  // ---- the container
  const state = docker('inspect', '-f', '{{.State.Running}}', CONTAINER);
  if (state.status !== 0) {
    console.log('Creating the Atlas container (the first time downloads the image)…');
    if (docker('run', '-d', '--name', CONTAINER, '-p', '27018:27017', 'mongodb/mongodb-atlas-local:latest').status !== 0) {
      fail(`Could not create the ${CONTAINER} container.`);
    }
    startedContainer = true;
  } else if (state.stdout.trim() !== 'true') {
    console.log(`Starting the ${CONTAINER} container…`);
    if (docker('start', CONTAINER).status !== 0) fail(`Could not start the ${CONTAINER} container.`);
    startedContainer = true;
  }
  // Healthy, not just listening: the port opens well before Atlas Search is ready, and
  // the service cannot start until it is. Found by a cold start (BUILD_NOTES Entry 80).
  console.log('Waiting for Atlas Search to be ready…');
  await until(
    'The Atlas container',
    () => docker('inspect', '-f', '{{.State.Health.Status}}', CONTAINER).stdout.trim() === 'healthy',
    180
  );

  // ---- the service: /health only answers once its models have loaded, because
  // the start-up that loads them runs before it accepts a connection.
  const secret = randomBytes(24).toString('hex');
  // The agent's capability tokens are signed with a key only Express holds,
  // never the service's secret (server/lib/agentToken.js). Fresh for each run.
  const agentSecret = randomBytes(32).toString('hex');
  console.log('Starting the AI service; loading its models takes a little while…');
  const aiStart = Date.now();
  run('ai', PYTHON, ['-m', 'uvicorn', 'app:app', '--host', '127.0.0.1', '--port', String(AI_PORT)], {
    cwd: AI,
    env: {
      ...process.env,
      AI_DB_NAME: DB,
      AI_APP_DB_NAME: DB,
      AI_SERVICE_SECRET: secret,
      AI_CATCHUP: 'full',
      // The agent's tools run through this run's Express, not the dev server's.
      AI_AGENT_TOOLS_URL: API
    }
  });
  await until(
    'The AI service',
    async () => {
      try {
        return (await fetch(`http://127.0.0.1:${AI_PORT}/health`)).ok;
      } catch {
        return false;
      }
    },
    240
  );
  console.log(`AI service ready, models loaded, in ${((Date.now() - aiStart) / 1000).toFixed(1)} s.`);

  // ---- Express
  run('api', process.execPath, ['index.js'], {
    cwd: path.join(ROOT, 'server'),
    env: {
      ...process.env,
      PORT: String(API_PORT),
      MONGODB_URI: `mongodb://127.0.0.1:27017/${DB}`,
      ALLOW_DEV_AUTH: 'true',
      AI_SERVICE_URL: `http://127.0.0.1:${AI_PORT}`,
      AI_SERVICE_SECRET: secret,
      AGENT_TOKEN_SECRET: agentSecret,
      // Off unless asked for: the agent is off until S4's evaluation.
      COPILOT_AGENT: args.includes('--agent') ? '1' : ''
    }
  });
  await until('Express', () => portOpen(API_PORT), 60);

  // ---- the data
  console.log('Checking the demo data…');
  const seed = spawn(PYTHON, [path.join('scripts', 'seed-demo.py'), ...(args.includes('--reseed') ? [] : ['--if-empty'])], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, DEMO_DB: DB, DEMO_API: API }
  });
  const seeded = await new Promise((resolve) => seed.on('exit', resolve));
  if (seeded !== 0) fail('Seeding the demo data failed.');

  // ---- one front end per person
  for (const [name, person] of [['student', STUDENT], ['mentor', MENTOR]]) {
    run(`web-${name}`, process.execPath, [VITE, '--port', String(person.port), '--strictPort'], {
      cwd: ROOT,
      env: { ...process.env, VITE_DEV_USER_ID: person.id, VITE_SERVER_URL: API }
    });
    await until(`The ${name} front end`, () => portOpen(person.port), 60);
  }

  console.log(`
  The demo is running. Everyone and everything in it is invented.

    ${STUDENT.name} (student)   http://localhost:${STUDENT.port}
    ${MENTOR.name} (mentor)     http://localhost:${MENTOR.port}

  Each address is already signed in as that person, with no Google sign-in.
  The first page load after a start takes about 20 seconds; after that it is instant.
  Open a mentorship and ask the assistant something. Ended mentorships refuse.

  Logs: ${LOGS}
  Ctrl+C stops everything this started.
`);
}

main().catch((err) => fail(`The demo could not start: ${err.message}`));
