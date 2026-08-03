const test = require('node:test');
const assert = require('node:assert/strict');
const storage = require('../services/storage.service');

test('parses stable OSS storage identifiers', () => {
  assert.deepEqual(storage.parseOssStorageUri('oss://bucket/uploads/a.jpg'), {
    bucket: 'bucket',
    key: 'uploads/a.jpg',
  });
  assert.equal(storage.parseOssStorageUri('https://example.com/a.jpg'), null);
});

test('local driver leaves OSS identifiers unchanged without credentials', () => {
  const previous = {
    driver: process.env.STORAGE_DRIVER,
    keyId: process.env.OSS_ACCESS_KEY_ID,
    secret: process.env.OSS_ACCESS_KEY_SECRET,
  };
  process.env.STORAGE_DRIVER = 'local';
  delete process.env.OSS_ACCESS_KEY_ID;
  delete process.env.OSS_ACCESS_KEY_SECRET;
  assert.deepEqual(
    storage.signStorageUrisDeep({ url: 'oss://bucket/uploads/a.jpg' }),
    { url: 'oss://bucket/uploads/a.jpg' }
  );
  if (previous.driver === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = previous.driver;
  if (previous.keyId === undefined) delete process.env.OSS_ACCESS_KEY_ID;
  else process.env.OSS_ACCESS_KEY_ID = previous.keyId;
  if (previous.secret === undefined) delete process.env.OSS_ACCESS_KEY_SECRET;
  else process.env.OSS_ACCESS_KEY_SECRET = previous.secret;
});
