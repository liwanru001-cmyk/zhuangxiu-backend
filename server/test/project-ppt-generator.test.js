const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { generate, generateFromPlan, safeFileName } = require('../scripts/generate-ppt-from-plan');
const { fetchFile } = require('../scripts/generate-ppt-from-plan');
const storage = require('../services/storage.service');

test('PPT downloads stored OSS images through freshly signed HTTPS URLs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-ppt-oss-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const uri = 'oss://test-bucket/uploads/image.webp';
  const signed = 'https://test-bucket.oss-cn-hangzhou.aliyuncs.com/uploads/image.webp?Signature=fresh';
  t.mock.method(storage, 'signedUrlForStorageUri', value => {
    assert.equal(value, uri);
    return signed;
  });
  t.mock.method(globalThis, 'fetch', async url => {
    assert.equal(url.toString(), signed);
    return { ok: true, arrayBuffer: async () => Buffer.from('image bytes') };
  });
  const output = path.join(directory, 'image.webp');
  await fetchFile(uri, output);
  assert.equal(await fs.readFile(output, 'utf8'), 'image bytes');
});

test('safeFileName removes characters that are invalid in exported file names', () => {
  assert.equal(safeFileName('海景花园 / 方案:v1?'), '海景花园-方案-v1');
});

test('generate rejects a plan without a project name before rendering', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-ppt-test-'));
  const planPath = path.join(directory, 'invalid-plan.json');
  const outputPath = path.join(directory, 'invalid.pptx');
  await fs.writeFile(planPath, JSON.stringify({ project: {}, presentation: {} }));

  await assert.rejects(generate(planPath, outputPath), /项目名称/);
  await fs.rm(directory, { recursive: true, force: true });
});

test('generateFromPlan accepts validated in-memory data without persisting source JSON', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-ppt-memory-test-'));
  const outputPath = path.join(directory, 'memory.pptx');
  const result = await generateFromPlan({
    project: { name: '测试项目', code: 'TEST', client_name: '客户', stage: '方案', owner_status: '未加入' },
    presentation: { title: '测试汇报', subtitle: '测试', summary: '摘要', missing_information: [] },
    whole_house_documents: [],
    spaces: [],
    outline: [{ type: 'cover', title: '测试汇报' }, { type: 'ending', title: '下一步', narrative: '继续确认。' }],
  }, outputPath);
  assert.equal(result.slideCount, 2);
  assert.ok((await fs.stat(outputPath)).size > 5000);
  await fs.rm(directory, { recursive: true, force: true });
});

test('exported slide titles preserve all original document categories', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-ppt-categories-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const outputPath = path.join(directory, 'categories.pptx');
  const categories = [
    ['original_floor_plan', '原始户型图'], ['measurement', '量房图'],
    ['layout_plan', '平面方案'], ['rendering', '效果图'],
    ['construction_drawing', '施工图'], ['hydropower', '水电图'], ['other', '其他图纸'],
  ];
  const documents = categories.map(([category]) => ({ category, title: '原始资料名称' }));
  await generateFromPlan({
    project: { name: '分类测试' },
    presentation: { title: '分类测试' },
    whole_house_documents: documents,
    spaces: [{ id: 1, name: '户外', documents, renderings: [], products: [] }],
    outline: [
      { type: 'whole_house_plan', title: '错误的统一标题', narrative: '不应覆盖资料名称' },
      { type: 'space_solution', space_id: 1 },
    ],
  }, outputPath);
  const { execFileSync } = require('node:child_process');
  for (let index = 0; index < categories.length * 2; index++) {
    const xml = execFileSync('unzip', ['-p', outputPath, `ppt/slides/slide${index + 1}.xml`], { encoding: 'utf8' });
    assert.ok(xml.includes(`${index < categories.length ? '全屋' : '户外'} · ${categories[index % categories.length][1]}`));
    assert.ok(xml.includes('原始资料名称'));
    assert.ok(!xml.includes('错误的统一标题'));
  }
});
