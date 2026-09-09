'use strict';

const db = require('../config/db');
const storageService = require('./storage.service');
const { readDetails } = require('./product-details');

const allowedDetailLevels = new Set(['concise', 'standard', 'detailed']);
const allowedTemplates = new Set(['warm_minimal']);
const allowedSlideTypes = new Set([
  'cover',
  'project_profile',
  'client_requirements',
  'whole_house_plan',
  'space_solution',
  'product_summary',
  'ending',
]);

function text(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function boolean(value, fallback = true) {
  return value === undefined ? fallback : value === true;
}

function positiveIds(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(Number).filter(value => Number.isSafeInteger(value) && value > 0))];
}

function normalizeSettings(raw, source) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const sections = value.sections && typeof value.sections === 'object' ? value.sections : {};
  const display = value.product_display && typeof value.product_display === 'object'
    ? value.product_display : {};
  const availableSpaces = new Map(source.spaces.map(space => [Number(space.id), space]));
  const requestedSpaces = Array.isArray(value.spaces) ? value.spaces : [];
  const spaces = requestedSpaces.length
    ? requestedSpaces.map(item => {
      const space = availableSpaces.get(Number(item?.space_id));
      if (!space) throw new Error('汇报空间已变化，请刷新后重新选择');
      const productIds = new Set(space.products.map(product => Number(product.id)));
      return {
        space_id: space.id,
        space_name: space.name,
        included: boolean(item.included),
        show_plan: boolean(item.show_plan, space.plan_count > 0),
        show_rendering: boolean(item.show_rendering, space.rendering_count > 0),
        show_products: boolean(item.show_products, space.product_count > 0),
        selected_product_ids: positiveIds(item.selected_product_ids).filter(id => productIds.has(id)),
      };
    })
    : source.spaces.map(space => ({
      space_id: space.id,
      space_name: space.name,
      included: true,
      show_plan: space.plan_count > 0,
      show_rendering: space.rendering_count > 0,
      show_products: space.product_count > 0,
      selected_product_ids: space.products.map(product => Number(product.id)),
    }));
  const title = text(value.title, 120) || `${source.project.project_name}设计方案汇报`;
  return {
    schema_version: 1,
    project_id: source.project.id,
    title,
    audience: text(value.audience, 30) || '业主',
    stage: text(value.stage, 40) || '平面方案汇报',
    detail_level: allowedDetailLevels.has(value.detail_level) ? value.detail_level : 'standard',
    template_id: allowedTemplates.has(value.template_id) ? value.template_id : 'warm_minimal',
    user_instruction: text(value.user_instruction, 1000),
    sections: {
      project_profile: boolean(sections.project_profile),
      client_requirements: boolean(sections.client_requirements),
      whole_house_plan: boolean(sections.whole_house_plan),
      space_solutions: boolean(sections.space_solutions),
      product_summary: boolean(sections.product_summary),
    },
    product_display: {
      show_brand: boolean(display.show_brand),
      show_materials: boolean(display.show_materials),
      show_quantity: boolean(display.show_quantity),
      show_price: display.show_price === true,
    },
    spaces,
  };
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function selectedMaterials(selection, showMaterials) {
  if (!showMaterials) return [];
  return (selection?.materials || []).map(item => ({
    part: text(item.part, 80),
    brand: text(item.live_material?.brand || item.brand, 100),
    series: text(item.live_material?.series || item.series, 100),
    name: text(item.live_material?.name || item.name, 100),
    code: text(item.live_material?.code || item.code, 60),
    swatch_url: item.live_material?.swatch_url || item.swatch_url || '',
  }));
}

