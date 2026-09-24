'use strict';

const pageLayouts = Object.freeze({
  cover: ['cover_hero_01'],
  project_profile: ['project_overview_01'],
  client_requirements: ['brief_editorial_01'],
  whole_house_plan: ['plan_gallery_01'],
  chapter: ['chapter_hero_01'],
  space_hero: ['space_hero_full_bleed_01'],
  space_story: ['space_story_01'],
  moodboard: ['moodboard_01'],
  product_feature: ['product_feature_01'],
  product_duo: ['product_duo_01'],
  product_grid: ['product_grid_01'],
  end: ['end_01'],
});

const themeIds = Object.freeze([
  'modern_minimal', 'wabi_sabi', 'italian_luxury', 'modern_chinese',
  'scandinavian', 'french_classic', 'industrial', 'natural_resort',
]);

function idPart(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function page(sourceSlide, type, layout, suffix, values = {}) {
  return {
    page_id: `page-${idPart(sourceSlide.id)}-${idPart(suffix)}`,
    source_slide_id: sourceSlide.id,
    type,
    layout,
    hidden: false,
    ...values,
  };
}

function productPages(slide) {
  const ids = Array.isArray(slide.product_ids) ? slide.product_ids.map(String) : [];
  if (ids.length === 1) return [page(slide, 'product_feature', 'product_feature_01', 'product-1', {
    space_id: String(slide.space_id), product_ids: ids,
  })];
  if (ids.length === 2) return [page(slide, 'product_duo', 'product_duo_01', 'products-1-2', {
    space_id: String(slide.space_id), product_ids: ids,
  })];
  const result = [];
  for (let index = 0; index < ids.length; index += 6) {
    result.push(page(slide, 'product_grid', 'product_grid_01', `products-${index + 1}-${Math.min(ids.length, index + 6)}`, {
      space_id: String(slide.space_id), product_ids: ids.slice(index, index + 6),
    }));
  }
  return result;
}

function descriptionRanges(value, maxLength = 420) {
  const text = String(value || '');
  if (!text) return [];
  const ranges = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + maxLength);
    if (end < text.length) {
      const candidate = text.slice(start, end);
      const boundary = Math.max(
        candidate.lastIndexOf('\n'), candidate.lastIndexOf('。'),
        candidate.lastIndexOf('；'), candidate.lastIndexOf('！'), candidate.lastIndexOf('？')
      );
      if (boundary >= Math.floor(maxLength * 0.55)) end = start + boundary + 1;
    }
    ranges.push([start, end]);
    start = end;
    while (start < text.length && /\s/.test(text[start])) start += 1;
  }
  return ranges;
}

