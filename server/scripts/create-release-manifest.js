'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const serverRoot = path.resolve(__dirname, '..');
const repositoryRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const releasePaths = [
  'server/app.js',
  'server/package.json',
  'server/package-lock.json',
  'server/ecosystem.config.cjs',
  'server/.env.example',
  'server/config',
  'server/controllers',
  'server/middleware',
  'server/migrations',
  'server/routes',
  'server/scripts',
  'server/services',
  'server/utils',
];

function git(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
}

function trackedFiles() {
  return git(['ls-files', '-z', '--', ...releasePaths]).split('\0').filter(Boolean).sort();
}

function resolveLocal(from, request) {
  const base = path.resolve(path.dirname(from), request);
  for (const candidate of [base, `${base}.js`, `${base}.json`, path.join(base, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function runtimeDependencies(entry) {
  const seen = new Set();
  const unresolved = [];
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      const target = resolveLocal(file, match[1]);
      if (!target) unresolved.push(`${path.relative(repositoryRoot, file)} -> ${match[1]}`);
      else visit(target);
    }
  }
  visit(entry);
  return { files: [...seen], unresolved };
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

const files = trackedFiles();
const tracked = new Set(files);
const dependencyGraph = runtimeDependencies(path.join(serverRoot, 'app.js'));
const untrackedRuntimeDependencies = dependencyGraph.files
  .map(file => path.relative(repositoryRoot, file))
  .filter(file => !tracked.has(file));
const releaseMigrations = files.filter(file => /^server\/migrations\/202609(?:1\d|2\d|30).*\.sql$/.test(file));

if (dependencyGraph.unresolved.length || untrackedRuntimeDependencies.length) {
  console.error(JSON.stringify({
    unresolved: dependencyGraph.unresolved,
    untracked_runtime_dependencies: untrackedRuntimeDependencies,
  }, null, 2));
  process.exit(1);
}
if (releaseMigrations.length !== 23) {
  console.error(`Expected 23 product/material release migrations, found ${releaseMigrations.length}`);
  process.exit(1);
}

const manifest = {
  schema_version: 1,
  release_sha: git(['rev-parse', 'HEAD']).trim(),
  tree_sha: git(['rev-parse', 'HEAD^{tree}']).trim(),
  created_at: new Date().toISOString(),
  runtime_dependency_count: dependencyGraph.files.length,
  migration_count: releaseMigrations.length,
  migrations: releaseMigrations,
  files: files.map(file => ({ file, sha256: sha256(path.join(repositoryRoot, file)) })),
};

const outputIndex = process.argv.indexOf('--output');
if (outputIndex >= 0) {
  const target = process.argv[outputIndex + 1];
  if (!target) throw new Error('--output requires a path');
  fs.writeFileSync(path.resolve(target), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
} else {
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}