async function loadPresentationSource(projectId, options = {}) {
  const connection = options.db || db;
  const [projects] = await connection.query(
    `SELECT id, project_code, project_name, client_name, user_id,
            preparation_stage, project_city, project_address, project_type,
            start_date, current_stage, renovation_method,
            house_area, house_layout, floor_plan_image,
            budget_range, resident_info, lifestyle_notes, style_preference,
            key_spaces, special_needs
     FROM renovation_projects
     WHERE id = ? AND COALESCE(lifecycle_status, 'active') <> 'deleted'
     LIMIT 1`,
    [projectId]
  );
  if (!projects.length) throw new Error('项目不存在');
  const project = projects[0];
  const [spaces] = await connection.query(
    `SELECT id, name, sort_order FROM project_spaces
     WHERE project_id = ? ORDER BY sort_order, id`,
    [projectId]
  );
  const [documents] = await connection.query(
    `SELECT id, category, space_key, title, file_url, preview_url, thumbnail_url,
            preview_type, file_type, mime_type, status, version_no
     FROM project_design_documents
     WHERE project_id = ? AND is_current = 1
       AND status NOT IN ('voided', 'superseded', 'archived')
     ORDER BY created_at, id`,
    [projectId]
  );
  const [renderings] = await connection.query(
    `SELECT image.id, image.space_id, image.image_url, image.is_primary, image.sort_order
     FROM project_space_images image
     JOIN project_spaces space ON space.id = image.space_id
     WHERE space.project_id = ? AND image.image_type = 'rendering'
     ORDER BY image.is_primary DESC, image.sort_order, image.id`,
    [projectId]
  );
  const [productRows] = await connection.query(
    `SELECT item.id, item.space_id, item.quantity, item.unit, item.selected_spec,
            item.selection_details, item.customer_unit_price, item.note,
            COALESCE(merchant.name, personal.name) AS name,
            COALESCE(merchant.brand, personal.brand) AS brand,
            COALESCE(merchant.spec, personal.spec) AS spec,
            COALESCE(merchant.cover_url, personal.cover_url) AS cover_url,
            COALESCE(merchant.product_details, personal.product_details) AS product_details
     FROM project_scheme_products item
     JOIN project_design_schemes scheme ON scheme.id = item.scheme_id AND scheme.version_no = 1
     LEFT JOIN merchant_products merchant ON merchant.id = item.merchant_product_id
     LEFT JOIN personal_products personal ON personal.id = item.personal_product_id
     WHERE item.project_id = ?
     ORDER BY item.space_id, item.sort_order, item.id`,
    [projectId]
  );
  const productBySpace = new Map();
  for (const row of productRows) {
    const selection = parseJson(row.selection_details) || {};
    if (selection.ppt?.included === false) continue;
    const details = readDetails(row.product_details) || {};
    const configuration = (details.configurations || []).find(
      item => String(item.id) === String(selection.configuration_id)
    );
    const item = {
      id: Number(row.id),
      name: row.name || '未命名产品',
      brand: row.brand || '',
      specification: row.spec || row.selected_spec || '',
      configuration: configuration?.name || selection.configuration_name || row.selected_spec || '',
      image_url: configuration?.image_url || row.cover_url || '',
      quantity: Number(row.quantity),
      unit: row.unit || '件',
      customer_unit_price: row.customer_unit_price == null ? null : Number(row.customer_unit_price),
      note: row.note || '',
      selection,
      source_type: 'scheme_product',
      image_role: configuration?.image_url ? `configuration:${selection.configuration_id}` : 'cover',
    };
    if (!productBySpace.has(Number(row.space_id))) productBySpace.set(Number(row.space_id), []);
    productBySpace.get(Number(row.space_id)).push(item);
  }
  const docsBySpace = new Map();
  const wholeHouseDocuments = [];
  const wholeHouseRenderings = [];
  const renderingBySpace = new Map();
  for (const row of documents) {
    const item = {
      id: Number(row.id),
      title: row.title,
      type: row.preview_type === 'pdf' || row.file_type === 'pdf' ? 'pdf' : 'image',
      url: row.preview_url || row.file_url,
      thumbnail_url: row.thumbnail_url || '',
      category: row.category,
      status: row.status,
      version_no: Number(row.version_no || 1),
      source_type: 'design_document',
      original_url: row.file_url,
      original_type: row.file_type,
    };
    if (row.space_key === 'whole_house') {
      (row.category === 'rendering' ? wholeHouseRenderings : wholeHouseDocuments).push(item);
    }
    else {
      const spaceId = Number(row.space_key);
      const target = row.category === 'rendering' ? renderingBySpace : docsBySpace;
      if (!target.has(spaceId)) target.set(spaceId, []);
      target.get(spaceId).push(item);
    }
  }
  if (project.floor_plan_image) {
    wholeHouseDocuments.unshift({
      id: 0,
      title: '原始户型图',
      type: 'image',
      url: project.floor_plan_image,
      thumbnail_url: '',
      category: 'floor_plan',
      status: 'confirmed',
      version_no: 1,
      source_type: 'project_floor_plan',
    });
  }
  for (const row of renderings) {
    if (!renderingBySpace.has(Number(row.space_id))) renderingBySpace.set(Number(row.space_id), []);
    renderingBySpace.get(Number(row.space_id)).push({
      id: Number(row.id), title: '空间效果图', type: 'image', url: row.image_url,
      source_type: 'space_image', is_primary: Boolean(row.is_primary), sort_order: row.sort_order,
    });
  }
  const missingFields = [
    [Number(project.house_area) > 0, '房屋面积'],
    [text(project.house_layout), '户型'],
    [text(project.budget_range), '预算'],
    [text(project.style_preference), '风格偏好'],
    [text(project.resident_info), '居住成员'],
    [wholeHouseDocuments.length > 0, '全屋户型图'],
  ].filter(item => !item[0]).map(item => item[1]);
  const source = {
    schema_version: 1,
    project: {
      id: Number(project.id),
      project_code: project.project_code || `ID ${project.id}`,
      project_name: project.project_name || '装修项目',
      client_name: project.client_name || '',
      owner_joined: project.user_id != null,
      preparation_stage: project.preparation_stage || 'construction',
      house_area: Number(project.house_area || 0),
      house_layout: project.house_layout || '',
      project_city: project.project_city || '',
      project_address: project.project_address || '',
      project_type: project.project_type || '',
      start_date: project.start_date || null,
      current_stage: Number(project.current_stage || 1),
      renovation_method: project.renovation_method || '',
      budget_range: project.budget_range || '',
      resident_info: project.resident_info || '',
      lifestyle_notes: project.lifestyle_notes || '',
      style_preference: project.style_preference || '',
      key_spaces: project.key_spaces || '',
      special_needs: project.special_needs || '',
    },
    missing_fields: missingFields,
    whole_house_documents: wholeHouseDocuments,
    whole_house_renderings: wholeHouseRenderings,
    spaces: spaces.map(space => ({
      id: Number(space.id),
      name: space.name,
      documents: docsBySpace.get(Number(space.id)) || [],
      renderings: renderingBySpace.get(Number(space.id)) || [],
      products: productBySpace.get(Number(space.id)) || [],
    })),
  };
  for (const space of source.spaces) {
    space.plan_count = space.documents.length;
    space.rendering_count = space.renderings.length;
    space.product_count = space.products.length;
  }
  source.counts = {
    design_documents: documents.length,
    whole_house_plans: wholeHouseDocuments.length,
    spaces: source.spaces.length,
    renderings: renderings.length + documents.filter(row => row.category === 'rendering').length,
    products: productRows.length,
  };
  return expandLocalUrlsDeep(
    storageService.signStorageUrisDeep(source),
    text(options.baseUrl, 500).replace(/\/$/, '')
  );
}

