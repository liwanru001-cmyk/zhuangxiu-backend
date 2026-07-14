const db = require('../config/db');
const { success, error } = require('../utils/response');
const { requireProjectContext } = require('../utils/project-context');

const validTargetTypes = new Set(['company', 'professional', 'user']);
const validSourcePages = new Set(['marketplace', 'profile', 'project']);

async function resolveBusinessCatalog(businessCatalogId) {
  if (!businessCatalogId) {
    return { exists: true, businessGroup: null };
  }
  const [rows] = await db.query(
    `SELECT parent.code AS parent_code, parent.name AS parent_name
     FROM business_catalog bc
     LEFT JOIN business_catalog parent ON parent.id = bc.parent_id
     WHERE bc.id = ? AND bc.status = 'active'
     LIMIT 1`,
    [businessCatalogId]
  );
  if (!rows[0]) return { exists: false, businessGroup: null };
  return {
    exists: true,
    businessGroup: rows[0].parent_code || rows[0].parent_name || null,
  };
}

async function resolveConsultationTarget(targetType, targetId) {
  if (targetType === 'company') {
    if (targetId < 0) {
      const userId = Math.abs(targetId);
      const [rows] = await db.query(
        `SELECT mp.user_id, mp.consultation_enabled, u.nickname
         FROM merchant_profiles mp
         JOIN users u ON u.id = mp.user_id
         WHERE mp.user_id = ?
         LIMIT 1`,
        [userId]
      );
      if (!rows[0]) return null;
      if (rows[0].consultation_enabled === 0 || rows[0].consultation_enabled === false) {
        return { closed: true, message: '该商家暂未开放咨询' };
      }
      return {
        recipientUserId: Number(rows[0].user_id),
        targetRole: 'merchant',
        displayName: rows[0].nickname || '商家',
      };
    }
    const [rows] = await db.query(
      `SELECT c.id, c.owner_user_id, c.name
       FROM companies c
       WHERE c.id = ? AND c.status <> 'deleted'
       LIMIT 1`,
      [targetId]
    );
    if (!rows[0]) return null;
    if (!rows[0].owner_user_id) {
      return { closed: true, message: '该装修公司暂未配置接收咨询的账号' };
    }
    return {
      recipientUserId: Number(rows[0].owner_user_id),
      targetRole: 'merchant',
      displayName: rows[0].name || '装修公司',
    };
  }

  if (targetType === 'professional') {
    if (targetId < 0) {
      const encoded = Math.abs(targetId);
      const roleCode = encoded % 10;
      const userId = Math.floor(encoded / 10);
      const targetRole = roleCode === 1 ? 'designer' : 'project_manager';
      const table = targetRole === 'designer' ? 'designer_profiles' : 'project_manager_profiles';
      const [rows] = await db.query(
        `SELECT p.user_id, p.consultation_enabled, u.nickname
         FROM ${table} p
         JOIN users u ON u.id = p.user_id
         WHERE p.user_id = ?
         LIMIT 1`,
        [userId]
      );
      if (!rows[0]) return null;
      if (rows[0].consultation_enabled === 0 || rows[0].consultation_enabled === false) {
        return { closed: true, message: '该专业人士暂未开放咨询' };
      }
      return {
        recipientUserId: Number(rows[0].user_id),
        targetRole,
        displayName: rows[0].nickname || '专业人士',
      };
    }
    const [rows] = await db.query(
      `SELECT p.id, p.user_id, p.role, u.nickname
       FROM professionals p
       JOIN users u ON u.id = p.user_id
       WHERE p.id = ? AND p.status <> 'deleted'
       LIMIT 1`,
      [targetId]
    );
    if (!rows[0]) return null;
    const targetRole = rows[0].role === 'project_supervisor'
      ? 'project_supervisor'
      : rows[0].role === 'project_manager'
        ? 'project_manager'
        : 'designer';
    return {
      recipientUserId: Number(rows[0].user_id),
      targetRole,
      displayName: rows[0].nickname || '专业人士',
    };
  }

  const [rows] = await db.query(
    `SELECT id, nickname FROM users WHERE id = ? LIMIT 1`,
    [targetId]
  );
  if (!rows[0]) return null;
  return {
    recipientUserId: Number(rows[0].id),
    targetRole: 'designer',
    displayName: rows[0].nickname || '用户',
  };
}