function buildPagePlan(document) {
  const pages = [];
  const assets = new Map((document.asset_manifest || []).map(asset => [asset.asset_id, asset]));
  const spaceNames = new Map((document.spaces || []).map(space => [String(space.id), space.name]));
  const sectionSpaces = new Set();
  const ensureSection = slide => {
    const spaceId = String(slide.space_id || '');
    if (!spaceId || sectionSpaces.has(spaceId)) return;
    sectionSpaces.add(spaceId);
    pages.push(page(slide, 'chapter', 'chapter_hero_01', 'chapter', {
      space_id: spaceId,
      title_override: spaceNames.get(spaceId) || slide.title || '',
    }));
  };

  for (const slide of document.slides || []) {
    if (slide.type === 'cover') {
      const coverAssets = (slide.asset_ids || []).filter(id => assets.has(id));
      const fallback = [...assets.values()].find(asset => asset.image_role === 'rendering' && asset.url);
      pages.push(page(slide, 'cover', 'cover_hero_01', 'cover', {
        asset_ids: (coverAssets.length ? coverAssets : fallback ? [fallback.asset_id] : []).slice(0, 1),
      }));
    } else if (slide.type === 'project_profile') {
      pages.push(page(slide, 'project_profile', 'project_overview_01', 'profile'));
    } else if (slide.type === 'client_requirements') {
      pages.push(page(slide, 'client_requirements', 'brief_editorial_01', 'brief'));
    } else if (slide.type === 'whole_house_plan') {
      pages.push(page(slide, 'whole_house_plan', 'plan_gallery_01', 'plans', {
        asset_ids: (slide.asset_ids || []).slice(0, 4),
      }));
    } else if (slide.type === 'space_design') {
      ensureSection(slide);
      const renderingIds = (slide.rendering_asset_ids || []).filter(id => assets.has(id));
      renderingIds.forEach((assetId, index) => pages.push(page(
        slide, 'space_hero', 'space_hero_full_bleed_01', `hero-${index + 1}`,
        { space_id: String(slide.space_id), asset_ids: [assetId] }
      )));
      const planIds = (slide.plan_asset_ids || []).filter(id => assets.has(id));
      const architectural = planIds.filter(id => ['layout_plan', 'floor_plan'].includes(String(assets.get(id)?.category || '')));
      const materials = planIds.filter(id => !architectural.includes(id));
      const narrativeRanges = descriptionRanges(slide.description);
      if (narrativeRanges.length) narrativeRanges.forEach((range, index) => pages.push(page(
        slide, 'space_story', 'space_story_01', `story-${index + 1}`,
        {
          space_id: String(slide.space_id),
          asset_ids: architectural.slice(0, 2),
          description_range: range,
        }
      )));
      else if (architectural.length) pages.push(page(
        slide, 'space_story', 'space_story_01', 'story',
        { space_id: String(slide.space_id), asset_ids: architectural.slice(0, 2) }
      ));
      if (materials.length) pages.push(page(
        slide, 'moodboard', 'moodboard_01', 'materials',
        { space_id: String(slide.space_id), asset_ids: materials.slice(0, 6) }
      ));
    } else if (slide.type === 'product_selection') {
      ensureSection(slide);
      const materialIds = [...assets.values()]
        .filter(asset => String(asset.space_id) === String(slide.space_id) && asset.source_type === 'scheme_product_material')
        .map(asset => asset.asset_id)
        .slice(0, 6);
      if (materialIds.length) pages.push(page(
        slide, 'moodboard', 'moodboard_01', 'product-materials',
        { space_id: String(slide.space_id), asset_ids: materialIds }
      ));
      pages.push(...productPages(slide));
    } else if (slide.type === 'ending') {
      pages.push(page(slide, 'end', 'end_01', 'end'));
    }
  }

  pages.forEach((item, index) => { item.order = index + 1; });
  return {
    schema_version: 1,
    kind: 'presentation_page_plan',
    document_schema_version: Number(document.schema_version || 1),
    theme_id: themeIds.includes(document.settings?.template_id)
      ? document.settings.template_id : 'modern_minimal',
    display: {
      show_brand: document.settings?.product_display?.show_brand !== false,
      show_price: document.settings?.product_display?.show_price === true,
      show_dimensions: true,
    },
    pages,
  };
}

function normalizeBoolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function validatePagePlan(raw, document) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('页面编排格式不正确');
  if (!Array.isArray(raw.pages) || !raw.pages.length || raw.pages.length > 300) throw new Error('页面编排必须包含1至300页');
  const slideIds = new Set((document.slides || []).map(slide => String(slide.id)));
  const assetIds = new Set((document.asset_manifest || []).map(asset => String(asset.asset_id)));
  const products = new Set((document.spaces || []).flatMap(space => (space.products || []).map(product => String(product.id))));
  const spaces = new Set((document.spaces || []).map(space => String(space.id)));
  const ids = new Set();
  const orderedInput = raw.pages.map((item, originalIndex) => ({ item, originalIndex })).sort((a, b) => {
    const left = Number(a.item?.order);
    const right = Number(b.item?.order);
    return (Number.isFinite(left) ? left : a.originalIndex + 1) -
      (Number.isFinite(right) ? right : b.originalIndex + 1) || a.originalIndex - b.originalIndex;
  });
  const pages = orderedInput.map(({ item }, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`第${index + 1}页格式不正确`);
    const pageId = String(item.page_id || '').trim();
    const type = String(item.type || '').trim();
    const layout = String(item.layout || '').trim();
    const sourceSlideId = String(item.source_slide_id || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(pageId) || ids.has(pageId)) throw new Error('页面标识重复或格式不正确');
    ids.add(pageId);
    if (!pageLayouts[type]?.includes(layout)) throw new Error(`页面版式不受支持：${type}/${layout}`);
    if (!slideIds.has(sourceSlideId)) throw new Error('页面引用的内容已不存在');
    const spaceId = item.space_id == null || item.space_id === '' ? null : String(item.space_id);
    if (spaceId && !spaces.has(spaceId)) throw new Error('页面引用的空间已不存在');
    const referencedAssets = [...new Set((Array.isArray(item.asset_ids) ? item.asset_ids : []).map(String))];
    const referencedProducts = [...new Set((Array.isArray(item.product_ids) ? item.product_ids : []).map(String))];
    if (referencedAssets.some(id => !assetIds.has(id))) throw new Error('页面引用的素材已不存在');
    if (referencedProducts.some(id => !products.has(id))) throw new Error('页面引用的产品已不存在');
    const title = item.title_override == null ? '' : String(item.title_override).trim();
    if (title.length > 160) throw new Error('页面标题过长');
    let descriptionRange = null;
    if (item.description_range != null) {
      if (type !== 'space_story' || !Array.isArray(item.description_range)
          || item.description_range.length !== 2) throw new Error('方案说明分页范围不正确');
      const start = Number(item.description_range[0]);
      const end = Number(item.description_range[1]);
      const slide = (document.slides || []).find(value => String(value.id) === sourceSlideId);
      const length = String(slide?.description || '').length;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
          || start < 0 || end <= start || end > length) throw new Error('方案说明分页范围不正确');
      descriptionRange = [start, end];
    }
    return {
      page_id: pageId,
      source_slide_id: sourceSlideId,
      type,
      layout,
      hidden: item.hidden === true,
      order: index + 1,
      ...(spaceId ? { space_id: spaceId } : {}),
      ...(referencedAssets.length ? { asset_ids: referencedAssets } : {}),
      ...(referencedProducts.length ? { product_ids: referencedProducts } : {}),
      ...(title ? { title_override: title } : {}),
      ...(descriptionRange ? { description_range: descriptionRange } : {}),
    };
  });
  if (pages.every(item => item.hidden)) throw new Error('至少保留一页用于汇报');
  return {
    schema_version: 1,
    kind: 'presentation_page_plan',
    document_schema_version: Number(document.schema_version || 1),
    theme_id: themeIds.includes(raw.theme_id) ? raw.theme_id : 'modern_minimal',
    display: {
      show_brand: normalizeBoolean(raw.display?.show_brand, true),
      show_price: normalizeBoolean(raw.display?.show_price, false),
      show_dimensions: normalizeBoolean(raw.display?.show_dimensions, true),
    },
    pages,
  };
}

function buildPptContent(document, pagePlan, preparedManifest) {
  const stableAssets = new Map((document.asset_manifest || []).map(asset => [String(asset.asset_id), asset]));
  const preparedByIdentity = new Map((preparedManifest || []).map(asset => [
    `${asset.source_type}:${asset.source_id}:${asset.image_role}`,
    asset.asset_id,
  ]));
  const mapAssetId = stableId => {
    const asset = stableAssets.get(String(stableId));
    const mapped = asset && preparedByIdentity.get(`${asset.source_type}:${asset.source_id}:${asset.image_role}`);
    if (!mapped) {
      throw Object.assign(new Error('页面编排引用的素材无法用于 PPT'), {
        code: 'asset_mapping_error', fatal: true,
      });
    }
    return mapped;
  };
  const pages = (pagePlan.pages || [])
    .filter(item => item.hidden !== true)
    .sort((a, b) => Number(a.order) - Number(b.order))
    .map((item, index) => ({
      page_id: item.page_id,
      order: index + 1,
      type: item.type,
      layout: item.layout,
      source_slide_id: item.source_slide_id,
      ...(item.space_id ? { space_id: String(item.space_id) } : {}),
      ...(item.title_override ? { title_override: item.title_override } : {}),
      ...(item.product_ids?.length ? { product_ids: item.product_ids.map(String) } : {}),
      ...(item.asset_ids?.length ? { asset_ids: item.asset_ids.map(mapAssetId) } : {}),
    }));
  return {
    presentation_document: {
      schema_version: Number(document.schema_version || 1),
      kind: document.kind,
      presentation: document.presentation,
      project: document.project,
      spaces: document.spaces,
      slides: document.slides,
    },
    page_plan: {
      schema_version: Number(pagePlan.schema_version || 1),
      kind: pagePlan.kind,
      theme_id: themeIds.includes(pagePlan.theme_id) ? pagePlan.theme_id : 'modern_minimal',
      display: pagePlan.display,
      pages,
    },
  };
}

module.exports = { pageLayouts, themeIds, buildPagePlan, validatePagePlan, buildPptContent };
