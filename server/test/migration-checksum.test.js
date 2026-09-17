'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { migrationChecksum, assertRecordedChecksum } = require('../scripts/run-pending-migrations');

test('migration checksum is deterministic over the exact SQL bytes', () => {
  assert.equal(migrationChecksum('SELECT 1;\n'), migrationChecksum('SELECT 1;\n'));
  assert.notEqual(migrationChecksum('SELECT 1;\n'), migrationChecksum('SELECT 1;\r\n'));
});

test('an applied migration with the same checksum remains valid', () => {
  const checksum = migrationChecksum('ALTER TABLE example ADD COLUMN value INT;\n');
  assert.doesNotThrow(() => assertRecordedChecksum('20260901_example.sql', checksum, checksum));
});

test('an applied migration with changed contents blocks deployment', () => {
  assert.throws(
    () => assertRecordedChecksum('20260901_example.sql', 'a'.repeat(64), 'b'.repeat(64)),
    error => error.code === 'MIGRATION_CHECKSUM_MISMATCH'
      && error.migration === '20260901_example.sql'
      && /immutable/i.test(error.message)
  );
});
