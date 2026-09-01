/**
 * ESLint flat config.
 *
 * One config for the whole repo, covering two very different environments:
 *
 * - `src/`    — browser, ES modules, JSX, React hooks rules
 * - `server/` — Node, CommonJS (`require`), no JSX
 *
 * Previously these lived in two legacy `.eslintrc.json` files that sat
 * alongside this one and were silently ignored, while this file itself
 * couldn't load at all (it needs ESLint 9 for the `eslint/config` subpath,
 * and ESLint 8 was what was actually installed). Nothing was ever linted.
 *
 * That matters more than it sounds: `vite build` compiles undefined
 * variables perfectly happily. Entry 7 shipped a missing `dbUser`
 * destructure that built green and crashed at runtime — `no-undef` catches
 * exactly that, which is why this config declares globals per environment
 * rather than switching the rule off.
 */

import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', 'server/node_modules']),

  // ---- Frontend: browser + ES modules + React ----
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      // NOTE: in eslint-plugin-react-hooks v7, `configs.recommended` and
      // `configs['recommended-latest']` are still the LEGACY eslintrc shape
      // (plugins as an array), which flat config rejects outright. The flat
      // versions live under `configs.flat`.
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Allow intentionally-unused capitalised bindings (constants, components)
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]' }],

      // Advisory, not an error, in this codebase.
      //
      // v7 of the hooks plugin ships the React Compiler rule set, which is
      // stricter than the code was written against. This rule fires in two
      // places, and neither is a defect:
      //
      // - ProfilePage seeds its form fields from `dbUser` in an effect. This
      //   is the documented "reset the form when the record changes" pattern.
      //   The alternative React suggests is remounting via `key`, which would
      //   mean extracting the form into a child component — more moving parts
      //   for no behavioural gain.
      // - GroupsPage calls an `async` fetch function from an effect. The
      //   setState happens in a promise callback, not synchronously, but the
      //   rule cannot see through the async boundary.
      //
      // Left at 'warn' so genuinely new occurrences still show up, rather
      // than switched off and forgotten.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  // ---- Backend: Node + CommonJS ----
  // Separate block because `require`, `module` and `process` are undefined in
  // the browser and `window`/`document` are undefined in Node. Linting both
  // with one set of globals would either miss real typos or invent fake ones.
  {
    files: ['server/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'commonjs',
    },
  },

  // ---- Config files at the repo root (Node, ES modules) ----
  {
    files: ['*.config.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      globals: globals.node,
      sourceType: 'module',
    },
  },
])
