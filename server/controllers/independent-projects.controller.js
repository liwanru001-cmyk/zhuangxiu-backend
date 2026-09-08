const db = require('../config/db');
const crypto = require('crypto');
const { success, error } = require('../utils/response');
const { isIndependentProjectManager } = require('../services/independent-project-policy');

async function lockProject(connection, projectId, userId) {
  const [projects] = await connection.query(
    `SELECT * FROM renovation_projects WHERE id = ? FOR UPDATE`, [projectId]
  );
  const project = projects[0];
  if (!project || project.lifecycle_status !== 'active') return null;
  const [members] = await connection.query(
    `SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND status = 1`,
    [projectId, userId]
  );
  return members.some(member => isIndependentProjectManager(project, userId, member.role))
    ? project : null;
}

async function create(req, res) {
  if (req.user.role !== 'designer') return error(res, '仅设计师可以独立创建项目', 403);
  const name = String(req.body.project_name || '').trim();
  const clientName = String(req.body.client_name || '').trim();
  if (!name || name.length > 10) return error(res, '项目名称需为 1～10 个字符');
  if (clientName.length > 80) return error(res, '客户称呼不能超过 80 个字符');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    // Keep user_id null until a client explicitly accepts an invitation.
    let result;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = String.fromCharCode(65 + crypto.randomInt(26), 65 + crypto.randomInt(26))
        + String(crypto.randomInt(100000000)).padStart(8, '0');
      try {
        [result] = await connection.query(
          `INSERT INTO renovation_projects
           (user_id, created_by, creation_source, preparation_stage, client_name,
            designer_id, project_code, project_name, house_area, start_date,
            total_days, current_stage, status, renovation_method)
           VALUES (NULL, ?, 'designer', 'preparation', ?, ?, ?, ?, 0, NULL, 0, 1, 1, 'independent_designer')`,
          [req.user.id, clientName || null, req.user.id, code, name]
        );
        break;
      } catch (insertError) {
        if (insertError.code !== 'ER_DUP_ENTRY' || attempt === 11) throw insertError;
      }
    }
    await connection.query(
      `INSERT INTO project_members (project_id, user_id, role, status, permissions)
       VALUES (?, ?, 'designer', 1, ?)`,
      [result.insertId, req.user.id, JSON.stringify({ manage_tasks: true, view_project: true })]
    );
    // No construction schedule or owner approval requests are created here.
    await connection.commit();
    return success(res, { id: result.insertId }, '项目已创建');
  } catch (createError) {
    await connection.rollback();
    throw createError;
  } finally { connection.release(); }
}

async function inviteOwner(req, res) {
  const projectId = Number(req.params.id);
  const phone = String(req.body.phone || '').trim();
  if (!/^1\d{10}$/.test(phone)) return error(res, '请输入完整的业主手机号');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const project = await lockProject(connection, projectId, req.user.id);
    if (!project) { await connection.rollback(); return error(res, '无项目管理权限', 403); }
    if (project.user_id) { await connection.rollback(); return error(res, '业主已加入该项目', 409); }
    const [users] = await connection.query('SELECT id FROM users WHERE phone = ? LIMIT 1', [phone]);
    const target = users[0];
    if (!target || Number(target.id) === Number(req.user.id)) {
      await connection.rollback();
      return error(res, '请填写已注册的其他用户手机号');
    }
    const [pending] = await connection.query(
      `SELECT id FROM project_owner_invitations WHERE project_id = ? AND target_user_id = ?
       AND status = 'pending' AND expires_at > NOW() LIMIT 1`, [projectId, target.id]
    );
    if (pending[0]) {
      await connection.commit();
      return success(res, { id: pending[0].id }, '邀请已发送，等待接受');
    }
    // Only one currently invited client per project; an old invitation grants no access.
    await connection.query(
      `UPDATE project_owner_invitations SET status = 'cancelled'
       WHERE project_id = ? AND status = 'pending'`, [projectId]
    );
    const [result] = await connection.query(
      `INSERT INTO project_owner_invitations (project_id, invited_by, target_user_id, expires_at)
       VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))`, [projectId, req.user.id, target.id]
    );
    await connection.commit();
    return success(res, { id: result.insertId }, '邀请已发送，可在消息中接受');
  } catch (inviteError) {
    await connection.rollback(); throw inviteError;
  } finally { connection.release(); }
}

