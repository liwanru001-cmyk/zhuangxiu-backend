const db = require('../config/db');
const { success, error } = require('../utils/response');
const { activeVerifiedMerchantExistsSql } = require('../utils/verified-merchant');

const TYPES = new Set(['merchant_product', 'merchant', 'company', 'merchant_case', 'company_case']);

async function projectAccess(projectId, userId) {
  const [rows] = await db.query(
    `SELECT p.id
     FROM renovation_projects p
     LEFT JOIN project_members member
       ON member.project_id = p.id
      AND member.user_id = ?
      AND member.status = 1
     WHERE p.id = ?
       AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
       AND (p.user_id = ? OR member.user_id IS NOT NULL)
     LIMIT 1`,
    [userId, projectId, userId]
  );
  return Boolean(rows[0]);
}

async function loadContent(type, id) {
  if (type === 'merchant') {
    const [rows] = await db.query(
      `SELECT profile.user_id AS id,
              COALESCE(NULLIF(profile.shop_name, ''), merchant.nickname, '商家店铺') AS title,
              profile.logo_url AS cover_url,
              profile.brand_intro AS summary,
              profile.user_id AS merchant_user_id,
              COALESCE(NULLIF(profile.shop_name, ''), merchant.nickname, '商家店铺') AS source_name
       FROM merchant_profiles profile
       JOIN users merchant ON merchant.id = profile.user_id
       WHERE profile.user_id = ?
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = profile.user_id
             AND ${activeVerifiedMerchantExistsSql('ur')}
         )
       LIMIT 1`,
      [id]
    );
    return rows[0];
  }
  if (type === 'company') {
    const [rows] = await db.query(
      `SELECT company.id, company.name AS title, company.logo_url AS cover_url,
              company.intro AS summary, company.id AS company_id,
              company.name AS source_name
       FROM companies company
       WHERE company.id = ?
         AND company.status = 'active'
         AND company.verification_status = 'verified'
       LIMIT 1`,
      [id]
    );
    return rows[0];
  }
  if (type === 'merchant_product') {
    const [rows] = await db.query(
      `SELECT product.id, product.name AS title, product.cover_url,
              product.summary, product.merchant_user_id,
              COALESCE(NULLIF(profile.shop_name, ''), merchant.nickname, '商家店铺') AS source_name
       FROM merchant_products product
       JOIN merchant_profiles profile ON profile.user_id = product.merchant_user_id
       JOIN users merchant ON merchant.id = product.merchant_user_id
       WHERE product.id = ? AND product.status = 'active'
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = product.merchant_user_id
             AND ${activeVerifiedMerchantExistsSql('ur')}
         )
       LIMIT 1`,
      [id]
    );
    return rows[0];
  }
  if (type === 'merchant_case') {
    const [rows] = await db.query(
      `SELECT merchant_case.id, merchant_case.title,
              merchant_case.cover_image AS cover_url,
              merchant_case.description AS summary,
              merchant_case.merchant_id AS merchant_user_id,
              COALESCE(NULLIF(profile.shop_name, ''), merchant.nickname, '商家店铺') AS source_name
       FROM merchant_cases merchant_case
       JOIN merchant_profiles profile ON profile.user_id = merchant_case.merchant_id
       JOIN users merchant ON merchant.id = merchant_case.merchant_id
       WHERE merchant_case.id = ? AND merchant_case.status = 'active'
         AND EXISTS (
           SELECT 1 FROM user_roles ur
           WHERE ur.user_id = merchant_case.merchant_id
             AND ${activeVerifiedMerchantExistsSql('ur')}
         )
       LIMIT 1`,
      [id]
    );
    return rows[0];
  }
  const [rows] = await db.query(
    `SELECT share.id, share.title,
            JSON_UNQUOTE(JSON_EXTRACT(share.image_urls, '$[0]')) AS cover_url,
            share.summary, company.id AS company_id, company.name AS source_name
     FROM project_case_shares share
     JOIN companies company
       ON company.status = 'active'
      AND company.verification_status = 'verified'
      AND (
        company.owner_user_id = share.designer_id OR
        EXISTS (
          SELECT 1 FROM company_members member
          WHERE member.company_id = company.id
            AND member.user_id = share.designer_id
            AND member.status = 'active'
        )
      )
     WHERE share.id = ? AND share.status = 1
     ORDER BY company.id ASC LIMIT 1`,
    [id]
  );
  return rows[0];
}

function parseRecipientIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => id > 0))];
}

async function createShare(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await projectAccess(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const contentType = String(req.body.content_type || '').trim();
  const contentId = Number(req.body.content_id);
  if (!TYPES.has(contentType) || !contentId) return error(res, '分享内容不正确');
  const content = await loadContent(contentType, contentId);
  if (!content) return error(res, '分享内容不存在或已下架', 404);
  const shareNote = String(req.body.share_note || '').trim().slice(0, 200);
  const sharedToAll = req.body.shared_to_all === true || req.body.shared_to_all === 1;
  let recipientIds = parseRecipientIds(req.body.recipient_user_ids)
    .filter((id) => id !== Number(req.user.id));
  if (!sharedToAll && !recipientIds.length) return error(res, '请选择项目成员');
  if (recipientIds.length) {
    const [members] = await db.query(
      `SELECT user_id FROM project_members
       WHERE project_id = ? AND status = 1 AND user_id IN (?)`,
      [projectId, recipientIds]
    );
    const allowed = new Set(members.map((item) => Number(item.user_id)));
    recipientIds = recipientIds.filter((id) => allowed.has(id));
    if (!recipientIds.length) return error(res, '所选成员不在当前项目中');
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_content_shares
       (project_id, shared_by, content_type, content_id, share_note, shared_to_all)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [projectId, req.user.id, contentType, contentId, shareNote || null, sharedToAll ? 1 : 0]
    );
    if (!sharedToAll && recipientIds.length) {
      await connection.query(
        `INSERT INTO project_content_share_recipients (share_id, user_id)
         VALUES ${recipientIds.map(() => '(?, ?)').join(', ')}`,
        recipientIds.flatMap((userId) => [result.insertId, userId])
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '已分享给项目成员');
  } catch (shareError) {
    await connection.rollback();
    throw shareError;
  } finally {
    connection.release();
  }
}

async function listShares(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await projectAccess(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const type = String(req.query.type || '').trim();
  const scope = String(req.query.scope || 'all').trim();
  const params = [projectId, req.user.id, req.user.id];
  let where = '';
  if (TYPES.has(type)) {
    where += ' AND share.content_type = ?';
    params.push(type);
  }
  if (scope === 'mine') {
    where += ' AND share.shared_by = ?';
    params.push(req.user.id);
  } else if (scope === 'received') {
    where += ' AND share.shared_by <> ?';
    params.push(req.user.id);
  }
  const [rows] = await db.query(
    `SELECT share.id, share.project_id, share.content_type, share.content_id,
            share.share_note, share.shared_to_all, share.created_at,
            sharer.nickname AS shared_by_name, share.shared_by,
            COALESCE(member.role, CASE WHEN project.user_id = share.shared_by THEN 'owner' ELSE '' END) AS shared_by_role,
            (
              SELECT GROUP_CONCAT(DISTINCT recipient.nickname ORDER BY recipient.nickname SEPARATOR '、')
              FROM project_content_share_recipients target
              JOIN users recipient ON recipient.id = target.user_id
              WHERE target.share_id = share.id
            ) AS recipient_names
     FROM project_content_shares share
     JOIN renovation_projects project ON project.id = share.project_id
     JOIN users sharer ON sharer.id = share.shared_by
     LEFT JOIN project_members member
       ON member.project_id = share.project_id
      AND member.user_id = share.shared_by
      AND member.status = 1
     WHERE share.project_id = ?
       AND (
         share.shared_by = ? OR share.shared_to_all = 1 OR
         EXISTS (
           SELECT 1 FROM project_content_share_recipients mine
           WHERE mine.share_id = share.id AND mine.user_id = ?
         )
       )
       ${where}
     ORDER BY share.created_at DESC, share.id DESC
     LIMIT 100`,
    params
  );
  const items = [];
  for (const row of rows) {
    const content = await loadContent(row.content_type, Number(row.content_id));
    if (!content) continue;
    items.push({
      ...row,
      shared_to_all: Boolean(row.shared_to_all),
      title: content.title || '',
      cover_url: content.cover_url || '',
      summary: content.summary || '',
      source_name: content.source_name || '',
      merchant_user_id: Number(content.merchant_user_id || 0),
      company_id: Number(content.company_id || 0),
    });
  }
  return success(res, items);
}

async function listAccountShares(req, res) {
  const type = String(req.query.type || '').trim();
  const scope = String(req.query.scope || 'all').trim();
  const params = [
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id
  ];
  let where = '';
  if (TYPES.has(type)) {
    where += ' AND share.content_type = ?';
    params.push(type);
  }
  if (scope === 'mine') {
    where += ' AND share.shared_by = ?';
    params.push(req.user.id);
  } else if (scope === 'received') {
    where += ' AND share.shared_by <> ?';
    params.push(req.user.id);
  }
  const [rows] = await db.query(
    `SELECT share.id, share.project_id, share.content_type, share.content_id,
            share.share_note, share.shared_to_all, share.created_at,
            sharer.nickname AS shared_by_name, share.shared_by,
            project.project_name,
            COALESCE(member.role, CASE WHEN project.user_id = share.shared_by THEN 'owner' ELSE '' END) AS shared_by_role,
            (
              SELECT GROUP_CONCAT(DISTINCT recipient.nickname ORDER BY recipient.nickname SEPARATOR '、')
              FROM project_content_share_recipients target
              JOIN users recipient ON recipient.id = target.user_id
              WHERE target.share_id = share.id
            ) AS recipient_names
     FROM project_content_shares share
     LEFT JOIN renovation_projects project ON project.id = share.project_id
     JOIN users sharer ON sharer.id = share.shared_by
     LEFT JOIN project_members current_member
       ON current_member.project_id = share.project_id
      AND current_member.user_id = ?
      AND current_member.status = 1
     LEFT JOIN project_members member
       ON member.project_id = share.project_id
      AND member.user_id = share.shared_by
      AND member.status = 1
     WHERE (
       (
         share.project_id IS NULL
         AND (
           share.shared_by = ? OR EXISTS (
             SELECT 1 FROM project_content_share_recipients mine
             WHERE mine.share_id = share.id AND mine.user_id = ?
           )
         )
       )
       OR
       (
         share.project_id IS NOT NULL
         AND COALESCE(project.lifecycle_status, 'active') <> 'deleted'
         AND (project.user_id = ? OR current_member.user_id IS NOT NULL)
         AND (
           share.shared_by = ? OR share.shared_to_all = 1 OR
           EXISTS (
             SELECT 1 FROM project_content_share_recipients mine
             WHERE mine.share_id = share.id AND mine.user_id = ?
           )
         )
       )
     )
       ${where}
     ORDER BY share.created_at DESC, share.id DESC
     LIMIT 100`,
    params
  );
  const items = [];
  for (const row of rows) {
    const content = await loadContent(row.content_type, Number(row.content_id));
    if (!content) continue;
    items.push({
      ...row,
      shared_to_all: Boolean(row.shared_to_all),
      title: content.title || '',
      cover_url: content.cover_url || '',
      summary: content.summary || '',
      source_name: content.source_name || '',
      merchant_user_id: Number(content.merchant_user_id || 0),
      company_id: Number(content.company_id || 0),
    });
  }
  return success(res, items);
}

async function unreadCount(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await projectAccess(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT COUNT(*) AS unread_count
     FROM project_content_shares share
     LEFT JOIN project_content_share_reads read_state
       ON read_state.project_id = share.project_id
      AND read_state.user_id = ?
     WHERE share.project_id = ?
       AND share.shared_by <> ?
       AND share.created_at > COALESCE(read_state.last_read_at, '1970-01-01')
       AND (
         share.shared_to_all = 1 OR EXISTS (
           SELECT 1 FROM project_content_share_recipients target
           WHERE target.share_id = share.id AND target.user_id = ?
         )
       )`,
    [req.user.id, projectId, req.user.id, req.user.id]
  );
  return success(res, { unread_count: Number(rows[0]?.unread_count || 0) });
}

async function markRead(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await projectAccess(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  await db.query(
    `INSERT INTO project_content_share_reads (project_id, user_id, last_read_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE last_read_at = NOW()`,
    [projectId, req.user.id]
  );
  return success(res, null, '已读');
}

module.exports = { createShare, listShares, listAccountShares, unreadCount, markRead };
