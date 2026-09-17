'use strict';

const fs = require('fs');
const path = require('path');

const serverRoot = path.resolve(__dirname, '..');
const publicRoots = ['storage', 'uploads', 'public'].map(name => path.join(serverRoot, name));
const backupPattern = /(^|[/\\])db-backups?([/\\]|$)|(?:^|[/\\])(?:pre-deploy|database|mysql)[^/\\]*\.(?:sql|dump|bak)(?:\.gz)?$/i;
const findings = [];

function walk(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.isFile()) {
      const relative = path.relative(serverRoot, target);
      if (backupPattern.test(relative)) findings.push(relative);
    }
  }
}

for (const root of publicRoots) walk(root);

if (findings.length) {
  console.error('Database backup files were found below publicly served directories:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('PASS: no database backup files exist below publicly served directories.');