async function listInvitations(req, res) {
  const [rows] = await db.query(
    `SELECT i.id, i.project_id, i.invited_by, i.target_user_id,
       CASE WHEN i.status = 'pending' AND i.expires_at <= NOW() THEN 'expired' ELSE i.status END AS status,
       i.expires_at, p.project_name, inviter.nickname AS inviter_name,
       target.nickname AS target_name
     FROM project_owner_invitations i
     JOIN renovation_projects p ON p.id = i.project_id
     JOIN users inviter ON inviter.id = i.invited_by
     JOIN users target ON target.id = i.target_user_id
     WHERE (i.target_user_id = ? OR i.invited_by = ?)
       AND COALESCE(p.lifecycle_status, 'active') = 'active'
     ORDER BY i.id DESC LIMIT 100`, [req.user.id, req.user.id]
  );
  return success(res, rows);
}

async function respondInvitation(req, res) {
  const id = Number(req.params.invitationId);
  const action = req.body.action;
  if (!['accept', 'reject'].includes(action)) return error(res, '邀请操作不正确');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [refs] = await connection.query(
      'SELECT project_id FROM project_owner_invitations WHERE id = ? AND target_user_id = ?',
      [id, req.user.id]
    );
    if (!refs[0]) { await connection.rollback(); return error(res, '邀请不存在', 404); }
    // Same project-first lock order as inviteOwner prevents acceptance/replacement races.
    const [projects] = await connection.query(
      'SELECT * FROM renovation_projects WHERE id = ? FOR UPDATE', [refs[0].project_id]
    );
    const [invitations] = await connection.query(
      `SELECT *, expires_at > NOW() AS unexpired FROM project_owner_invitations
       WHERE id = ? AND target_user_id = ? FOR UPDATE`, [id, req.user.id]
    );
    const invitation = invitations[0];
    const project = projects[0];
    if (!project || project.lifecycle_status !== 'active' || !invitation
      || invitation.status !== 'pending' || !invitation.unexpired || project.user_id) {
      await connection.rollback(); return error(res, '邀请已处理或失效', 409);
    }
    const [managers] = await connection.query(
      `SELECT role FROM project_members WHERE project_id = ? AND user_id = ? AND status = 1`,
      [project.id, invitation.invited_by]
    );
    if (!managers.some(m => isIndependentProjectManager(project, invitation.invited_by, m.role))) {
      await connection.rollback(); return error(res, '邀请人已无项目管理权限', 409);
    }
    if (action === 'accept') {
      await connection.query('UPDATE renovation_projects SET user_id = ? WHERE id = ?', [req.user.id, project.id]);
      await connection.query(
        `INSERT INTO project_members (project_id, user_id, role, status, permissions)
         VALUES (?, ?, 'owner', 1, ?)
         ON DUPLICATE KEY UPDATE status = 1, permissions = VALUES(permissions)`,
        [project.id, req.user.id, JSON.stringify({ manage_members: true, manage_tasks: true, view_project: true })]
      );
    }
    await connection.query('UPDATE project_owner_invitations SET status = ? WHERE id = ?',
      [action === 'accept' ? 'accepted' : 'rejected', id]);
    await connection.commit();
    return success(res, { project_id: project.id }, action === 'accept' ? '已加入项目' : '已拒绝邀请');
  } catch (respondError) {
    await connection.rollback(); throw respondError;
  } finally { connection.release(); }
}

module.exports = { create, inviteOwner, listInvitations, respondInvitation };
