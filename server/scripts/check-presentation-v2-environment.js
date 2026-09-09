'use strict';

require('dotenv').config();
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { limits } = require('../services/presentation-v2/config');
const { configuration } = require('../services/presentation-v2/model');
const { preflight } = require('../services/presentation-v2/render');

async function checkModel(config, runtimeLimits, signal) {
  if (!config.apiKey) throw new Error('缺少 PRESENTATION_V2_API_KEY（或 DASHSCOPE_API_KEY）');
  const image = await sharp({
    create: { width: 32, height: 32, channels: 3, background: '#A78C6B' },
  }).png().toBuffer();
  const response = await fetch(`${config.baseUrl}${config.endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      enable_thinking: false,
      stream: false,
      temperature: 0,
      max_tokens: 64,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '确认你能看到图片。只返回 JSON：{"ok":true}' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${image.toString('base64')}` } },
        ],
      }],
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(runtimeLimits.callTimeout, 60000))]),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`视觉模型检查失败 (${response.status})：${result.error?.message || '无错误详情'}`);
  const content = String(result.choices?.[0]?.message?.content || '')
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(content);
  if (parsed.ok !== true) throw new Error('视觉模型没有返回预期 JSON');
  return {
    requested_model: config.model,
    resolved_model: result.model || config.model,
    usage: result.usage || null,
  };
}

async function main() {
  const runtimeLimits = limits();
  const config = configuration();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'zxw-presentation-v2-check-'));
  const signal = AbortSignal.timeout(120000);
  try {
    const render = await preflight({ directory, limits: runtimeLimits, signal });
    const model = process.argv.includes('--model')
      ? await checkModel(config, runtimeLimits, signal)
      : { skipped: true };
    process.stdout.write(`${JSON.stringify({ ok: true, render, model }, null, 2)}\n`);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`AI PPT v2 环境检查失败：${error.message}\n`);
  process.exitCode = 1;
});
