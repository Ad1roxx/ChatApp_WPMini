/**
 * The draft Express builds is the shape the AI service's export accepts.
 *
 * buildReport on a fixed input must equal ai/tests/fixtures/s8-draft.json,
 * and ai/tests/test_report_contract.py validates that same file against the
 * export's strict schema and exports it. A change to either side's shape
 * fails one of the two until the fixture is regenerated and both agree.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildReport } = require('../lib/coverageReport');
const input = require('./fixtures-s8-draft-input');

test('buildReport on the fixed input is exactly the shared fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'ai', 'tests', 'fixtures', 's8-draft.json'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(buildReport(input))), fixture);
});
