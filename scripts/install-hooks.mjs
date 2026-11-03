/**
 * Points this clone's git at the tracked hooks in `.githooks`.
 *
 *   npm run hooks:install
 */
import { execFileSync } from 'node:child_process';

execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
console.log('Git hooks installed: every push now runs the suites and the key scan first.');
