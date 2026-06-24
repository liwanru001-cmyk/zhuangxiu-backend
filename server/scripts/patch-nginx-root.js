#!/usr/bin/env node

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('Usage: patch-nginx-root <nginx-config-file>');
  process.exit(2);
}

const text = fs.readFileSync(file, 'utf8');
const hit = text.indexOf('frontend not deployed');
if (hit === -1) {
  console.log('No frontend placeholder found; nginx config unchanged.');
  process.exit(0);
}

let locationStart = text.lastIndexOf('location /', hit);
const exactLocationStart = text.lastIndexOf('location = /', hit);
if (exactLocationStart > locationStart) {
  locationStart = exactLocationStart;
}

if (locationStart === -1) {
  console.error('Could not find the nginx root location before the frontend placeholder.');
  process.exit(1);
}

const openBrace = text.indexOf('{', locationStart);
if (openBrace === -1) {
  console.error('Could not find the opening brace for the nginx root location.');
  process.exit(1);
}

let depth = 0;
let locationEnd = -1;
for (let index = openBrace; index < text.length; index += 1) {
  if (text[index] === '{') {
    depth += 1;
  } else if (text[index] === '}') {
    depth -= 1;
    if (depth === 0) {
      locationEnd = index + 1;
      break;
    }
  }
}

if (locationEnd === -1) {
  console.error('Could not find the closing brace for the nginx root location.');
  process.exit(1);
}

const replacement = `location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }`;

fs.writeFileSync(file, `${text.slice(0, locationStart)}${replacement}${text.slice(locationEnd)}`);
console.log(`Patched nginx root location in ${file}`);