async function createUnifiedConsultation(req, res) {
  const projectContext = await requireProjectContext(req, res, {
    missingMessage: '咨询必须绑定装修项目，请选择项目后再发送',
  });
  if (!projectContext.ok) return projectContext.response;

  const targetType = String(req.body.target_type || '').trim();
  const targetId = Number(req.body.target_id);
  const businessCatalogId = req.body.business_catalog_id === undefined ||
    req.body.business_catalog_id === null ||
    req.body.business_catalog_id === ''
    ? null
    : Number(req.body.business_catalog_id);
  const sourcePage = validSourcePages.has(req.body.source_page)
    ? req.body.source_page
    : 'marketplace';
  const message = String(req.body.message || '').trim().slice(0, 1000);

  if (!validTargetTypes.has(targetType)) return error(res, '咨询对象类型不正确');
  if (!targetId) return error(res, '咨询对象不正确');
  if (targetType === 'user' && Number(req.user.id) === targetId) {
    return error(res, '不能咨询自己');
  }
  if (businessCatalogId !== null && (!Number.isInteger(businessCatalogId) || businessCatalogId <= 0)) {
    return error(res, '业务分类不正确');
  }
  if (!message) return error(res, '请填写咨询内容');

  const target = await resolveConsultationTarget(targetType, targetId);
  if (!target) return error(res, '咨询对象不存在', 404);
  if (target.closed) return error(res, target.message || '该对象暂未开放咨询');
  if (Number(target.recipientUserId) === Number(req.user.id)) {
    return error(res, '不能咨询自己');
  }

  const catalog = await resolveBusinessCatalog(businessCatalogId);
  if (!catalog.exists) return error(res, '业务分类不存在', 404);
  const connection = await db.getConnection();
  let consultationId;
  let targetRecordId;
  try {
    await connection.beginTransaction();
    const [consultationResult] = await connection.query(
      `INSERT INTO designer_consultations
       (designer_id, target_role, user_id, content, has_project, status)
       VALUES (?, ?, ?, ?, 1, 'pending')`,
      [
        target.recipientUserId,
        target.targetRole,
        req.user.id,
        message,
      ]
    );
    consultationId = consultationResult.insertId;
    const [messageResult] = await connection.query(
      `INSERT INTO consultation_messages
       (consultation_id, sender_id, content)
       VALUES (?, ?, ?)`,
      [consultationId, req.user.id, message]
    );
    await connection.query(
      `INSERT IGNORE INTO consultation_message_reads (message_id, user_id)
       VALUES (?, ?)`,
      [messageResult.insertId, req.user.id]
    );
    const [targetResult] = await connection.query(
      `INSERT INTO consultation_targets
       (consultation_id, requester_user_id, target_type, target_id,
        business_catalog_id, business_group, source_page, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        consultationId,
        req.user.id,
        targetType,
        targetId,
        businessCatalogId,
        catalog.businessGroup,
        sourcePage,
        message,
      ]
    );
    targetRecordId = targetResult.insertId;
    await connection.query(
      `INSERT IGNORE INTO entity_relations
         (source_type, source_id, target_type, target_id, relation_type, role_label)
       VALUES ('consultation', ?, 'project', ?, 'participant', 'project_context')`,
      [consultationId, projectContext.projectId]
    );
    await connection.query(
      `INSERT INTO project_action_notifications
         (item_id, recipient_id, event_type, delivery_status, payload)
       VALUES (NULL, ?, 'consultation', 'pending', ?)`,
      [
        target.recipientUserId,
        JSON.stringify({
          source: 'consultation',
          targetRole: target.targetRole,
          consultationId,
          projectId: projectContext.projectId,
          requesterUserId: req.user.id,
          title: targetType === 'company' ? '新的公司咨询' : '新的咨询',
          content: targetType === 'company'
            ? '你收到一条新的装修公司咨询'
            : '你收到一条新的站内咨询',
          route: 'consultation_chat',
          deepLink: { consultationId, projectId: projectContext.projectId },
          entityType: 'consultation',
          entityId: consultationId,
        }),
      ]
    );
    await connection.commit();
  } catch (consultationError) {
    await connection.rollback();
    throw consultationError;
  } finally {
    connection.release();
  }

  return success(res, {
    id: consultationId,
    consultation_id: consultationId,
    target_record_id: targetRecordId,
    project_id: projectContext.projectId,
    target_type: targetType,
    target_id: targetId,
    business_catalog_id: businessCatalogId,
    business_group: catalog.businessGroup,
    source_page: sourcePage,
  }, '咨询已发送');
}

module.exports = {
  createUnifiedConsultation,
};
