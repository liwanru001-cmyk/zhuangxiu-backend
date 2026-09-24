'use strict';

const crypto = require('crypto');
const db = require('../config/db');
const presentation = require('./project-presentation.service');
const { candidates } = require('./presentation-v2/assets');
const storage = require('./storage.service');
const { buildPagePlan, validatePagePlan } = require('./presentation-page-plan');

const layoutByType = Object.freeze({
  cover: 'cover_01',
  project_profile: 'project_profile_01',
  client_requirements: 'client_requirements_01',
  whole_house_plan: 'plan_gallery_01',
  space_design: 'space_hero_01',
  product_selection: 'product_grid_01',
  ending: 'ending_01',
});

function idPart(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function buildAssetManifest(source, settings) {
  const seen = new Map();
  const manifest = candidates(source, settings).map(asset => {
    const base = [asset.source_type, asset.source_id, asset.image_role, `v${asset.version_no}`].map(idPart).join(':');
    const count = (seen.get(base) || 0) + 1;
    seen.set(base, count);
    return {
      asset_id: count === 1 ? base : `${base}:${count}`,
      source_type: asset.source_type,
      source_id: asset.source_id,
      image_role: asset.image_role,
      space_id: asset.space_id,
      title: asset.title,
      category: asset.category,
      url: asset.type === 'pdf' && asset.legacy_url === asset.url
        ? null
        : storage.canonicalStorageUri(
          asset.type === 'pdf' ? asset.legacy_url : asset.url
        ),
      media_type: asset.type,
    };
  });
  const existing = new Set(manifest.map(asset => `${asset.source_type}:${asset.source_id}:${asset.url}`));
  for (const choice of settings.spaces.filter(item => item.included && item.show_products)) {
    const space = source.spaces.find(item => Number(item.id) === Number(choice.space_id));
    if (!space) continue;
    const allowed = new Set(choice.selected_product_ids.map(Number));
    for (const product of space.products.filter(item => !allowed.size || allowed.has(Number(item.id)))) {
      for (const [index, rawUrl] of (product.image_urls || []).entries()) {
        const url = storage.canonicalStorageUri(rawUrl);
        const identity = `scheme_product:${product.id}:${url}`;
        if (!url || existing.has(identity)) continue;
        existing.add(identity);
        manifest.push({
          asset_id: `scheme_product:${idPart(product.id)}:gallery-${index + 1}:v1`,
          source_type: 'scheme_product',
          source_id: product.id,
          image_role: `gallery:${index + 1}`,
          space_id: space.id,
          title: `${product.name} · 图片${index + 1}`,
          category: 'product',
          url,
          media_type: 'image',
        });
      }
    }
  }
  return manifest;
}

function documentSpaces(source, settings) {
  const selected = new Map(settings.spaces.filter(item => item.included).map(item => [Number(item.space_id), item]));
  return source.spaces.filter(space => selected.has(Number(space.id))).map(space => {
    const choice = selected.get(Number(space.id));
    const allowed = new Set(choice.selected_product_ids.map(Number));
    return {
      id: space.id,
      name: space.name,
      design_description: space.design_description || '',
      products: choice.show_products ? space.products
        .filter(product => !allowed.size || allowed.has(Number(product.id)))
        .map(product => ({
          id: product.id,
          name: product.name,
          brand: product.brand,
          description: product.description,
          specification: product.specification,
          configuration: product.configuration,
          dimensions: product.dimensions,
          dimension_unit: product.dimension_unit,
          dimension_note: product.dimension_note,
          materials: product.materials,
          colors: product.colors,
          quantity: `${product.quantity}${product.unit}`,
          customer_quote: product.selection?.ppt?.show_price === true && product.customer_unit_price != null
            ? product.customer_unit_price : null,
          note: product.note,
          official_url: product.official_url,
          public_product_id: product.public_product_id,
        })) : [],
    };
  });
}

function buildDocument(source, rawSettings) {
  const settings = presentation.normalizeSettings(rawSettings, source);
  const assets = buildAssetManifest(source, settings);
  const sourceForModel = presentation.sourceForModel(source, settings);
  const slides = [];
  const add = (type, values = {}) => slides.push({
    id: `${type}-${slides.length + 1}`,
    type,
    layout: layoutByType[type],
    ...values,
  });
  const matchingAssets = (spaceId, role) => assets
    .filter(asset => String(asset.space_id) === String(spaceId) && asset.image_role === role)
    .map(asset => asset.asset_id);

  add('cover', {
    title: settings.title,
    subtitle: settings.stage,
    asset_ids: matchingAssets('whole_house', 'rendering').slice(0, 1),
  });
  if (settings.sections.project_profile) add('project_profile', {
    title: '项目概况',
    project: sourceForModel.project,
  });
  if (settings.sections.client_requirements) add('client_requirements', {
    title: '客户需求',
    facts: {
      resident_info: source.project.resident_info || '',
      lifestyle_notes: source.project.lifestyle_notes || '',
      style_preference: source.project.style_preference || '',
      key_spaces: source.project.key_spaces || '',
      special_needs: source.project.special_needs || '',
    },
    missing_fields: source.missing_fields,
  });
  if (settings.sections.whole_house_plan) {
    const assetIds = matchingAssets('whole_house', 'plan');
    if (assetIds.length) add('whole_house_plan', {
      title: '全屋方案',
      asset_ids: assetIds,
    });
  }
  for (const choice of settings.spaces.filter(space => space.included)) {
    const space = source.spaces.find(item => Number(item.id) === Number(choice.space_id));
    if (!space) continue;
    if (settings.sections.space_solutions) {
      const renderingIds = choice.show_rendering ? matchingAssets(space.id, 'rendering') : [];
      const planIds = choice.show_plan ? matchingAssets(space.id, 'plan') : [];
      if (renderingIds.length || planIds.length || space.design_description) add('space_design', {
        space_id: String(space.id),
        title: `${space.name}设计`,
        rendering_asset_ids: renderingIds,
        plan_asset_ids: planIds,
        description: space.design_description || '',
      });
    }
    if ((settings.sections.product_summary || settings.sections.space_solutions) && choice.show_products) {
      const allowed = new Set(choice.selected_product_ids);
      const productIds = space.products
        .filter(product => !allowed.size || allowed.has(product.id))
        .map(product => String(product.id));
      if (productIds.length) add('product_selection', {
        space_id: String(space.id),
        title: `${space.name}产品选用`,
        product_ids: productIds,
      });
    }
  }
  add('ending', { title: '汇报结束' });
  return {
    schema_version: 1,
    kind: 'presentation_document',
    presentation: {
      title: settings.title,
      audience: settings.audience,
      stage: settings.stage,
      project_id: source.project.id,
    },
    settings,
    project: sourceForModel.project,
    spaces: documentSpaces(source, settings),
    asset_manifest: assets,
    slides,
  };
}

async function save(projectId, userId, rawSettings, options = {}) {
  const source = await presentation.loadPresentationSource(projectId, options);
  const document = buildDocument(source, rawSettings);
  const pagePlan = buildPagePlan(document);
  const id = crypto.randomUUID();
  await (options.db || db).query(
    `INSERT INTO project_presentation_documents
       (id, project_id, created_by, title, settings_json, document_json, page_plan_json, page_plan_updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, projectId, userId, document.presentation.title,
      JSON.stringify(document.settings), JSON.stringify(document), JSON.stringify(pagePlan), userId]
  );
  return { id, document, page_plan: pagePlan };
}

function parseJson(value) {
  if (typeof value !== 'string') return value || null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function upgradePagePlan(document, current) {
  if (!current || Number(current.schema_version || 1) >= 2) return current;
  const rebuilt = buildPagePlan(document);
  rebuilt.theme_id = current.theme_id || rebuilt.theme_id;
  rebuilt.display = { ...rebuilt.display, ...(current.display || {}) };
  const previous = new Map((current.pages || [])
    .filter(page => page.type !== 'space_story')
    .map(page => [String(page.page_id), page]));
  rebuilt.pages = rebuilt.pages.map(page => {
    const prior = previous.get(String(page.page_id));
    if (!prior) return page;
    return {
      ...page,
      hidden: prior.hidden === true,
      ...(prior.title_override ? { title_override: prior.title_override } : {}),
    };
  });
  return validatePagePlan(rebuilt, document);
}

async function enrichPublicProductIds(projectId, document, database) {
  const products = (document?.spaces || []).flatMap(space => space.products || []);
  const missing = products
    .filter(product => product.public_product_id == null)
    .map(product => Number(product.id))
    .filter(Number.isSafeInteger);
  if (!missing.length) return false;
  const [rows] = await database.query(
    `SELECT id, public_product_id FROM project_scheme_products
     WHERE project_id = ? AND id IN (?) AND public_product_id IS NOT NULL`,
    [projectId, missing]
  );
  const publicIds = new Map(rows.map(row => [Number(row.id), Number(row.public_product_id)]));
  let changed = false;
  for (const product of products) {
    const publicProductId = publicIds.get(Number(product.id));
    if (!publicProductId) continue;
    product.public_product_id = publicProductId;
    changed = true;
  }
  return changed;
}

async function find(projectId, documentId, database = db) {
  const [rows] = await database.query(
    `SELECT id, project_id, created_by, title, document_json, page_plan_json,
            page_plan_version, page_plan_updated_by, created_at, updated_at
     FROM project_presentation_documents WHERE project_id = ? AND id = ? LIMIT 1`,
    [projectId, documentId]
  );
  const row = rows[0];
  if (!row) return null;
  const document = parseJson(row.document_json);
  if (document && await enrichPublicProductIds(projectId, document, database)) {
    await database.query(
      `UPDATE project_presentation_documents SET document_json = ?
       WHERE project_id = ? AND id = ?`,
      [JSON.stringify(document), projectId, documentId]
    );
  }
  let pagePlan = parseJson(row.page_plan_json);
  let pagePlanVersion = Number(row.page_plan_version || 1);
  if (!pagePlan && document) {
    pagePlan = buildPagePlan(document);
    await database.query(
      `UPDATE project_presentation_documents
       SET page_plan_json = ?, page_plan_version = 1
       WHERE project_id = ? AND id = ? AND page_plan_json IS NULL`,
      [JSON.stringify(pagePlan), projectId, documentId]
    );
  } else if (document && Number(pagePlan.schema_version || 1) < 2) {
    pagePlan = upgradePagePlan(document, pagePlan);
    pagePlanVersion += 1;
    await database.query(
      `UPDATE project_presentation_documents
       SET page_plan_json = ?, page_plan_version = page_plan_version + 1
       WHERE project_id = ? AND id = ?`,
      [JSON.stringify(pagePlan), projectId, documentId]
    );
  }
  return {
    id: row.id,
    project_id: row.project_id,
    created_by: row.created_by,
    title: row.title,
    document,
    page_plan: pagePlan,
    page_plan_version: pagePlanVersion,
    page_plan_updated_by: row.page_plan_updated_by == null ? null : Number(row.page_plan_updated_by),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function updatePagePlan(projectId, documentId, userId, rawPagePlan, database = db) {
  const current = await find(projectId, documentId, database);
  if (!current) return null;
  const pagePlan = validatePagePlan(rawPagePlan, current.document);
  await database.query(
    `UPDATE project_presentation_documents
     SET page_plan_json = ?, page_plan_version = page_plan_version + 1,
         page_plan_updated_by = ?
     WHERE project_id = ? AND id = ?`,
    [JSON.stringify(pagePlan), userId, projectId, documentId]
  );
  return { page_plan: pagePlan, page_plan_version: current.page_plan_version + 1 };
}

async function list(projectId, database = db) {
  const [rows] = await database.query(
    `SELECT id, project_id, created_by, title, created_at, updated_at
     FROM project_presentation_documents WHERE project_id = ?
     ORDER BY created_at DESC, id DESC LIMIT 100`,
    [projectId]
  );
  return rows;
}

async function remove(projectId, documentId, database = db) {
  const [result] = await database.query(
    `DELETE FROM project_presentation_documents
     WHERE project_id = ? AND id = ?`,
    [projectId, documentId]
  );
  return Number(result.affectedRows || 0) > 0;
}

module.exports = { buildAssetManifest, buildDocument, buildPagePlan, validatePagePlan, save, find, updatePagePlan, list, remove };
