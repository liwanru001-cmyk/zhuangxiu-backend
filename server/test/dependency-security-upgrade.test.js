'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

test('upgraded Express and Multer accept a bounded multipart upload', async () => {
  const app = express();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 } });
  app.post('/upload', upload.single('file'), (req, res) => {
    res.json({ name: req.file.originalname, size: req.file.size, body: req.file.buffer.toString('utf8') });
  });
  const server = await new Promise(resolve => {
    const value = app.listen(0, '127.0.0.1', () => resolve(value));
  });
  try {
    const form = new FormData();
    form.append('file', new Blob(['safe upload']), 'sample.txt');
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/upload`, { method: 'POST', body: form });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { name: 'sample.txt', size: 11, body: 'safe upload' });
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('upgraded Sharp can decode and transform a generated image', async () => {
  const input = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const output = await sharp(input).resize(2, 2).jpeg().toBuffer();
  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
  assert.equal(metadata.format, 'jpeg');
});