function expandLocalUrlsDeep(value, baseUrl) {
  if (!baseUrl) return value;
  if (typeof value === 'string' && value.startsWith('/')) {
    return `${baseUrl}${value.startsWith('/api/') ? '' : '/api'}${value}`;
  }
  if (Array.isArray(value)) return value.map(item => expandLocalUrlsDeep(item, baseUrl));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expandLocalUrlsDeep(item, baseUrl)])
    );
  }
  return value;
}

function modelConfiguration(env = process.env) {
  const baseUrl = text(env.PRESENTATION_AI_BASE_URL, 500).replace(/\/$/, '') || 'https://api.deepseek.com';
  const apiKey = text(env.PRESENTATION_AI_API_KEY, 1000);
  const model = text(env.PRESENTATION_AI_MODEL, 120) || 'deepseek-v4-flash';
  const missing = [
    ifMissing(apiKey, 'PRESENTATION_AI_API_KEY'),
  ].filter(Boolean);
  return {
    configured: missing.length === 0,
    provider: text(env.PRESENTATION_AI_PROVIDER, 80) || 'deepseek',
    base_url: baseUrl,
    model,
    missing,
  };
}

function ifMissing(value, key) { return value ? null : key; }

function sourceForModel(source, settings) {
  const selected = new Map(settings.spaces.filter(item => item.included).map(item => [item.space_id, item]));
  return {
    project: source.project,
    missing_fields: source.missing_fields,
    whole_house_documents: source.whole_house_documents.map(item => ({
      id: item.id, title: item.title, category: item.category, status: item.status,
    })),
    spaces: source.spaces.filter(space => selected.has(space.id)).map(space => {
      const choice = selected.get(space.id);
      const allowedProducts = new Set(choice.selected_product_ids);
      return {
        id: space.id,
        name: space.name,
        documents: choice.show_plan ? space.documents.map(item => ({ id: item.id, title: item.title, category: item.category })) : [],
        renderings: choice.show_rendering ? space.renderings.map(item => ({ id: item.id, title: item.title })) : [],
        products: choice.show_products ? space.products
          .filter(item => !allowedProducts.size || allowedProducts.has(item.id))
          .map(item => ({
            id: item.id,
            name: item.name,
            brand: settings.product_display.show_brand ? item.brand : '',
            specification: item.specification,
            configuration: item.configuration,
            materials: selectedMaterials(item.selection, settings.product_display.show_materials)
              .map(material => [material.part, material.brand, material.series, material.name, material.code].filter(Boolean).join(' · ')),
            quantity: settings.product_display.show_quantity ? `${item.quantity}${item.unit}` : '',
            customer_quote: settings.product_display.show_price && item.selection?.ppt?.show_price === true && item.customer_unit_price != null
              ? item.customer_unit_price : null,
            note: item.note,
          })) : [],
      };
    }),
  };
}

