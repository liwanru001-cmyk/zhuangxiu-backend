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

test('canonicalizes this bucket signed HTTPS URL before persistence', () => {
  const originalBucket = process.env.OSS_BUCKET;
  process.env.OSS_BUCKET = 'yinnkhome666';
  try {
    const signed = 'https://yinnkhome666.oss-rg-china-mainland.aliyuncs.com/uploads/a%20b.jpg?OSSAccessKeyId=test&Expires=1&Signature=a%2Bb%3D';
    assert.equal(
      storage.canonicalStorageUri(signed),
      'oss://yinnkhome666/uploads/a b.jpg'
    );
    assert.deepEqual(
      storage.canonicalizeStorageUrisDeep({ cover_url: signed, external: 'https://example.com/a.jpg' }),
      {
        cover_url: 'oss://yinnkhome666/uploads/a b.jpg',
        external: 'https://example.com/a.jpg',
      }
    );
  } finally {
    if (originalBucket === undefined) delete process.env.OSS_BUCKET;
    else process.env.OSS_BUCKET = originalBucket;
  }
});

test('deep storage URL transforms preserve database date values', () => {
  const createdAt = new Date('2026-08-11T03:04:05.000Z');
  const signed = storage.signStorageUrisDeep({ created_at: createdAt });
  const canonical = storage.canonicalizeStorageUrisDeep({ created_at: createdAt });

  assert.equal(signed.created_at, createdAt);
  assert.equal(canonical.created_at, createdAt);
  assert.equal(
    JSON.parse(JSON.stringify(signed)).created_at,
    '2026-08-11T03:04:05.000Z'
  );
});

test('creates a signed OSS image thumbnail URL', () => {
  const previous = {
    region: process.env.OSS_REGION,
    bucket: process.env.OSS_BUCKET,
    keyId: process.env.OSS_ACCESS_KEY_ID,
    secret: process.env.OSS_ACCESS_KEY_SECRET,
    endpoint: process.env.OSS_ENDPOINT,
  };
  process.env.OSS_REGION = 'oss-cn-hangzhou';
  process.env.OSS_BUCKET = 'thumbnail-test-bucket';
  process.env.OSS_ACCESS_KEY_ID = 'test-key';
  process.env.OSS_ACCESS_KEY_SECRET = 'test-secret';
  delete process.env.OSS_ENDPOINT;
  try {
    const signed = storage.signedImageThumbnailUrl(
      'oss://thumbnail-test-bucket/uploads/site.jpg',
      { width: 240, height: 240, quality: 70 }
    );
    const url = new URL(signed);
    assert.equal(
      url.searchParams.get('x-oss-process'),
      'image/auto-orient,1/resize,m_fill,w_240,h_240/quality,q_70'
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      const envName = {
        region: 'OSS_REGION',
        bucket: 'OSS_BUCKET',
        keyId: 'OSS_ACCESS_KEY_ID',
        secret: 'OSS_ACCESS_KEY_SECRET',
        endpoint: 'OSS_ENDPOINT',
      }[key];
      if (value === undefined) delete process.env[envName];
      else process.env[envName] = value;
    }
  }
});
