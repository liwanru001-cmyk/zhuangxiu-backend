const db = require('../config/db');
const storageService = require('../services/storage.service');
const { success, error } = require('../utils/response');

const categories = new Set(['sexual', 'fraud_gambling', 'illegal', 'harassment', 'advertising', 'impersonation', 'privacy', 'other']);
const targetTypes = new Set(['user', 'conversation', 'message']);

async function consultationContext(consultationId, userId, messageId = null) {
  const [rows] = await db.query(
    `SELECT c.id, c.user_id, c.designer_id, c.target_role, c.content,
            owner.nickname AS user_nickname, target.nickname AS target_nickname
     FROM designer_consultations c
     JOIN users owner ON owner.id = c.user_id
     JOIN users target ON target.id = c.designer_id
     WHERE c.id = ? AND (c.user_id = ? OR c.designer_id = ?) LIMIT 1`,
    [consultationId, userId, userId]
  );
  const consultation = rows[0];
  if (!consultation) return null;
  const reportedUserId = Number(consultation.user_id) === Number(userId)
    ? Number(consultation.designer_id) : Number(consultation.user_id);
  const reportedNickname = Number(consultation.user_id) === Number(userId)
    ? consultation.target_nickname : consultation.user_nickname;
  let message = null;
  if (messageId) {
    const [messages] = await db.query(
      `SELECT id, consultation_id, sender_id, content, created_at
       FROM consultation_messages WHERE id = ? AND consultation_id = ? LIMIT 1`,
      [messageId, consultationId]
    );
    message = messages[0] || null;
    if (!message || Number(message.sender_id) !== reportedUserId) return null;
  }
  return { consultation, reportedUserId, reportedNickname, message };
}

async function getContext(req, res) {
  const consultationId = Number(req.query.consultation_id || 0);
  const messageId = Number(req.query.message_id || 0) || null;
  const context = await consultationContext(consultationId, req.user.id, messageId);
  if (!context) return error(res, '举报对象不存在或无权限', 404);
  return success(res, {
    consultation_id: consultationId,
    message_id: messageId,
    reported_user_id: context.reportedUserId,
    reported_nickname: context.reportedNickname || '对方用户',
    message_summary: context.message ? String(context.message.content || '').slice(0, 120) : '',
    rules_url: '/support/#report-rules',
  });
}

async function uploadEvidence(req, res) {
  if (!req.file) return error(res, '请选择图片');
  const url = storageService.uploadedFileUrl(req, req.file, `/uploads/reports/${req.file.filename}`);
  return success(res, { url }, '图片已上传');
}

async function submitReport(req, res) {
  const consultationId = Number(req.body.consultation_id || 0);
  const messageId = Number(req.body.message_id || 0) || null;
  const targetType = String(req.body.target_type || (messageId ? 'message' : 'conversation'));
  const category = String(req.body.category || '');
  const description = String(req.body.description || '').trim().slice(0, 1000) || null;
  const clientReportId = String(req.body.client_report_id || '').trim().slice(0, 80) || null;
  const evidenceUrls = Array.isArray(req.body.evidence_urls) ? req.body.evidence_urls.slice(0, 3) : [];
  if (!targetTypes.has(targetType)) return error(res, '举报对象类型不正确');
  if (!categories.has(category)) return error(res, '请选择举报类型');
  const context = await consultationContext(consultationId, req.user.id, messageId);
  if (!context) return error(res, '举报对象不存在或无权限', 404);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (clientReportId) {
      const [existing] = await connection.query(
        `SELECT o.report_id FROM content_report_occurrences o
         WHERE o.reporter_user_id = ? AND o.client_report_id = ? LIMIT 1`,
        [req.user.id, clientReportId]
      );
      if (existing[0]) {
        await connection.rollback();
        return success(res, { id: Number(existing[0].report_id) }, '举报已提交，我们将尽快核实处理。感谢您共同维护健康的交流环境。');
      }
    }
    const [reports] = await connection.query(
      `SELECT id FROM content_reports
       WHERE reported_user_id = ? AND consultation_id = ?
         AND ((message_id IS NULL AND ? IS NULL) OR message_id = ?)
         AND status IN ('pending', 'processing')
       ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      [context.reportedUserId, consultationId, messageId, messageId]
    );
    let reportId;
    if (reports[0]) {
      reportId = Number(reports[0].id);
      await connection.query(
        `UPDATE content_reports SET report_count = report_count + 1,
          latest_category = ?, latest_description = ?, updated_at = NOW() WHERE id = ?`,
        [category, description, reportId]
      );
    } else {
      const snapshot = context.message?.content || null;
      const [created] = await connection.query(
        `INSERT INTO content_reports
          (target_type, reported_user_id, consultation_id, message_id, latest_category,
           latest_description, message_snapshot, context_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [targetType, context.reportedUserId, consultationId, messageId, category, description,
          snapshot, JSON.stringify({ reported_nickname: context.reportedNickname, consultation_content: context.consultation.content })]
      );
      reportId = Number(created.insertId);
    }
    const [occurrence] = await connection.query(
      `INSERT INTO content_report_occurrences
        (report_id, reporter_user_id, category, description, app_platform, app_version, client_report_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [reportId, req.user.id, category, description,
        String(req.body.app_platform || '').slice(0, 32) || null,
        String(req.body.app_version || '').slice(0, 64) || null, clientReportId]
    );
    if (evidenceUrls.length) {
      await connection.query(
        `INSERT INTO content_report_evidence (occurrence_id, image_url, sort_order) VALUES ${evidenceUrls.map(() => '(?, ?, ?)').join(', ')}`,
        evidenceUrls.flatMap((url, index) => [occurrence.insertId, String(url).slice(0, 1000), index])
      );
    }
    await connection.commit();
    return success(res, { id: reportId }, '举报已提交，我们将尽快核实处理。感谢您共同维护健康的交流环境。');
  } catch (e) {
    await connection.rollback();
    throw e;
  } finally {
    connection.release();
  }
}

async function blockUser(req, res) {
  const blockedId = Number(req.params.id || 0);
  if (!blockedId || blockedId === Number(req.user.id)) return error(res, '拉黑对象不正确');
  await db.query('INSERT IGNORE INTO user_blocks (blocker_user_id, blocked_user_id) VALUES (?, ?)', [req.user.id, blockedId]);
  return success(res, null, '已加入黑名单');
}

async function unblockUser(req, res) {
  await db.query('DELETE FROM user_blocks WHERE blocker_user_id = ? AND blocked_user_id = ?', [req.user.id, Number(req.params.id || 0)]);
  return success(res, null, '已移出黑名单');
}

async function updateConversationPreference(req, res) {
  const consultationId = Number(req.params.id || 0);
  const context = await consultationContext(consultationId, req.user.id);
  if (!context) return error(res, '会话不存在或无权限', 404);
  if (req.body.clear === true) {
    await db.query(
      `INSERT INTO consultation_user_preferences (consultation_id, user_id, cleared_before)
       VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE cleared_before = NOW()`, [consultationId, req.user.id]);
  }
  if (req.body.receive_messages !== undefined) {
    await db.query(
      `INSERT INTO consultation_user_preferences (consultation_id, user_id, receive_messages)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE receive_messages = VALUES(receive_messages)`,
      [consultationId, req.user.id, req.body.receive_messages ? 1 : 0]);
  }
  return success(res, null, '会话设置已更新');
}

module.exports = { getContext, uploadEvidence, submitReport, blockUser, unblockUser, updateConversationPreference };