function promptMessages(source, settings) {
  const schema = {
    schema_version: 1,
    title: 'string',
    summary: 'string',
    missing_information: ['string'],
    slides: [{
      id: 'unique-string',
      type: 'cover',
      title: 'string',
      subtitle: 'string',
      space_id: null,
      source_refs: ['existing-source-reference'],
      narrative: 'string',
    }],
  };
  return [
    {
      role: 'system',
      content: '你是装筱窝的住宅设计方案汇报编辑。只能依据输入事实组织逐页目录和简短汇报文字；不得猜测面积、预算、品牌、材质、价格或设计结论。缺失资料放入 missing_information。返回单一 JSON 对象，不要 Markdown。',
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: '生成可供设计师向业主汇报的PPT逐页结构',
        output_example: schema,
        output_rules: {
          slide_type: { type: 'string', allowed_values: [...allowedSlideTypes], instruction: '每页只填写一个枚举字符串，禁止填写数组、中文类型名或自创类型。第一页必须为 cover。' },
          space_id: 'space_solution 页必须填写 source 中真实的空间数字 id；其他页面填写 null。',
          slides: '返回 2 至 80 页，每页 id 必须唯一；示例只展示单页字段形状，不代表页数。',
        },
        settings,
        source: sourceForModel(source, settings),
      }),
    },
  ];
}

