'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { collectReferences, sourceScope, validateAsset } = require('../services/public-product-assets');

test('asset traversal only collects approved product media fields', () => {
  const payload = {
    cover_url: 'https://cdn.example.com/cover.jpg',
    source_url: 'https://www.example.com/product/1',
    image_urls: ['https://cdn.example.com/a.jpg'],
    product_details: {
      source_url: 'https://www.example.com/product/1',
      configurations: [{
        image_url: 'https://cdn.example.com/config.webp',
        drawing_url: 'https://cdn.example.com/drawing.pdf',
        parts: [{ swatch_url: 'https://cdn.example.com/swatch.png' }],
      }],
    },
  };
  const refs = collectReferences(payload);
  assert.equal(refs.length, 5);
  assert.equal(refs.some(item => item.url.includes('/product/1')), false);
});

test('asset scope permits all paths but only explicitly authorized hosts', () => {
  const scope=sourceScope({ id:2,status:'active',allowed_hosts:'["www.example.com"]',allowed_asset_hosts:'["cdn.example.com"]' });
  assert.deepEqual(scope.allowed_asset_hosts,['cdn.example.com']);
  assert.deepEqual(scope.allowed_hosts,[]);
  assert.equal(scope.source_status,'active');
  assert.throws(() => sourceScope({ allowed_hosts:'["www.example.com"]',allowed_asset_hosts:'[]' }), /授权域名/);
  const legacyScope=sourceScope({base_url:'https://banlan.com.cn/',allowed_hosts:'["banlan.com.cn"]',allowed_asset_hosts:'[]'});
  assert.deepEqual(legacyScope.allowed_asset_hosts,['banlan.com.cn']);
});

test('asset validation rejects HTML and accepts a real PDF signature', async () => {
  await assert.rejects(() => validateAsset(Buffer.from('<html>'), 'text/html'), /类型不允许/);
  assert.deepEqual(
    await validateAsset(Buffer.from('%PDF-1.7\n'), 'application/pdf; charset=binary'),
    { type: 'application/pdf', extension: 'pdf' }
  );
});

test('asset validation content-sniffs only ambiguous binary responses', async () => {
  const jpeg = await sharp({ create:{ width:2,height:2,channels:3,background:'#ffffff' } }).jpeg().toBuffer();
  assert.deepEqual(await validateAsset(jpeg, 'application/octet-stream'), { type:'image/jpeg',extension:'jpg' });
  assert.deepEqual(await validateAsset(Buffer.from('%PDF-1.7\n'), 'application/octet-stream'), { type:'application/pdf',extension:'pdf' });
  await assert.rejects(() => validateAsset(jpeg, 'text/html'), /类型不允许/);
  await assert.rejects(() => validateAsset(Buffer.from('<html>blocked</html>'), 'application/octet-stream'), /类型不允许/);
});
