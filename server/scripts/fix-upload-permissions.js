const fs = require('fs');
const path = require('path');
const { DIR_MODE, FILE_MODE } = require('../utils/upload-permissions');

const serverDir = path.join(__dirname, '..');
const uploadsDir = path.join(serverDir, 'uploads');

function chmodIfExists(targetPath, mode) {
  if (!fs.existsSync(targetPath)) return;
  fs.chmodSync(targetPath, mode);
}

function walk(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  const stat = fs.statSync(targetPath);
  if (stat.isDirectory()) {
    chmodIfExists(targetPath, DIR_MODE);
    for (const name of fs.readdirSync(targetPath)) {
      walk(path.join(targetPath, name));
    }
  } else {
    chmodIfExists(targetPath, FILE_MODE);
  }
}

chmodIfExists(path.dirname(serverDir), DIR_MODE);
chmodIfExists(serverDir, DIR_MODE);
walk(uploadsDir);

console.log(`上传目录权限已修复: ${uploadsDir}`);