function parseModelJson(content) {
  let value = String(content || '').trim();
  value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('大模型返回的目录格式不正确');
  return parsed;
}

function normalizeOutline(raw, source, settings) {
  if (!Array.isArray(raw.slides) || raw.slides.length < 2 || raw.slides.length > 80) {
    throw new Error('大模型返回的页数不正确');
  }
  const spaceIds = new Set(source.spaces.map(space => Number(space.id)));
  const ids = new Set();
  const slides = raw.slides.map((slide, index) => {
    const type = allowedSlideTypes.has(slide?.type) ? slide.type : null;
    if (!type) throw new Error(`第${index + 1}页类型不正确`);
    const id = text(slide.id, 80) || `slide-${index + 1}`;
    if (ids.has(id)) throw new Error('大模型返回了重复页面编号');
    ids.add(id);
    const spaceId = slide.space_id == null ? null : Number(slide.space_id);
    if (type === 'space_solution' && !spaceIds.has(spaceId)) throw new Error('大模型引用了不存在的空间');
    return {
      id,
      type,
      title: text(slide.title, 120) || `第${index + 1}页`,
      subtitle: text(slide.subtitle, 240),
      space_id: type === 'space_solution' ? spaceId : null,
      source_refs: Array.isArray(slide.source_refs) ? slide.source_refs.map(item => text(item, 160)).filter(Boolean).slice(0, 30) : [],
      narrative: text(slide.narrative, 1200),
    };
  });
  if (slides[0].type !== 'cover') throw new Error('汇报目录必须以封面开始');
  return {
    schema_version: 1,
    title: text(raw.title, 120) || settings.title,
    summary: text(raw.summary, 1600),
    missing_information: Array.isArray(raw.missing_information)
      ? raw.missing_information.map(item => text(item, 200)).filter(Boolean).slice(0, 30)
      : source.missing_fields,
    slides,
  };
}

async function generateOutline(source, rawSettings, options = {}) {
  const settings = normalizeSettings(rawSettings, source);
  const env = options.env || process.env;
  const config = modelConfiguration(env);
  if (!config.configured) {
    const error = new Error('方案汇报模型服务尚未配置，请在服务器填写大模型 API 配置');
    error.code = 'PRESENTATION_MODEL_NOT_CONFIGURED';
    error.status = 503;
    error.missing = config.missing;
    throw error;
  }
  const fetchImpl = options.fetch || fetch;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  options.signal?.addEventListener('abort', abortFromParent, { once: true });
  const requestedTimeout = Number(options.timeoutMs ?? env.PRESENTATION_AI_TIMEOUT_MS ?? 90000);
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 90000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const messages = promptMessages(source, settings);
    for (let attempt = 0; attempt < (options.maxAttempts ?? 2); attempt++) {
      await options.beforeRequest?.();
      const response = await fetchImpl(`${config.base_url}${text(env.PRESENTATION_AI_ENDPOINT, 120) || '/chat/completions'}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${text(env.PRESENTATION_AI_API_KEY, 1000)}` },
        body: JSON.stringify({
          model: config.model,
          // Qwen's thinking default can substantially delay a single JSON response.
          ...(config.model.startsWith('qwen3') ? { enable_thinking: false } : {}),
          stream: false,
          messages,
          temperature: 0.2,
          max_tokens: Number(env.PRESENTATION_AI_MAX_OUTPUT_TOKENS || 6000),
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });
      const result = await response.json().catch(error => {
        if (controller.signal.aborted) throw error;
        return {};
      });
      await options.onResponse?.({ model: config.model, usage: result.usage || null, raw_response: result });
      if (!response.ok) {
        const error = new Error(`大模型服务调用失败：${result.error?.message || response.status}`);
        error.status = 502;
        error.code = 'PRESENTATION_MODEL_REQUEST_FAILED';
        throw error;
      }
      const content = result.choices?.[0]?.message?.content;
      try {
        return { settings, outline: normalizeOutline(parseModelJson(content), source, settings) };
      } catch (validationError) {
        if (attempt + 1 >= (options.maxAttempts ?? 2)) throw new Error(`模型目录格式校验失败：${validationError.message}`);
        messages.push(
          { role: 'assistant', content: String(content || '').slice(0, 60000) },
          { role: 'user', content: `上一份 JSON 未通过校验：${validationError.message}。请只修正格式并返回完整 JSON，不要更改输入事实。slides[].type 必须为单个字符串，允许值：${[...allowedSlideTypes].join(', ')}；第一页为 cover，禁止将所有类型作为数组填入 type。` },
        );
      }
    }
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`模型服务在 ${Math.round(timeoutMs / 1000)} 秒内未完成生成（${config.model}），请稍后重试`);
      timeoutError.code = 'PRESENTATION_MODEL_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromParent);
  }
}

