const path = require('path');

const releasePlatforms = Object.freeze(['windows', 'macos', 'android']);

function releasePlatformAllowed(platform) {
  return releasePlatforms.includes(String(platform || '').toLowerCase());
}

function releaseExtensionAllowed(platform, filename) {
  const extension = path.extname(filename || '').toLowerCase();
  const extensions = {
    windows: ['.exe', '.msix'],
    macos: ['.dmg', '.pkg'],
    android: ['.apk'],
  };
  return extensions[platform]?.includes(extension) || false;
}

function releasePackageHint(platform) {
  return {
    windows: 'Windows 仅支持 .exe 或 .msix',
    macos: 'macOS 仅支持 .dmg 或 .pkg',
    android: 'Android 仅支持 .apk',
  }[platform] || '安装包格式不正确';
}

module.exports = {
  releasePlatforms,
  releasePlatformAllowed,
  releaseExtensionAllowed,
  releasePackageHint,
};
