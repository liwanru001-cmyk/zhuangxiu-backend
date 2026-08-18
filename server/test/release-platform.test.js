const test = require('node:test');
const assert = require('node:assert/strict');

const {
  releasePlatformAllowed,
  releaseExtensionAllowed,
  releasePackageHint,
} = require('../utils/release-platform');

test('release platforms include Android', () => {
  assert.equal(releasePlatformAllowed('windows'), true);
  assert.equal(releasePlatformAllowed('macos'), true);
  assert.equal(releasePlatformAllowed('android'), true);
  assert.equal(releasePlatformAllowed('ios'), false);
});

test('Android releases only accept APK packages', () => {
  assert.equal(releaseExtensionAllowed('android', '装筱窝.apk'), true);
  assert.equal(releaseExtensionAllowed('android', '装筱窝.APK'), true);
  assert.equal(releaseExtensionAllowed('android', '装筱窝.aab'), false);
  assert.equal(releaseExtensionAllowed('android', '装筱窝.exe'), false);
  assert.equal(releasePackageHint('android'), 'Android 仅支持 .apk');
});

test('desktop package restrictions remain unchanged', () => {
  assert.equal(releaseExtensionAllowed('windows', 'setup.exe'), true);
  assert.equal(releaseExtensionAllowed('windows', 'setup.msix'), true);
  assert.equal(releaseExtensionAllowed('macos', 'setup.dmg'), true);
  assert.equal(releaseExtensionAllowed('macos', 'setup.pkg'), true);
  assert.equal(releaseExtensionAllowed('windows', 'setup.apk'), false);
  assert.equal(releaseExtensionAllowed('macos', 'setup.apk'), false);
});