function buildRenderPlan(source, rawSettings, rawOutline) {
  const settings = normalizeSettings(rawSettings, source);
  const outline = normalizeOutline(rawOutline, source, settings);
  const selected = new Map(settings.spaces.filter(item => item.included).map(item => [item.space_id, item]));
  const spaces = source.spaces.filter(space => selected.has(space.id)).map(space => {
    const choice = selected.get(space.id);
    const productIds = new Set(choice.selected_product_ids);
    return {
      id: space.id,
      name: space.name,
      summary: outline.slides.find(item => item.type === 'space_solution' && item.space_id === space.id)?.narrative || '',
      documents: choice.show_plan ? space.documents : [],
      renderings: choice.show_rendering ? space.renderings : [],
      products: choice.show_products ? space.products
        .filter(item => !productIds.size || productIds.has(item.id))
        .map(item => ({
          id: item.id,
          name: item.name,
          brand: settings.product_display.show_brand ? item.brand : '',
          specification: item.specification,
          configuration: item.configuration,
          image_url: item.image_url,
          materials: selectedMaterials(item.selection, settings.product_display.show_materials)
            .map(material => [material.part, material.brand, material.series, material.name, material.code].filter(Boolean).join(' · ')),
          quantity: settings.product_display.show_quantity ? `${item.quantity}${item.unit}` : '',
          show_price: settings.product_display.show_price && item.selection?.ppt?.show_price === true,
          customer_quote: item.customer_unit_price == null ? null : item.customer_unit_price * item.quantity,
          note: item.note,
        })) : [],
    };
  });
  return {
    schema_version: 1,
    project: {
      name: source.project.project_name,
      code: source.project.project_code,
      client_name: source.project.client_name || '业主',
      stage: settings.stage,
      owner_status: source.project.owner_joined ? '业主已加入' : '业主未加入',
      house_area: source.project.house_area,
      house_layout: source.project.house_layout,
      project_city: source.project.project_city,
      project_address: source.project.project_address,
      project_type: source.project.project_type,
      start_date: source.project.start_date,
      current_stage: source.project.current_stage,
      renovation_method: source.project.renovation_method,
      budget_range: source.project.budget_range,
      resident_info: source.project.resident_info,
      lifestyle_notes: source.project.lifestyle_notes,
      style_preference: source.project.style_preference,
      key_spaces: source.project.key_spaces,
      special_needs: source.project.special_needs,
    },
    presentation: {
      title: outline.title || settings.title,
      subtitle: `${settings.stage} · 面向${settings.audience}`,
      summary: outline.summary,
      missing_information: outline.missing_information,
      template_id: settings.template_id,
    },
    whole_house_documents: settings.sections.whole_house_plan ? source.whole_house_documents : [],
    whole_house_renderings: settings.sections.whole_house_plan ? (source.whole_house_renderings || []) : [],
    spaces,
    outline: outline.slides,
  };
}

module.exports = {
  normalizeSettings,
  loadPresentationSource,
  modelConfiguration,
  sourceForModel,
  normalizeOutline,
  generateOutline,
  buildRenderPlan,
};
