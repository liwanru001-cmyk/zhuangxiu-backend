const db = require('../config/db');
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const { success, error } = require('../utils/response');
const {
  hasActiveVerifiedMerchant,
  activeVerifiedMerchantExistsSql,
} = require('../utils/verified-merchant');

const TAG_TYPES = new Set(['space', 'style']);
const CITY_OPTIONS_BY_PROVINCE = {
  全国: ['全国'],
  北京市: ['北京市'],
  天津市: ['天津市'],
  上海市: ['上海市'],
  重庆市: ['重庆市'],
  河北省: ['石家庄市', '唐山市', '秦皇岛市', '邯郸市', '保定市', '廊坊市'],
  山西省: ['太原市', '大同市', '长治市', '晋中市'],
  内蒙古自治区: ['呼和浩特市', '包头市', '鄂尔多斯市', '赤峰市'],
  辽宁省: ['沈阳市', '大连市', '鞍山市', '锦州市'],
  吉林省: ['长春市', '吉林市'],
  黑龙江省: ['哈尔滨市', '齐齐哈尔市', '大庆市'],
  江苏省: ['南京市', '苏州市', '无锡市', '常州市', '南通市', '扬州市', '徐州市'],
  浙江省: ['杭州市', '宁波市', '温州市', '嘉兴市', '绍兴市', '金华市'],
  安徽省: ['合肥市', '芜湖市', '蚌埠市', '阜阳市'],
  福建省: ['福州市', '厦门市', '泉州市', '漳州市'],
  江西省: ['南昌市', '赣州市', '九江市', '上饶市'],
  山东省: ['济南市', '青岛市', '烟台市', '潍坊市', '临沂市', '济宁市'],
  河南省: ['郑州市', '洛阳市', '南阳市', '许昌市'],
  湖北省: ['武汉市', '宜昌市', '襄阳市', '荆州市'],
  湖南省: ['长沙市', '株洲市', '湘潭市', '岳阳市', '衡阳市'],
  广东省: ['广州市', '深圳市', '佛山市', '东莞市', '珠海市', '惠州市', '中山市'],
  广西壮族自治区: ['南宁市', '柳州市', '桂林市'],
  海南省: ['海口市', '三亚市'],
  四川省: ['成都市', '绵阳市', '德阳市', '乐山市', '南充市'],
  贵州省: ['贵阳市', '遵义市'],
  云南省: ['昆明市', '大理市', '丽江市'],
  西藏自治区: ['拉萨市'],
  陕西省: ['西安市', '咸阳市', '宝鸡市'],
  甘肃省: ['兰州市', '天水市'],
  青海省: ['西宁市'],
  宁夏回族自治区: ['银川市'],
  新疆维吾尔自治区: ['乌鲁木齐市', '克拉玛依市'],
};
const CITY_OPTIONS = new Set(Object.entries(CITY_OPTIONS_BY_PROVINCE).flatMap(([province, cities]) => (
  province === '全国' ? ['全国'] : cities.map((city) => `${province} / ${city}`)
)));
const AREA_OPTIONS = new Set(['60㎡以下', '60-90㎡', '90-120㎡', '120-150㎡', '150㎡以上']);
const SPACE_TAGS = new Set(['客厅', '厨房', '卫生间', '阳台', '卧室', '全屋']);
const STYLE_TAGS = new Set(['奶油', '原木', '极简', '新中式', '现代', '法式']);
const CASE_LIMITS = {
  maxCases: 80,
  maxImages: 12,
  maxItems: 30,
  maxSummaryLength: 300,
  maxContentTextLength: 1500,
  maxContentImages: 15,
  maxContentImageWidth: 1080,
  maxGifBytes: 300 * 1024,
};

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function normalizeString(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeCaseLink(value) {
  const link = normalizeString(value, 1000);
  if (!link) return '';
  try {
    const parsed = new URL(link);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function normalizeImages(value) {
  return parseJsonArray(value)
    .map((item) => normalizeString(item, 500))
    .filter(Boolean)
    .slice(0, CASE_LIMITS.maxImages);
}

function normalizeContentDelta(value) {
  const source = parseJsonArray(value);
  const operations = [];
  let imageCount = 0;
  let consecutiveNewlines = 0;
  const allowedInlineAttributes = new Set(['bold', 'italic', 'underline', 'strike', 'color', 'background']);
  const allowedBlockAttributes = new Set(['header', 'list', 'blockquote', 'align', 'indent', 'direction']);
  for (const operation of source) {
    if (!operation || typeof operation !== 'object' || !('insert' in operation)) continue;
    const insert = operation.insert;
    const rawAttributes = operation.attributes && typeof operation.attributes === 'object'
      ? operation.attributes
      : {};
    if (typeof insert === 'string') {
      const sourceText = insert
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n');
      let text = '';
      for (const character of sourceText) {
        if (character === '\n') {
          consecutiveNewlines += 1;
          if (consecutiveNewlines <= 3) text += character;
        } else {
          consecutiveNewlines = 0;
          text += character;
        }
      }
      if (!text) continue;
      const attributes = {};
      for (const [key, attributeValue] of Object.entries(rawAttributes)) {
        if (allowedInlineAttributes.has(key) || allowedBlockAttributes.has(key)) {
          attributes[key] = attributeValue;
        }
      }
      operations.push(Object.keys(attributes).length ? { insert: text, attributes } : { insert: text });
      continue;
    }
    if (insert && typeof insert === 'object' && typeof insert.image === 'string') {
      const url = normalizeString(insert.image, 500);
      if (!url) continue;
      imageCount += 1;
      if (imageCount > CASE_LIMITS.maxContentImages) {
        return { error: `图文详情配图最多 ${CASE_LIMITS.maxContentImages} 张` };
      }
      operations.push({ insert: { image: url } });
      consecutiveNewlines = 0;
    }
  }
  const textLength = [...operations
    .filter((operation) => typeof operation.insert === 'string')
    .map((operation) => operation.insert)
    .join('')
    .trim()].length;
  if (textLength > CASE_LIMITS.maxContentTextLength) {
    return { error: `图文详情文字最多 ${CASE_LIMITS.maxContentTextLength} 字` };
  }
  if (!operations.length) return { value: [] };
  const last = operations[operations.length - 1];
  if (typeof last.insert !== 'string' || !last.insert.endsWith('\n')) {
    operations.push({ insert: '\n' });
  }
  return { value: operations };
}

function normalizeTags(tags) {
  const source = tags && typeof tags === 'object' ? tags : {};
  const space = parseJsonArray(source.space).map((item) => normalizeString(item, 40)).find((item) => item);
  const style = parseJsonArray(source.style).map((item) => normalizeString(item, 40)).find((item) => item);
  if (space && !SPACE_TAGS.has(space)) return { error: '空间标签不正确' };
  if (style && !STYLE_TAGS.has(style)) return { error: '风格标签不正确' };
  return {
    value: {
      space: space ? [space] : [],
      style: style ? [style] : [],
    },
  };
}

async function normalizeItems(items, merchantId) {
  const normalized = parseJsonArray(items)
    .map((item) => (item && typeof item === 'object' ? item : {}))
    .map((item) => ({
      product_id: Number(item.product_id || item.productId || 0) || 0,
      product_name: normalizeString(item.product_name || item.productName, 160),
      brand: normalizeString(item.brand, 120),
      model: normalizeString(item.model, 120),
      specification: normalizeString(item.specification, 200),
      color: normalizeString(item.color, 80),
      quantity: normalizeString(item.quantity, 80),
      remark: normalizeString(item.remark, 300),
      sort_order: Number(item.sort_order || item.sortOrder || 0) || 0,
    }))
    .filter((item) => item.product_id > 0)
    .slice(0, CASE_LIMITS.maxItems);
  if (!normalized.length) return [];
  const productIds = [...new Set(normalized.map((item) => item.product_id))];
  const [rows] = await db.query(
    `SELECT id, name, brand, spec
     FROM merchant_products
     WHERE merchant_user_id = ? AND id IN (?) AND status = 'active'`,
    [merchantId, productIds]
  );
  const products = new Map(rows.map((row) => [Number(row.id), row]));
  if (products.size !== productIds.length) {
    const err = new Error('使用产品必须来自当前店铺已发布产品');
    err.statusCode = 400;
    throw err;
  }
  return normalized.map((item, index) => {
    const product = products.get(item.product_id);
    return {
      ...item,
      product_name: product.name || item.product_name,
      brand: product.brand || item.brand,
      model: product.spec || item.model,
      sort_order: index,
    };
  });
}

function mapCase(row, tags = [], items = []) {
  const groupedTags = { space: [], style: [] };
  for (const tag of tags) {
    if (!groupedTags[tag.tag_type]) groupedTags[tag.tag_type] = [];
    groupedTags[tag.tag_type].push(tag.tag_value || '');
  }
  return {
    id: Number(row.id),
    merchant_id: Number(row.merchant_id),
    title: row.title || '',
    cover_image: row.cover_image || '',
    images: normalizeImages(row.images),
    description: row.description || '',
    content_delta: normalizeContentDelta(row.content_delta).value || [],
    area_range: row.area_range || '',
    budget_range: row.budget_range || '',
    link_title: row.link_title || '',
    link_url: row.link_url || '',
    city: row.city || '',
    status: row.status || 'draft',
    sort_order: Number(row.sort_order || 0),
    view_count: Number(row.view_count || 0),
    tags: groupedTags,
    items: items.map((item) => ({
      id: Number(item.id || 0),
      product_id: Number(item.product_id || 0),
      product_name: item.product_name || '',
      brand: item.brand || '',
      model: item.model || '',
      specification: item.specification || '',
      color: item.color || '',
      quantity: item.quantity || '',
      remark: item.remark || '',
      sort_order: Number(item.sort_order || 0),
    })),
    merchant: row.merchant_name || row.merchant_logo_url || row.merchant_intro || row.consultation_enabled !== undefined
      ? {
        id: Number(row.merchant_id),
        shop_name: row.merchant_name || '',
        logo_url: row.merchant_logo_url || '',
        brand_intro: row.merchant_intro || '',
        service_area: row.merchant_service_area || '',
        consultation_enabled:
          row.consultation_enabled === 1 ||
          row.consultation_enabled === true ||
          row.consultation_enabled === '1',
      }
      : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function assertMerchant(req, res) {
  if (!(await hasActiveVerifiedMerchant(req.user.id))) {
    error(res, '未成为入驻商家，暂不能管理案例', 403);
    return false;
  }
  return true;
}

async function getCaseRows(caseIds) {
  if (!caseIds.length) return { tagsByCaseId: {}, itemsByCaseId: {} };
  const [tagRows] = await db.query(
    `SELECT case_id, tag_type, tag_value, sort_order
     FROM merchant_case_tags
     WHERE case_id IN (?)
     ORDER BY sort_order ASC, id ASC`,
    [caseIds]
  );
  const [itemRows] = await db.query(
    `SELECT *
     FROM merchant_case_items
     WHERE case_id IN (?)
     ORDER BY sort_order ASC, id ASC`,
    [caseIds]
  );
  const tagsByCaseId = {};
  const itemsByCaseId = {};
  for (const row of tagRows) {
    const id = Number(row.case_id);
    if (!tagsByCaseId[id]) tagsByCaseId[id] = [];
    tagsByCaseId[id].push(row);
  }
  for (const row of itemRows) {
    const id = Number(row.case_id);
    if (!itemsByCaseId[id]) itemsByCaseId[id] = [];
    itemsByCaseId[id].push(row);
  }
  return { tagsByCaseId, itemsByCaseId };
}

async function getCaseForMerchant(caseId, merchantId) {
  const [rows] = await db.query(
    `SELECT *
     FROM merchant_cases
     WHERE id = ? AND merchant_id = ?
     LIMIT 1`,
    [caseId, merchantId]
  );
  if (!rows[0]) return null;
  const detail = await getCaseRows([caseId]);
  return mapCase(
    rows[0],
    detail.tagsByCaseId[caseId] || [],
    detail.itemsByCaseId[caseId] || []
  );
}

async function writeCaseDetails(connection, caseId, tags, items) {
  await connection.query('DELETE FROM merchant_case_tags WHERE case_id = ?', [caseId]);
  await connection.query('DELETE FROM merchant_case_items WHERE case_id = ?', [caseId]);

  const tagRows = [];
  for (const type of TAG_TYPES) {
    const values = tags[type] || [];
    values.forEach((value, index) => {
      tagRows.push([caseId, type, value, index]);
    });
  }
  if (tagRows.length) {
    await connection.query(
      `INSERT INTO merchant_case_tags
       (case_id, tag_type, tag_value, sort_order)
       VALUES ?`,
      [tagRows]
    );
  }

  if (items.length) {
    await connection.query(
      `INSERT INTO merchant_case_items
       (case_id, product_id, product_name, brand, model, specification, color, quantity, remark, sort_order)
       VALUES ?`,
      [
        items.map((item, index) => [
          caseId,
          item.product_id,
          item.product_name,
          item.brand || null,
          item.model || null,
          item.specification || null,
          item.color || null,
          item.quantity || null,
          item.remark || null,
          item.sort_order || index,
        ]),
      ]
    );
  }
}

async function normalizeCasePayload(body, existing = {}, merchantId) {
  const images = normalizeImages(body.images ?? existing.images);
  const coverImage = normalizeString(body.cover_image || body.coverImage || existing.cover_image || images[0] || '', 500);
  const title = normalizeString(body.title ?? existing.title, 160);
  if (!title) return { error: '案例标题不能为空' };
  const descriptionSource = String(body.description ?? existing.description ?? '').trim();
  if ([...descriptionSource].length > CASE_LIMITS.maxSummaryLength) {
    return { error: `案例简介最多 ${CASE_LIMITS.maxSummaryLength} 字` };
  }
  const city = normalizeString(body.city ?? existing.city, 80);
  if (!CITY_OPTIONS.has(city)) return { error: '城市不正确' };
  const areaRange = normalizeString(body.area_range || body.areaRange || existing.area_range, 80);
  if (!AREA_OPTIONS.has(areaRange)) return { error: '面积档位不正确' };
  const tags = normalizeTags(body.tags ?? existing.tags);
  if (tags.error) return { error: tags.error };
  let items = [];
  try {
    items = await normalizeItems(body.items ?? existing.items, merchantId);
  } catch (err) {
    return { error: err.message || '使用产品不正确' };
  }
  const contentDelta = normalizeContentDelta(
    body.content_delta ?? body.contentDelta ?? existing.content_delta
  );
  if (contentDelta.error) return { error: contentDelta.error };
  const linkTitle = normalizeString(body.link_title ?? body.linkTitle ?? existing.link_title, 80);
  const linkUrl = normalizeCaseLink(body.link_url ?? body.linkUrl ?? existing.link_url);
  if (linkUrl === null) return { error: '案例链接必须是有效的 http/https 地址' };
  if (Boolean(linkTitle) !== Boolean(linkUrl)) return { error: '链接标题和链接地址需要同时填写' };
  return {
    value: {
      title,
      coverImage,
      images,
      description: descriptionSource,
      contentDelta: contentDelta.value,
      areaRange,
      budgetRange: normalizeString(body.budget_range || body.budgetRange || existing.budget_range, 80),
      linkTitle,
      linkUrl,
      city,
      status: existing.status || 'draft',
      sortOrder: Number(existing.sort_order || existing.sortOrder || 0) || 0,
      tags: tags.value,
      items,
    },
  };
}

async function listDashboardCases(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const [rows] = await db.query(
    `SELECT *
     FROM merchant_cases
     WHERE merchant_id = ?
     ORDER BY sort_order ASC, updated_at DESC, id DESC`,
    [req.user.id]
  );
  const caseIds = rows.map((row) => Number(row.id));
  const detail = await getCaseRows(caseIds);
  return success(res, rows.map((row) => mapCase(
    row,
    detail.tagsByCaseId[Number(row.id)] || [],
    detail.itemsByCaseId[Number(row.id)] || []
  )));
}

async function createDashboardCase(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const [[caseCount]] = await db.query(
    'SELECT COUNT(*) AS total FROM merchant_cases WHERE merchant_id = ?',
    [req.user.id]
  );
  if (Number(caseCount.total || 0) >= CASE_LIMITS.maxCases) {
    return error(res, `案例最多 ${CASE_LIMITS.maxCases} 个，请先删除不需要的案例`, 429);
  }

  const payload = await normalizeCasePayload(req.body, {}, req.user.id);
  if (payload.error) return error(res, payload.error);
  const item = payload.value;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO merchant_cases
       (merchant_id, title, cover_image, images, description, content_delta,
        area_range, budget_range, link_title, link_url, city, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req.user.id,
        item.title,
        item.coverImage || null,
        JSON.stringify(item.images),
        item.description || null,
        JSON.stringify(item.contentDelta),
        item.areaRange || null,
        item.budgetRange || null,
        item.linkTitle || null,
        item.linkUrl || null,
        item.city || null,
        item.status,
        item.sortOrder,
      ]
    );
    await writeCaseDetails(connection, result.insertId, item.tags, item.items);
    await connection.commit();
    return success(res, await getCaseForMerchant(result.insertId, req.user.id), '案例已创建');
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function updateDashboardCase(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const caseId = Number(req.params.id);
  const existing = await getCaseForMerchant(caseId, req.user.id);
  if (!existing) return error(res, '案例不存在', 404);
  const payload = await normalizeCasePayload(req.body, existing, req.user.id);
  if (payload.error) return error(res, payload.error);
  const item = payload.value;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE merchant_cases
       SET title = ?, cover_image = ?, images = ?, description = ?, content_delta = ?,
           area_range = ?, budget_range = ?, link_title = ?, link_url = ?, city = ?, status = ?, sort_order = ?
       WHERE id = ? AND merchant_id = ?`,
      [
        item.title,
        item.coverImage || null,
        JSON.stringify(item.images),
        item.description || null,
        JSON.stringify(item.contentDelta),
        item.areaRange || null,
        item.budgetRange || null,
        item.linkTitle || null,
        item.linkUrl || null,
        item.city || null,
        item.status,
        item.sortOrder,
        caseId,
        req.user.id,
      ]
    );
    await writeCaseDetails(connection, caseId, item.tags, item.items);
    await connection.commit();
    return success(res, await getCaseForMerchant(caseId, req.user.id), '案例已保存');
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function deleteDashboardCase(req, res) {
  if (!(await assertMerchant(req, res))) return;
  const caseId = Number(req.params.id);
  const existing = await getCaseForMerchant(caseId, req.user.id);
  if (!existing) return error(res, '案例不存在', 404);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM merchant_case_tags WHERE case_id = ?', [caseId]);
    await connection.query('DELETE FROM merchant_case_items WHERE case_id = ?', [caseId]);
    await connection.query('DELETE FROM merchant_cases WHERE id = ? AND merchant_id = ?', [caseId, req.user.id]);
    await connection.commit();
    return success(res, { deleted: true }, '案例已删除');
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function setDashboardCaseStatus(req, res, status) {
  if (!(await assertMerchant(req, res))) return;
  const caseId = Number(req.params.id);
  const existing = await getCaseForMerchant(caseId, req.user.id);
  if (!existing) return error(res, '案例不存在', 404);
  await db.query(
    'UPDATE merchant_cases SET status = ? WHERE id = ? AND merchant_id = ?',
    [status, caseId, req.user.id]
  );
  return success(res, await getCaseForMerchant(caseId, req.user.id), status === 'active' ? '案例已发布' : '案例已下架');
}

async function publishDashboardCase(req, res) {
  return setDashboardCaseStatus(req, res, 'active');
}

async function hideDashboardCase(req, res) {
  return setDashboardCaseStatus(req, res, 'hidden');
}

async function listPublicMerchantCases(req, res) {
  const merchantId = Number(req.params.id || req.params.userId);
  if (!merchantId) return error(res, '商家不存在', 404);
  const space = normalizeString(req.query.space, 40);
  const style = normalizeString(req.query.style, 40);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const tagParams = [];
  let tagJoins = '';
  if (space) {
    tagJoins += ` JOIN merchant_case_tags space_tag
      ON space_tag.case_id = mc.id
     AND space_tag.tag_type = 'space'
     AND space_tag.tag_value = ?`;
    tagParams.push(space);
  }
  if (style) {
    tagJoins += ` JOIN merchant_case_tags style_tag
      ON style_tag.case_id = mc.id
     AND style_tag.tag_type = 'style'
     AND style_tag.tag_value = ?`;
    tagParams.push(style);
  }
  const [rows] = await db.query(
    `SELECT mc.*, mp.shop_name AS merchant_name, mp.logo_url AS merchant_logo_url,
            mp.brand_intro AS merchant_intro, mp.service_area AS merchant_service_area,
            mp.consultation_enabled
     FROM merchant_cases mc
     JOIN merchant_profiles mp ON mp.user_id = mc.merchant_id
     JOIN users u ON u.id = mp.user_id
     ${tagJoins}
     WHERE mc.merchant_id = ?
       AND mc.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = mc.merchant_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )
     ORDER BY mc.sort_order ASC, mc.updated_at DESC, mc.id DESC
     LIMIT ? OFFSET ?`,
    [...tagParams, merchantId, pageSize, offset]
  );
  const [[countRow]] = await db.query(
    `SELECT COUNT(DISTINCT mc.id) AS total
     FROM merchant_cases mc
     JOIN merchant_profiles mp ON mp.user_id = mc.merchant_id
     ${tagJoins}
     WHERE mc.merchant_id = ?
       AND mc.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = mc.merchant_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )`,
    [...tagParams, merchantId]
  );
  const caseIds = rows.map((row) => Number(row.id));
  const detail = await getCaseRows(caseIds);
  return success(res, {
    items: rows.map((row) => mapCase(
      row,
      detail.tagsByCaseId[Number(row.id)] || [],
      detail.itemsByCaseId[Number(row.id)] || []
    )),
    total: Number(countRow.total || 0),
    page,
    pageSize,
    hasMore: rows.length === pageSize,
  });
}

async function getPublicMerchantCase(req, res) {
  const caseId = Number(req.params.id);
  if (!caseId) return error(res, '案例不存在', 404);
  const [rows] = await db.query(
    `SELECT mc.*, mp.shop_name AS merchant_name, mp.logo_url AS merchant_logo_url,
            mp.brand_intro AS merchant_intro, mp.service_area AS merchant_service_area,
            mp.consultation_enabled
     FROM merchant_cases mc
     JOIN merchant_profiles mp ON mp.user_id = mc.merchant_id
     WHERE mc.id = ?
       AND mc.status = 'active'
       AND EXISTS (
         SELECT 1 FROM user_roles ur
         WHERE ur.user_id = mc.merchant_id
           AND ${activeVerifiedMerchantExistsSql('ur')}
       )
     LIMIT 1`,
    [caseId]
  );
  if (!rows[0]) return error(res, '案例不存在或已下架', 404);
  await db.query('UPDATE merchant_cases SET view_count = view_count + 1 WHERE id = ?', [caseId]);
  rows[0].view_count = Number(rows[0].view_count || 0) + 1;
  const detail = await getCaseRows([caseId]);
  return success(res, mapCase(
    rows[0],
    detail.tagsByCaseId[caseId] || [],
    detail.itemsByCaseId[caseId] || []
  ));
}

async function uploadCaseImage(req, res) {
  if (!(await assertMerchant(req, res))) return;
  if (!req.file) return error(res, '请选择案例图片');
  const sourcePath = req.file.path;
  const extension = path.extname(req.file.filename).toLowerCase();
  const isGif = extension === '.gif' || req.file.mimetype === 'image/gif';
  const outputName = isGif
    ? req.file.filename.replace(/\.[^.]+$/, '.gif')
    : req.file.filename.replace(/\.[^.]+$/, '.webp');
  const outputPath = path.join(path.dirname(sourcePath), `processed-${outputName}`);
  try {
    let metadata;
    if (isGif) {
      const input = sharp(sourcePath, { animated: true, limitInputPixels: 80_000_000 });
      const sourceMetadata = await input.metadata();
      const pageCount = Math.max(1, Number(sourceMetadata.pages || 1));
      const delays = Array.isArray(sourceMetadata.delay) ? sourceMetadata.delay : [];
      const normalizedDelays = Array.from(
        { length: pageCount },
        (_, index) => Math.max(67, Number(delays[index] || delays[0] || 100))
      );
      let compressed = false;
      for (const option of [
        { width: 1080, colours: 128, effort: 7 },
        { width: 900, colours: 96, effort: 8 },
        { width: 720, colours: 64, effort: 9 },
        { width: 540, colours: 48, effort: 10 },
      ]) {
        await sharp(sourcePath, { animated: true, limitInputPixels: 80_000_000 })
          .resize({ width: option.width, withoutEnlargement: true })
          .gif({
            effort: option.effort,
            colours: option.colours,
            dither: 0.5,
            delay: normalizedDelays,
            loop: Number(sourceMetadata.loop || 0),
          })
          .toFile(outputPath);
        const stat = await fs.stat(outputPath);
        if (stat.size <= CASE_LIMITS.maxGifBytes) {
          compressed = true;
          break;
        }
      }
      if (!compressed) {
        await Promise.all([
          fs.rm(sourcePath, { force: true }),
          fs.rm(outputPath, { force: true }),
        ]);
        return error(res, 'GIF 压缩后仍超过 300KB，请裁剪时长或更换图片');
      }
      metadata = await sharp(outputPath, { animated: true }).metadata();
    } else {
      await sharp(sourcePath, { limitInputPixels: 80_000_000 })
        .rotate()
        .resize({ width: CASE_LIMITS.maxContentImageWidth, withoutEnlargement: true })
        .webp({ quality: 86, effort: 5 })
        .toFile(outputPath);
      metadata = await sharp(outputPath).metadata();
    }
    await fs.rm(sourcePath, { force: true });
    const finalName = path.basename(outputPath);
    const imageUrl = `${req.protocol}://${req.get('host')}/api/uploads/merchant-cases/${finalName}`;
    return success(res, {
      url: imageUrl,
      width: Number(metadata.width || 0),
      height: Number(metadata.pageHeight || metadata.height || 0),
      is_gif: isGif,
    }, '图片上传成功');
  } catch (uploadError) {
    await Promise.all([
      fs.rm(sourcePath, { force: true }),
      fs.rm(outputPath, { force: true }),
    ]);
    throw uploadError;
  }
}

module.exports = {
  listDashboardCases,
  createDashboardCase,
  updateDashboardCase,
  deleteDashboardCase,
  publishDashboardCase,
  hideDashboardCase,
  listPublicMerchantCases,
  getPublicMerchantCase,
  uploadCaseImage,
};
