'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recordToolCall, summarize } = require('../services/workbuddy-usage');

test('tool records increment calls atomically and increment failures only on failure', async () => {
  const params = [];
  const db = { async query(sql, values) {
    assert.match(sql, /ON DUPLICATE KEY UPDATE call_count = call_count \+ 1/);
    assert.match(sql, /UTC_TIMESTAMP\(\) \+ INTERVAL 8 HOUR/);
    params.push(values);
  } };
  await recordToolCall(db, 8, false);
  await recordToolCall(db, 8, true);
  assert.deepEqual(params, [[8, 0, 0], [8, 1, 1]]);
});

test('summary defaults to today and excludes tests, with inclusive Beijing lookback windows', async () => {
  const params = [];
  const db = { async query(sql, values) {
    assert.match(sql, /COUNT\(DISTINCT usage.user_id\)/);
    assert.match(sql, /COALESCE\(u.is_test_account, 0\) = 0/);
    params.push(values);
    return [[{ users: '2', calls: '9', failures: '1' }]];
  } };
  assert.deepEqual(await summarize(db), { users: 2, calls: 9, failures: 1 });
  await summarize(db, { days: '7' });
  await summarize(db, { days: '30', includeTests: '1' });
  await assert.rejects(summarize(db, { days: '365' }), { status: 400 });
  assert.deepEqual(params, [[0, 0], [6, 0], [29, 1]]);
});
