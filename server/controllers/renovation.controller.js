const db = require('../config/db');
const { success, error } = require('../utils/response');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const storageService = require('../services/storage.service');
const { ProjectEventType, emitProjectEvent } = require('../services/project-event.service');
const { requireProjectContext } = require('../utils/project-context');

const stages = [
  { id: 1, name: '设计准备', traditional: '设计准备', emoji: '📐', days: 14, taskCount: 3, keyTaskCount: 1 },
  { id: 2, name: '主体拆改', traditional: '主体拆改', emoji: '🔨', days: 5, taskCount: 2, keyTaskCount: 1 },
  { id: 3, name: '水电改造', traditional: '水电改造', emoji: '⚡', days: 10, taskCount: 3, keyTaskCount: 1 },
  { id: 4, name: '泥瓦防水', traditional: '泥瓦防水', emoji: '🧱', days: 14, taskCount: 3, keyTaskCount: 1 },
  { id: 5, name: '木工施工', traditional: '木工施工', emoji: '🪵', days: 10, taskCount: 2, keyTaskCount: 1 },
  { id: 6, name: '油漆施工', traditional: '油漆施工', emoji: '🎨', days: 12, taskCount: 3, keyTaskCount: 1 },
  { id: 7, name: '安装阶段', traditional: '安装阶段', emoji: '🏠', days: 10, taskCount: 3, keyTaskCount: 1 },
  { id: 8, name: '竣工验收', traditional: '竣工验收', emoji: '🎉', days: 7, taskCount: 2, keyTaskCount: 1 },
];

const taskNames = {
  1: ['确认装修需求', '确定设计方案', '核对装修预算'],
  2: ['现场成品保护', '拆除与清运'],
  3: ['水电定位', '水电施工', '水电验收'],
  4: ['墙地面找平', '防水施工', '闭水试验'],
  5: ['吊顶施工', '柜体基层施工'],
  6: ['墙面基层处理', '乳胶漆施工', '墙面验收'],
  7: ['主材安装', '灯具洁具安装', '软装进场'],
  8: ['全屋验收', '开荒保洁'],
};

const memberPermissions = {
  owner: { manage_members: true, manage_tasks: true, view_project: true },
  owner_member: {
    view_project: true,
    confirm_design: true,
    feedback_design: true,
    review_inspection: true,
  },
  designer: { manage_tasks: true, view_project: true },
  project_manager: { manage_tasks: true, view_project: true },
  project_supervisor: { manage_tasks: true, view_project: true },
  merchant: { view_project: true },
};
const ownerSideRoles = new Set(['owner', 'owner_member']);
const notePublishRoles = new Set(['owner', 'designer', 'merchant', 'project_manager']);
const companyAdminViewerRole = 'company_admin_viewer';

async function ensureProjectCheckInCircleSharesTable(executor = db) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS project_checkin_circle_shares (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      checkin_id BIGINT UNSIGNED NOT NULL,
      note_id BIGINT UNSIGNED DEFAULT NULL,
      shared_by BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_checkin_circle (checkin_id),
      KEY idx_shared_by (shared_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureProjectCheckInWechatSharesTable(executor = db) {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS project_checkin_wechat_shares (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      checkin_id BIGINT UNSIGNED NOT NULL,
      token VARCHAR(64) NOT NULL,
      shared_by BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_checkin_shared_by (checkin_id, shared_by),
      UNIQUE KEY uk_token (token),
      KEY idx_checkin_id (checkin_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

const defaultProjectSpaces = ['客厅', '主卧', '次卧', '厨房', '卫生间', '阳台'];
const defaultProjectName = '装修项目';
const legacyInvalidProjectNames = new Set([
  'è£…ä¿®é¡¹ç›®',
]);
const ownerSearchAttempts = new Map();
const ownerInviteAttempts = new Map();
const PROJECT_UPLOAD_QUOTAS = {
  checkInDailyLimit: 3,
  checkInTotalLimit: 50,
  inspectionImageLimit: 3,
  expenseReceiptLimit: 3,
  spaceImagesPerSpaceLimit: 30,
  spaceImagesDailyLimit: 20,
  designDocumentsPerProjectLimit: 30,
  designDocumentsDailyLimit: 5,
  handoverImageLimit: 6,
  handoverImagesDailyLimit: 20,
  materialImageLimit: 6,
  materialImagesDailyLimit: 20,
};

async function countRows(sql, params, executor = db) {
  const [[row]] = await executor.query(sql, params);
  return Number(row?.total || 0);
}

function pruneWindowAttempts(attempts, windowMs) {
  const now = Date.now();
  while (attempts.length && now - attempts[0] > windowMs) attempts.shift();
  return attempts;
}

function checkRateLimit(store, key, { limit, windowMs }) {
  const attempts = pruneWindowAttempts(store.get(key) || [], windowMs);
  if (attempts.length >= limit) return false;
  attempts.push(Date.now());
  store.set(key, attempts);
  return true;
}

function maskPhone(phone) {
  const value = String(phone || '').trim();
  if (value.length < 7) return value;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}
const projectCodeLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function randomProjectCodeCandidate() {
  const letters = Array.from({ length: 2 }, () =>
    projectCodeLetters[Math.floor(Math.random() * projectCodeLetters.length)]
  ).join('');
  const digits = String(Math.floor(Math.random() * 100000000)).padStart(8, '0');
  return `${letters}${digits}`;
}

async function generateProjectCode(connection) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomProjectCodeCandidate();
    const [rows] = await connection.query(
      'SELECT id FROM renovation_projects WHERE project_code = ? LIMIT 1',
      [code]
    );
    if (!rows[0]) return code;
  }
  throw new Error('项目编号生成失败，请重试');
}

function normalizeProjectName(value) {
  const name = String(value || '').trim();
  if (!name || legacyInvalidProjectNames.has(name)) return defaultProjectName;
  return name;
}

async function canAccessProject(projectId, userId) {
  const [rows] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND status = 1
     LIMIT 1`,
    [projectId, userId]
  );
  if (rows[0]) return true;
  return canViewProjectAsCompanyAdmin(projectId, userId);
}

async function getProjectMemberRole(projectId, userId) {
  const [rows] = await db.query(
    `SELECT role FROM project_members
     WHERE project_id = ? AND user_id = ? AND status = 1
     ORDER BY FIELD(role, 'owner', 'owner_member', 'project_manager', 'project_supervisor', 'designer', 'merchant'),
              id ASC
     LIMIT 1`,
    [projectId, userId]
  );
  if (rows[0]?.role) return rows[0].role;
  return (await canViewProjectAsCompanyAdmin(projectId, userId)) ? companyAdminViewerRole : null;
}

async function canViewProjectAsCompanyAdmin(projectId, userId) {
  if (!projectId || !userId) return false;
  const [rows] = await db.query(
    `SELECT c.id
     FROM companies c
     LEFT JOIN company_members admin_cm
       ON admin_cm.company_id = c.id
      AND admin_cm.user_id = ?
      AND admin_cm.status = 'active'
      AND admin_cm.member_role IN ('owner', 'admin')
     WHERE c.status <> 'deleted'
       AND (c.owner_user_id = ? OR admin_cm.id IS NOT NULL)
       AND (
         EXISTS (
           SELECT 1
           FROM project_participants_ext ppe
           JOIN renovation_projects p
             ON p.id = ppe.project_id
            AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
           WHERE ppe.project_id = ?
             AND ppe.status <> 'removed'
             AND (
               ppe.company_id = c.id
               OR (ppe.participant_type = 'company' AND ppe.participant_id = c.id)
             )
         )
         OR EXISTS (
           SELECT 1
           FROM company_members service_cm
           JOIN project_members pm
             ON pm.user_id = service_cm.user_id
            AND pm.project_id = ?
            AND pm.status = 1
           JOIN renovation_projects p
             ON p.id = pm.project_id
            AND COALESCE(p.lifecycle_status, 'active') <> 'deleted'
           WHERE service_cm.company_id = c.id
             AND service_cm.status = 'active'
         )
       )
     LIMIT 1`,
    [userId, userId, projectId, projectId]
  );
  return Boolean(rows[0]);
}

function isOwnerSideRole(role) {
  return ownerSideRoles.has(role);
}

async function isOwnerSide(projectId, userId) {
  const role = await getProjectMemberRole(projectId, userId);
  return isOwnerSideRole(role);
}

function normalizeProjectLifecycle(project) {
  return project?.lifecycle_status || 'active';
}

async function getProjectLifecycle(projectId) {
  const [rows] = await db.query(
    'SELECT id, user_id, lifecycle_status FROM renovation_projects WHERE id = ? LIMIT 1',
    [projectId]
  );
  return rows[0] || null;
}

async function requireProjectActiveRoute(req, res, next) {
  const projectId = Number(req.params.id);
  if (!projectId) return next();
  const project = await getProjectLifecycle(projectId);
  if (!project) return error(res, '项目不存在', 404);
  if (normalizeProjectLifecycle(project) !== 'active') {
    return error(res, '项目已归档，不可继续操作', 409);
  }
  return next();
}

async function assertProjectActive(projectId) {
  const project = await getProjectLifecycle(projectId);
  if (!project) {
    const err = new Error('项目不存在');
    err.status = 404;
    throw err;
  }
  if (normalizeProjectLifecycle(project) !== 'active') {
    const err = new Error('项目已归档，不可继续操作');
    err.status = 409;
    throw err;
  }
}

async function getExistingColumnNames(tableName) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );
  return new Set(rows.map((row) => row.COLUMN_NAME));
}

async function projectDeletionBlockers(projectId, ownerId) {
  const defaultTasks = await getDefaultProgressTaskTemplates();
  const defaultTaskCount = defaultTasks.length;
  const taskColumns = await getExistingColumnNames('renovation_tasks');
  const taskConditions = [];
  if (taskColumns.has('actual_start')) taskConditions.push('actual_start IS NOT NULL');
  if (taskColumns.has('actual_end')) taskConditions.push('actual_end IS NOT NULL');
  if (taskColumns.has('status')) taskConditions.push('status = 3');
  if (taskColumns.has('remark')) {
    taskConditions.push("NULLIF(TRIM(COALESCE(remark, '')), '') IS NOT NULL");
  }
  if (taskColumns.has('updated_at') && taskColumns.has('created_at')) {
    taskConditions.push('updated_at > created_at');
  }
  taskConditions.push(`(
             SELECT COUNT(*) FROM renovation_tasks WHERE project_id = ?
           ) > ?`);
  const taskParams = [projectId, projectId, defaultTaskCount];
  const checks = [
    [
      'members',
      '存在其他项目成员',
      `SELECT id FROM project_members
       WHERE project_id = ? AND status = 1
         AND NOT (role = 'owner' AND user_id = ?)
       LIMIT 1`,
      [projectId, ownerId],
    ],
    ['designDocs', '已有设计资料', 'SELECT id FROM project_design_documents WHERE project_id = ? LIMIT 1', [projectId]],
    ['handovers', '已有设计交底', 'SELECT id FROM project_handovers WHERE project_id = ? LIMIT 1', [projectId]],
    [
      'tasks',
      '已有人工处理过的项目任务',
      `SELECT id FROM renovation_tasks
       WHERE project_id = ?
         AND (
           ${taskConditions.join('\n           OR ')}
         )
       LIMIT 1`,
      taskParams,
    ],
    ['progressItems', '已有项目进度事项', 'SELECT id FROM project_progress_items WHERE project_id = ? LIMIT 1', [projectId]],
    ['inspections', '已有验收记录', 'SELECT id FROM project_inspections WHERE project_id = ? LIMIT 1', [projectId]],
    ['actionItems', '已有待办事项', 'SELECT id FROM project_action_items WHERE project_id = ? LIMIT 1', [projectId]],
    ['checkIns', '已有工地打卡', 'SELECT id FROM project_checkins WHERE project_id = ? LIMIT 1', [projectId]],
    ['expenses', '已有费用记录', 'SELECT id FROM project_expenses WHERE project_id = ? LIMIT 1', [projectId]],
    ['materials', '已有材料记录', 'SELECT id FROM project_material_items WHERE project_id = ? LIMIT 1', [projectId]],
    [
      'events',
      '已有协同通知事件',
      `SELECT id FROM project_action_notifications
       WHERE event_type = 'project_event'
         AND JSON_VALID(payload)
         AND (
           CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.projectId')) AS UNSIGNED) = ?
           OR CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.project_id')) AS UNSIGNED) = ?
         )
       LIMIT 1`,
      [projectId, projectId],
    ],
  ];
  const blockers = [];
  for (const [key, reason, sql, params] of checks) {
    try {
      const [rows] = await db.query(sql, params);
      if (rows[0]) blockers.push({ key, reason });
    } catch (checkError) {
      // Optional tables may not exist in older deployments; ignore those checks.
      if (checkError.code !== 'ER_NO_SUCH_TABLE') throw checkError;
    }
  }
  return blockers;
}

async function ensureDefaultProjectSpaces(projectId, userId) {
  const [spaces] = await db.query(
    'SELECT id FROM project_spaces WHERE project_id = ? LIMIT 1',
    [projectId]
  );
  if (spaces[0]) return;
  const values = defaultProjectSpaces.map((name, index) => [
    projectId,
    name,
    index,
    userId,
  ]);
  await db.query(
    `INSERT IGNORE INTO project_spaces
       (project_id, name, sort_order, is_default, created_by)
     VALUES ${values.map(() => '(?, ?, ?, 1, ?)').join(', ')}`,
    values.flat()
  );
}

async function upsertProjectMember(connection, projectId, userId, role) {
  await connection.query(
    `INSERT INTO project_members
       (project_id, user_id, role, status, permissions)
     VALUES (?, ?, ?, 1, ?)
     ON DUPLICATE KEY UPDATE
       status = 1,
       permissions = VALUES(permissions),
       updated_at = NOW()`,
    [projectId, userId, role, JSON.stringify(memberPermissions[role] || {})]
  );
}

function dateOnly(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function localDateOnly(value) {
  const date = new Date(value);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function addDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date;
}

function deriveProgressFromTasks(tasks, fallbackStage, fallbackStatus) {
  if (!tasks.length) return { current_stage: fallbackStage, status: fallbackStatus };
  let currentStage = stages[stages.length - 1].id;
  let allCompleted = true;
  for (const stage of stages) {
    const stageTasks = tasks.filter((task) => Number(task.stage_id) === stage.id);
    if (!stageTasks.length) continue;
    if (stageTasks.some((task) => Number(task.status) !== 2)) {
      currentStage = stage.id;
      allCompleted = false;
      break;
    }
  }
  return {
    current_stage: currentStage,
    status: allCompleted ? 2 : Number(fallbackStatus) === 3 ? 3 : 1,
  };
}

async function findProject(userId) {
  const [rows] = await db.query(
    `SELECT p.*, u.nickname AS designer_name
     FROM renovation_projects p
     LEFT JOIN users u ON p.designer_id = u.id
     WHERE p.user_id = ?
       AND COALESCE(p.lifecycle_status, 'active') = 'active'
     ORDER BY p.created_at DESC, p.id DESC
     LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function calendarForProject(project) {
  const [tasks] = await db.query(
    `SELECT id, stage_id, task_name, is_key, planned_start, planned_end,
            actual_start, actual_end, status, remark
     FROM renovation_tasks
     WHERE project_id = ?
     ORDER BY stage_id, planned_start, id`,
    [project.id]
  );
  const grouped = {};
  for (const stage of stages) grouped[stage.id] = [];
  for (const task of tasks) {
    task.is_key = task.is_key ? 1 : 0;
    grouped[task.stage_id].push(task);
  }
  const derivedProgress = deriveProgressFromTasks(
    tasks,
    project.current_stage,
    project.status
  );
  return {
    project: {
      id: project.id,
      project_code: project.project_code,
      project_name: normalizeProjectName(project.project_name),
      house_area: Number(project.house_area),
      start_date: project.start_date,
      total_days: project.total_days,
      current_stage: derivedProgress.current_stage,
      status: derivedProgress.status,
      lifecycle_status: normalizeProjectLifecycle(project),
      archived_at: project.archived_at || null,
      pace_mode: project.pace_mode || 'normal',
      pace_updated_at: project.pace_updated_at,
      project_type: project.project_type,
      house_layout: project.house_layout,
      floor_plan_image: project.floor_plan_image,
      renovation_method: project.renovation_method,
      budget_range: project.budget_range,
      expected_move_in_date: project.expected_move_in_date,
      resident_info: project.resident_info,
      lifestyle_notes: project.lifestyle_notes,
      style_preference: project.style_preference,
      key_spaces: project.key_spaces,
      special_needs: project.special_needs,
      designer_id: project.designer_id,
      designer_name: project.designer_name || null,
    },
    stages: grouped,
    all_stages: stages,
  };
}

async function getStages(req, res) {
  return success(res, stages);
}

async function getDefaultProgressTaskTemplates(connection = db) {
  const [rows] = await connection.query(
    `SELECT template_key, stage_id, title, is_key_node, sort_order
     FROM renovation_work_item_templates
     WHERE is_active = 1 AND default_join = 1
     ORDER BY stage_id, sort_order, id`
  );
  if (rows.length) return rows;
  return stages.flatMap((stage) =>
    (taskNames[stage.id] || []).map((title, index) => ({
      template_key: `legacy_stage_${stage.id}_${index + 1}`,
      stage_id: stage.id,
      title,
      is_key_node: index === 0 ? 1 : 0,
      sort_order: stage.id * 1000 + (index + 1) * 10,
    }))
  );
}

async function setup(req, res) {
  const {
    start_date: startDate,
    project_name: projectNameRaw,
    house_area: houseArea,
    current_stage: currentStage,
    create_new: createNew,
    project_type: projectType,
    house_layout: houseLayout,
    floor_plan_image: floorPlanImage,
    renovation_method: renovationMethod,
  } = req.body;
  const projectName = String(projectNameRaw || '').trim().slice(0, 10);
  const area = Number(houseArea);
  const stageId = Number(currentStage);
  if (!projectName) return error(res, '请输入项目名称');
  if (!startDate || Number.isNaN(Date.parse(startDate))) return error(res, '开工日期格式不正确');
  if (!Number.isFinite(area) || area <= 0) return error(res, '房屋面积不正确');
  if (!stages.some((stage) => stage.id === stageId)) return error(res, '装修阶段不正确');
  if (projectType && !['refined', 'rough', 'second_hand', 'partial', 'office', 'commercial'].includes(projectType)) {
    return error(res, '项目类型不正确');
  }
  if (renovationMethod && !['self', 'company', 'independent_designer'].includes(renovationMethod)) {
    return error(res, '装修方式不正确');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = createNew
      ? [[]]
      : await connection.query(
          `SELECT id FROM renovation_projects
           WHERE user_id = ?
             AND COALESCE(lifecycle_status, 'active') = 'active'
           ORDER BY created_at DESC, id DESC
           LIMIT 1 FOR UPDATE`,
          [req.user.id]
        );
    let projectId;
    if (existing[0]) {
      projectId = existing[0].id;
      await connection.query('DELETE FROM renovation_tasks WHERE project_id = ?', [projectId]);
      await connection.query(
        `UPDATE renovation_projects
         SET project_name = ?, house_area = ?, start_date = ?, current_stage = ?, status = 1,
             project_type = ?, house_layout = ?, floor_plan_image = ?,
             renovation_method = ?
         WHERE id = ?`,
        [
          projectName,
          area,
          startDate,
          stageId,
          projectType || null,
          houseLayout || null,
          floorPlanImage || null,
          renovationMethod || 'self',
          projectId,
        ]
      );
    } else {
      const projectCode = await generateProjectCode(connection);
      const [result] = await connection.query(
        `INSERT INTO renovation_projects
         (user_id, project_code, project_name, house_area, start_date, total_days, current_stage, status,
          project_type, house_layout, floor_plan_image, renovation_method)
         VALUES (?, ?, ?, ?, ?, 82, ?, 1, ?, ?, ?, ?)`,
        [
          req.user.id,
          projectCode,
          projectName,
          area,
          startDate,
          stageId,
          projectType || null,
          houseLayout || null,
          floorPlanImage || null,
          renovationMethod || 'self',
        ]
      );
      projectId = result.insertId;
    }
    await upsertProjectMember(
      connection,
      projectId,
      req.user.id,
      'owner'
    );

    let cursor = new Date(`${startDate}T00:00:00Z`);
    const defaultTasks = await getDefaultProgressTaskTemplates(connection);
    const defaultTasksByStage = new Map();
    for (const item of defaultTasks) {
      const key = Number(item.stage_id);
      if (!defaultTasksByStage.has(key)) defaultTasksByStage.set(key, []);
      defaultTasksByStage.get(key).push(item);
    }
    for (const stage of stages) {
      const items = defaultTasksByStage.get(stage.id) || [];
      if (!items.length) continue;
      const taskDays = Math.ceil(stage.days / items.length);
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];
        const plannedStart = cursor;
        const plannedEnd = addDays(cursor, taskDays - 1);
        await connection.query(
          `INSERT INTO renovation_tasks
           (project_id, stage_id, task_name, is_key, planned_start, planned_end, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            projectId,
            stage.id,
            item.title,
            Number(item.is_key_node) ? 1 : 0,
            dateOnly(plannedStart),
            dateOnly(plannedEnd),
            stage.id < stageId ? 2 : 0,
          ]
        );
        cursor = addDays(plannedEnd, 1);
      }
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const project = await findProject(req.user.id);
  return success(res, await calendarForProject(project), '建档成功');
}

async function uploadFloorPlan(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  if (!req.file) return error(res, '请选择户型图片');
  const imageUrl = storageService.uploadedFileUrl(
    req,
    req.file,
    `/uploads/floor-plans/${req.file.filename}`
  );
  return success(res, { url: imageUrl }, '上传成功');
}

async function getCalendar(req, res) {
  const project = await findProject(req.user.id);
  if (!project) return success(res, null);
  return success(res, await calendarForProject(project));
}

async function getStageDetail(req, res) {
  const project = await findProject(req.user.id);
  if (!project) return error(res, '装修档案不存在', 404);
  const [tasks] = await db.query(
    `SELECT id, stage_id, task_name, is_key, planned_start, planned_end,
            actual_start, actual_end, status, remark
     FROM renovation_tasks WHERE project_id = ? AND stage_id = ?
     ORDER BY planned_start, id`,
    [project.id, Number(req.params.stageId)]
  );
  return success(res, { tasks });
}

async function updateTask(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const [tasks] = await db.query(
    'SELECT project_id FROM renovation_tasks WHERE id = ?',
    [Number(req.params.taskId)]
  );
  if (!tasks[0]) return error(res, '任务不存在', 404);
  req.params.id = String(tasks[0].project_id);
  return planProjectTask(req, res);
}

async function completeStage(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const project = await findProject(req.user.id);
  if (!project) return error(res, '装修档案不存在', 404);
  const stageId = Number(req.params.stageId);
  const nextStage = Math.min(stageId + 1, stages.length);
  await db.query(
    'UPDATE renovation_tasks SET status = 2, actual_end = COALESCE(actual_end, CURDATE()) WHERE project_id = ? AND stage_id = ?',
    [project.id, stageId]
  );
  const progress = await refreshProjectStageByTaskCompletion(project.id);
  return success(res, progress || { current_stage: nextStage });
}

async function updateInfo(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const project = await findProject(req.user.id);
  if (!project) return error(res, '装修档案不存在', 404);
  const area = req.body.house_area === undefined ? project.house_area : Number(req.body.house_area);
  const startDate = req.body.start_date || project.start_date;
  if (!Number.isFinite(Number(area)) || Number(area) <= 0) return error(res, '房屋面积不正确');
  if (Number.isNaN(Date.parse(startDate))) return error(res, '开工日期格式不正确');
  await db.query(
    'UPDATE renovation_projects SET house_area = ?, start_date = ? WHERE id = ?',
    [area, startDate, project.id]
  );
  const updated = await findProject(req.user.id);
  return success(res, await calendarForProject(updated));
}

async function updateProjectInfo(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以修改项目信息', 403);
  }
  const [projects] = await db.query(
    'SELECT * FROM renovation_projects WHERE id = ?',
    [projectId]
  );
  const project = projects[0];
  if (!project) return error(res, '项目不存在', 404);

  const values = buildProjectInfoValues(project, req.body);
  const validationError = validateProjectInfoValues(values);
  if (validationError) return error(res, validationError);

  await applyProjectInfoValues(projectId, values);
  const [updated] = await db.query(
    `SELECT p.*, u.nickname AS designer_name
     FROM renovation_projects p
     LEFT JOIN users u ON p.designer_id = u.id
     WHERE p.id = ?`,
    [projectId]
  );
  return success(res, await calendarForProject(updated[0]));
}

function buildProjectInfoValues(project, body) {
  const area =
    body.house_area === undefined
      ? project.house_area
      : Number(body.house_area);
  const projectName =
    body.project_name === undefined
      ? project.project_name
      : String(body.project_name || '').trim().slice(0, 10);
  const houseLayout =
    body.house_layout === undefined
      ? project.house_layout
      : String(body.house_layout || '').trim().slice(0, 120) || null;
  const floorPlanImage =
    body.floor_plan_image === undefined
      ? project.floor_plan_image
      : String(body.floor_plan_image || '').trim() || null;
  const budgetRange =
    body.budget_range === undefined
      ? project.budget_range
      : String(body.budget_range || '').trim().slice(0, 80) || null;
  const expectedMoveInDate =
    body.expected_move_in_date === undefined
      ? project.expected_move_in_date
      : String(body.expected_move_in_date || '').trim() || null;
  const residentInfo =
    body.resident_info === undefined
      ? project.resident_info
      : String(body.resident_info || '').trim().slice(0, 255) || null;
  const lifestyleNotes =
    body.lifestyle_notes === undefined
      ? project.lifestyle_notes
      : String(body.lifestyle_notes || '').trim().slice(0, 1000) || null;
  const stylePreference =
    body.style_preference === undefined
      ? project.style_preference
      : String(body.style_preference || '').trim().slice(0, 255) || null;
  const keySpaces =
    body.key_spaces === undefined
      ? project.key_spaces
      : String(body.key_spaces || '').trim().slice(0, 255) || null;
  const specialNeeds =
    body.special_needs === undefined
      ? project.special_needs
      : String(body.special_needs || '').trim().slice(0, 1000) || null;

  return {
    projectName,
    area,
    houseLayout,
    floorPlanImage,
    budgetRange,
    expectedMoveInDate,
    residentInfo,
    lifestyleNotes,
    stylePreference,
    keySpaces,
    specialNeeds,
  };
}

function validateProjectInfoValues(values) {
  if (!values.projectName) return '请输入项目名称';
  if (!Number.isFinite(Number(values.area)) || Number(values.area) <= 0) {
    return '房屋面积不正确';
  }
  return null;
}

async function applyProjectInfoValues(projectId, values, connection = db) {
  await connection.query(
    `UPDATE renovation_projects
     SET project_name = ?, house_area = ?, house_layout = ?, floor_plan_image = ?,
         budget_range = ?, expected_move_in_date = ?, resident_info = ?,
         lifestyle_notes = ?, style_preference = ?, key_spaces = ?, special_needs = ?
     WHERE id = ?`,
    [
      values.projectName,
      values.area,
      values.houseLayout,
      values.floorPlanImage,
      values.budgetRange,
      values.expectedMoveInDate || null,
      values.residentInfo,
      values.lifestyleNotes,
      values.stylePreference,
      values.keySpaces,
      values.specialNeeds,
      projectId,
    ]
  );
}

function projectInfoRequestPayload(body) {
  const allowed = [
    'project_name',
    'house_area',
    'house_layout',
    'floor_plan_image',
    'budget_range',
    'expected_move_in_date',
    'resident_info',
    'lifestyle_notes',
    'style_preference',
    'key_spaces',
    'special_needs',
  ];
  const payload = {};
  for (const key of allowed) {
    if (body[key] !== undefined) payload[key] = body[key];
  }
  return payload;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function parseJsonArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const projectShowcaseDefaultFields = {
  project_name: true,
  owner_city: true,
  house_area: true,
  house_layout: true,
  project_type: true,
  renovation_method: true,
  start_date: true,
  total_days: true,
  current_stage: true,
  style_preference: true,
  key_spaces: true,
  special_needs: true,
};

function normalizeShowcaseVisibleFields(input) {
  if (Array.isArray(input)) {
    return input.reduce((result, key) => {
      const normalized = String(key || '').trim();
      if (normalized) result[normalized] = true;
      return result;
    }, {});
  }
  const parsed = parseJsonObject(input);
  return Object.entries(parsed).reduce((result, [key, value]) => {
    const normalized = String(key || '').trim();
    if (normalized) result[normalized] = Boolean(value);
    return result;
  }, {});
}

function mapProjectShowcaseRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    owner_user_id: Number(row.owner_user_id),
    title: row.title || '',
    description: row.description || '',
    cover_image: row.cover_image || '',
    visibility: row.visibility || 'private',
    status: row.status || 'draft',
    visible_fields: {
      ...projectShowcaseDefaultFields,
      ...parseJsonObject(row.visible_fields),
    },
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function mapProjectShowcaseImage(row) {
  return {
    id: Number(row.id),
    showcase_id: Number(row.showcase_id),
    source_type: row.source_type || 'manual',
    source_id: row.source_id ? Number(row.source_id) : null,
    image_url: row.image_url || '',
    caption: row.caption || '',
    sort_order: Number(row.sort_order || 0),
    is_cover: Boolean(row.is_cover),
  };
}

function mapProjectShowcaseImageCandidate(row) {
  return {
    source_type: row.source_type || 'manual',
    source_id: row.source_id ? Number(row.source_id) : null,
    image_url: row.image_url || '',
    caption: row.caption || '',
    space_name: row.space_name || '',
    image_type: row.image_type || '',
    is_primary: Boolean(row.is_primary),
  };
}

function buildProjectShowcaseDefaults(project) {
  const title = normalizeProjectName(project.project_name);
  const needs = [
    project.style_preference ? `风格偏好：${project.style_preference}` : '',
    project.key_spaces ? `重点空间：${project.key_spaces}` : '',
    project.special_needs ? `特殊需求：${project.special_needs}` : '',
  ].filter(Boolean);
  return {
    title,
    description: needs.join('\n'),
    cover_image: project.floor_plan_image || '',
    visibility: 'private',
    status: 'draft',
    visible_fields: projectShowcaseDefaultFields,
  };
}

async function getProjectForShowcase(projectId, userId, ownerOnly = false) {
  const roleSql = ownerOnly ? "AND pm.role = 'owner'" : '';
  const [rows] = await db.query(
    `SELECT p.*, owner.nickname AS owner_nickname, owner.city AS owner_city,
            pm.role AS member_role
     FROM renovation_projects p
     JOIN users owner ON owner.id = p.user_id
     JOIN project_members pm
       ON pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1 ${roleSql}
     WHERE p.id = ?
       AND COALESCE(p.lifecycle_status, 'active') != 'deleted'
     LIMIT 1`,
    [userId, projectId]
  );
  return rows[0] || null;
}

function mapProjectShowcaseBaseProject(project) {
  const stage = stages.find((item) => item.id === Number(project.current_stage));
  return {
    id: Number(project.id),
    project_code: project.project_code,
    project_name: normalizeProjectName(project.project_name),
    owner_city: project.owner_city || '',
    house_area: Number(project.house_area || 0),
    house_layout: project.house_layout || '',
    project_type: project.project_type || '',
    renovation_method: project.renovation_method || '',
    start_date: project.start_date,
    total_days: Number(project.total_days || 0),
    current_stage: Number(project.current_stage || 1),
    current_stage_name: stage?.name || `第 ${project.current_stage || 1} 阶段`,
    style_preference: project.style_preference || '',
    key_spaces: project.key_spaces || '',
    special_needs: project.special_needs || '',
    floor_plan_image: project.floor_plan_image || '',
  };
}

async function fetchProjectShowcase(showcaseId) {
  const [[row]] = await db.query(
    `SELECT * FROM project_showcases WHERE id = ? LIMIT 1`,
    [showcaseId]
  );
  return mapProjectShowcaseRow(row);
}

async function fetchProjectShowcaseByProject(projectId) {
  const [[row]] = await db.query(
    `SELECT * FROM project_showcases WHERE project_id = ? LIMIT 1`,
    [projectId]
  );
  return mapProjectShowcaseRow(row);
}

async function fetchProjectShowcaseImages(showcaseId) {
  const [rows] = await db.query(
    `SELECT *
     FROM project_showcase_images
     WHERE showcase_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [showcaseId]
  );
  return rows.map(mapProjectShowcaseImage);
}

async function ensureProjectShowcase(project) {
  let showcase = await fetchProjectShowcaseByProject(project.id);
  if (showcase) return showcase;
  const defaults = buildProjectShowcaseDefaults(project);
  const [result] = await db.query(
    `INSERT INTO project_showcases
       (project_id, owner_user_id, title, description, cover_image, visibility, status, visible_fields)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      project.id,
      project.user_id,
      defaults.title,
      defaults.description,
      defaults.cover_image,
      defaults.visibility,
      defaults.status,
      JSON.stringify(defaults.visible_fields),
    ]
  );
  return fetchProjectShowcase(result.insertId);
}

async function getProjectShowcase(req, res) {
  const projectId = Number(req.params.id);
  const project = await getProjectForShowcase(projectId, req.user.id, true);
  if (!project) return error(res, '只有项目业主可以管理展示页', 403);
  const showcase = await ensureProjectShowcase(project);
  const images = await fetchProjectShowcaseImages(showcase.id);
  return success(res, {
    project: mapProjectShowcaseBaseProject(project),
    showcase,
    images,
  });
}

async function updateProjectShowcase(req, res) {
  const projectId = Number(req.params.id);
  const project = await getProjectForShowcase(projectId, req.user.id, true);
  if (!project) return error(res, '只有项目业主可以管理展示页', 403);
  const showcase = await ensureProjectShowcase(project);
  const title = String(req.body.title || '').trim().slice(0, 120);
  if (!title) return error(res, '展示标题不能为空');
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const coverImage = String(req.body.cover_image || '').trim().slice(0, 500);
  const visibility = ['private', 'participants', 'public'].includes(req.body.visibility)
    ? req.body.visibility
    : 'private';
  const status = ['draft', 'published', 'hidden'].includes(req.body.status)
    ? req.body.status
    : showcase.status;
  const visibleFields = normalizeShowcaseVisibleFields(req.body.visible_fields);
  const images = parseJsonArray(req.body.images)
    .map((item, index) => ({
      sourceType: ['floor_plan', 'project_space_image', 'manual'].includes(item?.source_type)
        ? item.source_type
        : 'manual',
      sourceId: item?.source_id ? Number(item.source_id) : null,
      imageUrl: String(item?.image_url || '').trim().slice(0, 500),
      caption: String(item?.caption || '').trim().slice(0, 120),
      sortOrder: Number.isFinite(Number(item?.sort_order)) ? Number(item.sort_order) : index,
      isCover: Boolean(item?.is_cover),
    }))
    .filter((item) => item.imageUrl)
    .slice(0, 30);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE project_showcases
       SET title = ?, description = ?, cover_image = ?, visibility = ?,
           status = ?, visible_fields = ?
       WHERE id = ?`,
      [
        title,
        description || null,
        coverImage || null,
        visibility,
        status,
        JSON.stringify({ ...projectShowcaseDefaultFields, ...visibleFields }),
        showcase.id,
      ]
    );
    await connection.query(
      'DELETE FROM project_showcase_images WHERE showcase_id = ?',
      [showcase.id]
    );
    if (images.length) {
      await connection.query(
        `INSERT INTO project_showcase_images
           (showcase_id, source_type, source_id, image_url, caption, sort_order, is_cover)
         VALUES ${images.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        images.flatMap((item) => [
          showcase.id,
          item.sourceType,
          item.sourceId,
          item.imageUrl,
          item.caption || null,
          item.sortOrder,
          item.isCover ? 1 : 0,
        ])
      );
    }
    await connection.commit();
  } catch (saveError) {
    await connection.rollback();
    return error(res, saveError.message || '保存展示页失败');
  } finally {
    connection.release();
  }

  return getProjectShowcase(req, res);
}

async function publishProjectShowcase(req, res) {
  const projectId = Number(req.params.id);
  const project = await getProjectForShowcase(projectId, req.user.id, true);
  if (!project) return error(res, '只有项目业主可以管理展示页', 403);
  const showcase = await ensureProjectShowcase(project);
  await db.query(
    `UPDATE project_showcases SET status = 'published' WHERE id = ?`,
    [showcase.id]
  );
  return success(res, { id: showcase.id, status: 'published' }, '展示页已发布');
}

async function hideProjectShowcase(req, res) {
  const projectId = Number(req.params.id);
  const project = await getProjectForShowcase(projectId, req.user.id, true);
  if (!project) return error(res, '只有项目业主可以管理展示页', 403);
  const showcase = await ensureProjectShowcase(project);
  await db.query(
    `UPDATE project_showcases SET status = 'hidden' WHERE id = ?`,
    [showcase.id]
  );
  return success(res, { id: showcase.id, status: 'hidden' }, '展示页已隐藏');
}

async function getProjectShowcaseImageCandidates(req, res) {
  const projectId = Number(req.params.id);
  const project = await getProjectForShowcase(projectId, req.user.id, true);
  if (!project) return error(res, '只有项目业主可以管理展示页', 403);
  const candidates = [];
  if (project.floor_plan_image) {
    candidates.push({
      source_type: 'floor_plan',
      source_id: null,
      image_url: project.floor_plan_image,
      caption: '户型图',
      space_name: '',
      image_type: 'floor_plan',
      is_primary: true,
    });
  }
  const [rows] = await db.query(
    `SELECT 'project_space_image' AS source_type,
            psi.id AS source_id,
            psi.image_url,
            ps.name AS space_name,
            psi.image_type,
            psi.is_primary,
            CONCAT(ps.name, CASE psi.image_type WHEN 'rendering' THEN '效果图' ELSE '现场图' END) AS caption
     FROM project_space_images psi
     JOIN project_spaces ps ON ps.id = psi.space_id
     WHERE ps.project_id = ?
     ORDER BY psi.is_primary DESC, ps.sort_order ASC, psi.sort_order ASC, psi.id DESC`,
    [projectId]
  );
  return success(res, [...candidates, ...rows.map(mapProjectShowcaseImageCandidate)]);
}

async function getPublishedProjectShowcase(req, res) {
  const showcaseId = Number(req.params.id);
  const [[row]] = await db.query(
    `SELECT showcase.id AS showcase_id, showcase.project_id, showcase.owner_user_id,
            showcase.title, showcase.description, showcase.cover_image,
            showcase.visibility, showcase.status AS showcase_status,
            showcase.visible_fields, showcase.created_at AS showcase_created_at,
            showcase.updated_at AS showcase_updated_at,
            p.id, p.project_code, p.project_name, p.house_area, p.start_date,
            p.total_days, p.current_stage, p.project_type, p.house_layout,
            p.floor_plan_image, p.renovation_method, p.style_preference,
            p.key_spaces, p.special_needs, p.lifecycle_status,
            owner.city AS owner_city
     FROM project_showcases showcase
     JOIN renovation_projects p ON p.id = showcase.project_id
     JOIN users owner ON owner.id = p.user_id
     WHERE showcase.id = ?
       AND showcase.status = 'published'
       AND COALESCE(p.lifecycle_status, 'active') != 'deleted'
     LIMIT 1`,
    [showcaseId]
  );
  if (!row) return error(res, '展示页不存在或未发布', 404);
  const showcase = mapProjectShowcaseRow({
    id: row.showcase_id,
    project_id: row.project_id,
    owner_user_id: row.owner_user_id,
    title: row.title,
    description: row.description,
    cover_image: row.cover_image,
    visibility: row.visibility,
    status: row.showcase_status,
    visible_fields: row.visible_fields,
    created_at: row.showcase_created_at,
    updated_at: row.showcase_updated_at,
  });
  if (showcase.visibility === 'private' && Number(showcase.owner_user_id) !== Number(req.user?.id)) {
    return error(res, '无权查看展示页', 403);
  }
  if (showcase.visibility === 'participants') {
    const canView =
      Number(showcase.owner_user_id) === Number(req.user?.id) ||
      (req.user?.id && await canAccessProject(row.project_id, req.user.id));
    if (!canView) return error(res, '无权查看展示页', 403);
  }
  const images = await fetchProjectShowcaseImages(showcase.id);
  return success(res, {
    project: mapProjectShowcaseBaseProject(row),
    showcase,
    images,
  });
}

async function getProjectInfoChangeRequests(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  const params = [projectId];
  let visibilitySql = '';
  if (!isOwnerSideRole(role)) {
    visibilitySql = 'AND request.requester_id = ?';
    params.push(req.user.id);
  }
  const [rows] = await db.query(
    `SELECT request.id, request.project_id, request.requester_id,
            request.status, request.proposed_changes, request.review_message,
            request.reviewer_id, request.reviewed_at,
            request.created_at, request.updated_at,
            requester.nickname AS requester_name,
            reviewer.nickname AS reviewer_name
     FROM project_info_change_requests request
     JOIN users requester ON requester.id = request.requester_id
     LEFT JOIN users reviewer ON reviewer.id = request.reviewer_id
     WHERE request.project_id = ?
       ${visibilitySql}
     ORDER BY CASE request.status WHEN 0 THEN 0 ELSE 1 END,
              request.updated_at DESC, request.id DESC
     LIMIT 30`,
    params
  );
  return success(
    res,
    rows.map((row) => ({
      ...row,
      proposed_changes: parseJsonObject(row.proposed_changes),
    }))
  );
}

async function createProjectInfoChangeRequest(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  if (isOwnerSideRole(role)) return error(res, '业主方可以直接修改项目档案');
  const payload = projectInfoRequestPayload(req.body);
  if (Object.keys(payload).length === 0) return error(res, '没有可提交的修改内容');
  const [projects] = await db.query(
    'SELECT * FROM renovation_projects WHERE id = ?',
    [projectId]
  );
  const project = projects[0];
  if (!project) return error(res, '项目不存在', 404);
  const values = buildProjectInfoValues(project, payload);
  const validationError = validateProjectInfoValues(values);
  if (validationError) return error(res, validationError);

  await db.query(
    `INSERT INTO project_info_change_requests
       (project_id, requester_id, status, proposed_changes)
     VALUES (?, ?, 0, ?)`,
    [projectId, req.user.id, JSON.stringify(payload)]
  );
  return success(res, null, '修改申请已提交，等待业主确认');
}

async function handleProjectInfoChangeRequest(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  const action = String(req.body.action || '');
  const reviewMessage = req.body.review_message
    ? String(req.body.review_message).trim().slice(0, 300)
    : null;
  if (!['accept', 'reject'].includes(action)) {
    return error(res, '操作必须是 accept 或 reject');
  }
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以处理档案修改申请', 403);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT request.id AS request_id,
              request.proposed_changes,
              project.*
       FROM project_info_change_requests request
       JOIN renovation_projects project ON project.id = request.project_id
       WHERE request.id = ? AND request.project_id = ? AND request.status = 0
       FOR UPDATE`,
      [requestId, projectId]
    );
    const row = rows[0];
    if (!row) {
      await connection.rollback();
      return error(res, '申请不存在或已处理', 404);
    }
    const newStatus = action === 'accept' ? 1 : 2;
    if (action === 'accept') {
      const payload = parseJsonObject(row.proposed_changes);
      const values = buildProjectInfoValues(row, payload);
      const validationError = validateProjectInfoValues(values);
      if (validationError) {
        await connection.rollback();
        return error(res, validationError);
      }
      await applyProjectInfoValues(projectId, values, connection);
    }
    await connection.query(
      `UPDATE project_info_change_requests
       SET status = ?, reviewer_id = ?, review_message = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [newStatus, req.user.id, reviewMessage, requestId]
    );
    await connection.commit();
    return success(
      res,
      { status: newStatus },
      action === 'accept' ? '已同意档案修改' : '已拒绝档案修改'
    );
  } catch (requestError) {
    await connection.rollback();
    throw requestError;
  } finally {
    connection.release();
  }
}

async function resetProject(req, res) {
  const project = await findProject(req.user.id);
  if (!project) return error(res, '装修档案不存在', 404);
  const blockers = await projectDeletionBlockers(project.id, req.user.id);
  if (blockers.length) {
    return error(
      res,
      `项目已有协同数据，不能删除，可归档项目。原因：${blockers[0].reason}`,
      409,
      { blockers }
    );
  }
  await db.query(
    `UPDATE renovation_projects
     SET lifecycle_status = 'deleted', deleted_at = NOW(), deleted_by = ?, updated_at = NOW()
     WHERE id = ? AND user_id = ? AND COALESCE(lifecycle_status, 'active') = 'active'`,
    [req.user.id, project.id, req.user.id]
  );
  return success(res, null, '装修档案已删除');
}

async function archiveProject(req, res) {
  const projectId = Number(req.params.id);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有主业主可以归档项目', 403);
  }
  const [result] = await db.query(
    `UPDATE renovation_projects
     SET lifecycle_status = 'archived', archived_at = NOW(), archived_by = ?, updated_at = NOW()
     WHERE id = ? AND user_id = ? AND COALESCE(lifecycle_status, 'active') = 'active'`,
    [req.user.id, projectId, req.user.id]
  );
  if (result.affectedRows === 0) return error(res, '项目不存在或已归档', 404);
  return success(res, { project_id: projectId, lifecycle_status: 'archived' }, '项目已归档');
}

async function restoreProject(req, res) {
  const projectId = Number(req.params.id);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有主业主可以恢复项目', 403);
  }
  const [result] = await db.query(
    `UPDATE renovation_projects
     SET lifecycle_status = 'active',
         archived_at = NULL,
         archived_by = NULL,
         updated_at = NOW()
     WHERE id = ? AND user_id = ? AND COALESCE(lifecycle_status, 'active') = 'archived'`,
    [projectId, req.user.id]
  );
  if (result.affectedRows === 0) return error(res, '项目不存在或未归档', 404);
  return success(res, { project_id: projectId, lifecycle_status: 'active' }, '项目已恢复');
}

async function deleteProject(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有主业主可以删除项目', 403);
  }
  const [projects] = await db.query(
    `SELECT id, user_id, lifecycle_status
     FROM renovation_projects
     WHERE id = ? AND user_id = ? AND COALESCE(lifecycle_status, 'active') != 'deleted'
     LIMIT 1`,
    [projectId, req.user.id]
  );
  const project = projects[0];
  if (!project) return error(res, '项目不存在', 404);
  const blockers = await projectDeletionBlockers(projectId, req.user.id);
  if (blockers.length) {
    return error(
      res,
      `项目已有协同数据，不能删除，可归档项目。原因：${blockers[0].reason}`,
      409,
      { blockers }
    );
  }
  await db.query(
    `UPDATE renovation_projects
     SET lifecycle_status = 'deleted', deleted_at = NOW(), deleted_by = ?, updated_at = NOW()
     WHERE id = ? AND user_id = ?`,
    [req.user.id, projectId, req.user.id]
  );
  return success(res, { project_id: projectId, lifecycle_status: 'deleted' }, '项目已删除');
}

// 浏览所有用户（业主用来找潜在设计师）
async function listUsers(req, res) {
  const params = [];
  let where = '1=1';
  if (req.query.keyword) {
    where += ' AND (nickname LIKE ? OR phone LIKE ?)';
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw);
  }
  if (req.query.city) {
    where += ' AND city = ?';
    params.push(req.query.city);
  }
  // 排除自己
  where += ' AND id != ?';
  params.push(req.user.id);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset = (page - 1) * pageSize;
  const [rows] = await db.query(
    `SELECT id, nickname, avatar, city, bio, role FROM users WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );
  const [countRows] = await db.query(
    `SELECT COUNT(*) AS total FROM users WHERE ${where}`,
    params
  );
  return success(res, { users: rows, total: countRows[0].total, page, pageSize });
}

// 发送设计师申请（业主→用户）
async function requestDesigner(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const designerId = Number(req.body.designer_id);
  const projectId = Number(req.body.project_id);
  const message = req.body.message ? String(req.body.message).slice(0, 300) : null;
  if (!designerId) return error(res, '设计师ID不能为空');
  if (!projectId) return error(res, '项目ID不能为空');
  if (designerId === req.user.id) return error(res, '不能申请自己');
  // 确认对方存在
  const [users] = await db.query(
    `SELECT u.id FROM users u
     JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'designer'
     WHERE u.id = ?`,
    [designerId]
  );
  if (!users[0]) return error(res, '该用户不是设计师账号', 400);
  const [projects] = await db.query(
    `SELECT id, designer_id FROM renovation_projects
     WHERE id = ? AND user_id = ?
       AND COALESCE(lifecycle_status, 'active') = 'active'`,
    [projectId, req.user.id]
  );
  if (!projects[0]) return error(res, '项目不存在', 404);
  if (projects[0].designer_id) return error(res, '该项目已经关联设计师', 400);
  // 同一项目向同一设计师只保留一条申请，拒绝后可重新发送。
  await db.query(
    `INSERT INTO designer_requests (owner_id, designer_id, project_id, status, message)
     VALUES (?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE
       status = 0,
       message = VALUES(message),
       updated_at = NOW()`,
    [req.user.id, designerId, projectId, message]
  );
  return success(res, { designer_id: designerId, project_id: projectId }, '申请已发送');
}

// 设计师查看收到的申请
async function getReceivedRequests(req, res) {
  const [rows] = await db.query(
    `SELECT r.id, r.status, r.message, r.created_at, r.updated_at,
            r.project_id,
            u.id AS owner_id, u.nickname AS owner_nickname, u.avatar AS owner_avatar, u.city AS owner_city,
            p.house_area, p.start_date, p.current_stage
     FROM designer_requests r
     JOIN users u ON r.owner_id = u.id
     JOIN renovation_projects p ON r.project_id = p.id AND r.owner_id = p.user_id
     WHERE r.designer_id = ?
       AND COALESCE(p.lifecycle_status, 'active') = 'active'
     ORDER BY
       CASE r.status WHEN 0 THEN 0 ELSE 1 END,
       r.created_at DESC`,
    [req.user.id]
  );
  return success(res, rows);
}

// 接受/拒绝申请
async function handleRequest(req, res) {
  const requestId = Number(req.params.id);
  const { action } = req.body; // 'accept' | 'reject'
  if (!['accept', 'reject'].includes(action)) return error(res, '操作必须是 accept 或 reject');
  // 确认申请存在且是发给自己的
  const [rows] = await db.query(
    'SELECT * FROM designer_requests WHERE id = ? AND designer_id = ? AND status = 0',
    [requestId, req.user.id]
  );
  if (!rows[0]) return error(res, '申请不存在或已处理', 404);
  const newStatus = action === 'accept' ? 1 : 2;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (action === 'accept') {
      const [result] = await connection.query(
        `UPDATE renovation_projects
         SET designer_id = ?
         WHERE id = ? AND user_id = ? AND designer_id IS NULL
           AND COALESCE(lifecycle_status, 'active') = 'active'`,
        [req.user.id, rows[0].project_id, rows[0].owner_id]
      );
      if (result.affectedRows === 0) {
        await connection.rollback();
        return error(res, '项目不存在或已关联其他设计师', 409);
      }
      await upsertProjectMember(
        connection,
        rows[0].project_id,
        req.user.id,
        'designer'
      );
    }
    await connection.query(
      'UPDATE designer_requests SET status = ?, updated_at = NOW() WHERE id = ?',
      [newStatus, requestId]
    );
    await connection.commit();
  } catch (requestError) {
    await connection.rollback();
    throw requestError;
  } finally {
    connection.release();
  }
  return success(res, { status: newStatus }, action === 'accept' ? '已接受' : '已拒绝');
}

async function getDesigners(req, res) {
  const params = [req.user.id];
  let where = 'u.id != ?';
  if (req.query.city) {
    where += ' AND city = ?';
    params.push(req.query.city);
  }
  const [rows] = await db.query(
    `SELECT u.id, u.nickname, u.avatar, u.city, u.bio, u.phone,
            'designer' AS role
     FROM users u
     JOIN user_roles ur ON ur.user_id = u.id AND ur.role = 'designer'
     WHERE ${where} ORDER BY u.id DESC`,
    params
  );
  if (!rows.length) return success(res, []);
  const recordIds = rows.map((item) => item.id);
  const [images] = await db.query(
    `SELECT id, record_id, image_url, uploaded_by, created_at
     FROM project_inspection_step_record_images
     WHERE record_id IN (${recordIds.map(() => '?').join(', ')})
     ORDER BY id`,
    recordIds
  );
  const imageMap = new Map();
  for (const image of images) {
    if (!imageMap.has(image.record_id)) imageMap.set(image.record_id, []);
    imageMap.get(image.record_id).push(image);
  }
  return success(
    res,
    rows.map((item) => ({
      ...item,
      images: imageMap.get(item.id) || [],
    }))
  );
}

async function bindDesigner(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  return error(res, '请先发送关联申请，设计师同意后才能关联', 409);
}

async function unbindDesigner(req, res) {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE project_members pm
       JOIN renovation_projects p ON p.id = pm.project_id
       SET pm.status = 2, pm.updated_at = NOW()
       WHERE p.user_id = ? AND pm.role = 'designer' AND pm.status = 1
         AND COALESCE(p.lifecycle_status, 'active') = 'active'`,
      [req.user.id]
    );
    await connection.query(
      `UPDATE renovation_projects
       SET designer_id = NULL
       WHERE user_id = ? AND COALESCE(lifecycle_status, 'active') = 'active'`,
      [req.user.id]
    );
    await connection.commit();
  } catch (unbindError) {
    await connection.rollback();
    throw unbindError;
  } finally {
    connection.release();
  }
  return success(res, null);
}

async function getMyProjects(req, res) {
  const memberRole = [
    'designer',
    'project_manager',
    'project_supervisor',
  ].includes(req.user.role)
    ? req.user.role
    : 'designer';
  const [rows] = await db.query(
    `SELECT p.id, p.project_code, p.project_name, p.house_area, p.start_date, p.total_days,
            p.current_stage, p.status, p.lifecycle_status,
            u.nickname AS owner_nickname, u.phone AS owner_phone,
            u.city AS owner_city, pm.role AS member_role,
            pm.status AS member_status
     FROM project_members pm
     JOIN renovation_projects p ON p.id = pm.project_id
     JOIN users u ON p.user_id = u.id
     WHERE pm.user_id = ? AND pm.role = ? AND pm.status IN (1, 2)
       AND COALESCE(p.lifecycle_status, 'active') != 'deleted'
     ORDER BY p.updated_at DESC`,
    [req.user.id, memberRole]
  );
  return success(res, rows);
}

async function getProjectMembers(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }

  const [rows] = await db.query(
    `SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.status,
            pm.permissions, pm.joined_at,
            u.nickname, u.phone, u.avatar, u.city
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ? AND pm.status = 1
     ORDER BY FIELD(pm.role, 'owner', 'owner_member', 'project_manager', 'project_supervisor', 'designer', 'merchant'),
              pm.joined_at`,
    [projectId]
  );
  return success(res, rows);
}

async function getProjectOwnerSideMembers(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.status,
            pm.permissions, pm.joined_at,
            u.nickname, u.phone, u.avatar, u.city
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?
       AND pm.status = 1
       AND pm.role IN ('owner', 'owner_member')
     ORDER BY FIELD(pm.role, 'owner', 'owner_member'), pm.joined_at, pm.id`,
    [projectId]
  );
  return success(res, rows);
}

async function inviteProjectOwnerMember(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const targetUserId = Number(req.body.target_user_id);
  if (!projectId || !targetUserId) return error(res, '邀请信息不完整');
  if (targetUserId === Number(req.user.id)) return error(res, '不能邀请自己');
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有主业主可以添加家庭成员', 403);
  }

  const [projects] = await db.query(
    'SELECT id, user_id FROM renovation_projects WHERE id = ?',
    [projectId]
  );
  const project = projects[0];
  if (!project) return error(res, '项目不存在', 404);
  if (Number(project.user_id) === targetUserId) {
    return error(res, '主业主无需添加为家庭成员', 400);
  }

  const [users] = await db.query(
    'SELECT id, nickname, phone, avatar, city FROM users WHERE id = ?',
    [targetUserId]
  );
  if (!users[0]) return error(res, '用户不存在', 404);

  const [existingOwnerSide] = await db.query(
    `SELECT id, role, status FROM project_members
     WHERE project_id = ?
       AND user_id = ?
       AND role IN ('owner', 'owner_member')
       AND status = 1
     LIMIT 1`,
    [projectId, targetUserId]
  );
  if (existingOwnerSide[0]) return error(res, '该用户已经是家庭成员', 409);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await upsertProjectMember(connection, projectId, targetUserId, 'owner_member');
    await connection.query(
      `INSERT INTO project_action_notifications
         (item_id, recipient_id, event_type, delivery_status, payload)
       VALUES (NULL, ?, 'project_event', 'pending', ?)`,
      [
        targetUserId,
        JSON.stringify({
          source: 'project_event',
          projectEventType: 'OWNER_MEMBER_ADDED',
          project_id: projectId,
          projectId,
          actorId: req.user.id,
          entityType: 'project',
          entityId: projectId,
          title: '你已加入家庭成员',
          content: '你已作为家庭成员加入该项目',
          route: 'project_overview',
          deepLink: { projectId },
        }),
      ]
    );
    await connection.commit();
  } catch (inviteError) {
    await connection.rollback();
    throw inviteError;
  } finally {
    connection.release();
  }

  return success(
    res,
    {
      project_id: projectId,
      user_id: targetUserId,
      role: 'owner_member',
      user: users[0],
    },
    '家庭成员已加入'
  );
}

async function removeProjectOwnerMember(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  if (!projectId || !memberId) return error(res, '成员信息不完整');
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有主业主可以移除家庭成员', 403);
  }

  const [members] = await db.query(
    `SELECT id, user_id, role FROM project_members
     WHERE id = ? AND project_id = ? AND status = 1`,
    [memberId, projectId]
  );
  const member = members[0];
  if (!member) return error(res, '家庭成员不存在', 404);
  if (member.role === 'owner') return error(res, '不能移除主业主', 400);
  if (member.role !== 'owner_member') return error(res, '该成员不是家庭成员', 400);

  await db.query(
    'UPDATE project_members SET status = 2, updated_at = NOW() WHERE id = ?',
    [memberId]
  );
  return success(res, null, '家庭成员已移除');
}

async function getProjectSpaces(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  await ensureDefaultProjectSpaces(projectId, req.user.id);

  const [spaces] = await db.query(
    `SELECT id, project_id, name, sort_order, is_default, created_at
     FROM project_spaces
     WHERE project_id = ?
     ORDER BY sort_order, id`,
    [projectId]
  );
  const [images] = await db.query(
    `SELECT psi.id, psi.space_id, psi.image_type, psi.image_url,
            psi.is_primary,
            psi.source_type, psi.stage_id, psi.sort_order, psi.created_by,
            psi.created_at, u.nickname AS creator_name
     FROM project_space_images psi
     JOIN project_spaces ps ON ps.id = psi.space_id
     JOIN users u ON u.id = psi.created_by
     WHERE ps.project_id = ?
     ORDER BY psi.is_primary DESC, psi.id DESC`,
    [projectId]
  );

  const imagesBySpace = new Map();
  for (const image of images) {
    if (!imagesBySpace.has(image.space_id)) imagesBySpace.set(image.space_id, []);
    imagesBySpace.get(image.space_id).push(image);
  }
  return success(
    res,
    spaces.map((space) => ({
      ...space,
      is_default: Boolean(space.is_default),
      images: imagesBySpace.get(space.id) || [],
    }))
  );
}

async function createProjectSpace(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (!name) return error(res, '空间名称不能为空');
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    await createProjectSpaceChangeRequest(projectId, req.user.id, 'create_space', {
      name,
    });
    return success(res, null, '修改申请已提交，等待业主确认');
  }
  try {
    return success(res, await applyCreateProjectSpace(projectId, req.user.id, name));
  } catch (spaceError) {
    return error(res, spaceError.message || '空间创建失败');
  }
}

async function applyCreateProjectSpace(projectId, userId, name, connection = db) {
  const [spaces] = await connection.query(
    'SELECT COUNT(*) AS total FROM project_spaces WHERE project_id = ?',
    [projectId]
  );
  if ((spaces[0]?.total || 0) >= 30) {
    throw new Error('空间数量最多支持 30 个');
  }
  const [result] = await connection.query(
    `INSERT INTO project_spaces
       (project_id, name, sort_order, is_default, created_by)
     SELECT ?, ?, COALESCE(MAX(sort_order), -1) + 1, 0, ?
     FROM project_spaces
     WHERE project_id = ?
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [projectId, name, userId, projectId]
  );
  const [rows] = await connection.query(
    `SELECT id, project_id, name, sort_order, is_default, created_at
     FROM project_spaces WHERE id = ?`,
    [result.insertId]
  );
  return { ...rows[0], is_default: Boolean(rows[0].is_default), images: [] };
}

async function updateProjectSpace(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const spaceId = Number(req.params.spaceId);
  const name = String(req.body.name || '').trim().slice(0, 50);
  if (!name) return error(res, '空间名称不能为空');
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [spaces] = await db.query(
    'SELECT id FROM project_spaces WHERE id = ? AND project_id = ?',
    [spaceId, projectId]
  );
  if (!spaces[0]) return error(res, '空间不存在', 404);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    await createProjectSpaceChangeRequest(projectId, req.user.id, 'rename_space', {
      space_id: spaceId,
      name,
    });
    return success(res, null, '修改申请已提交，等待业主确认');
  }
  await applyRenameProjectSpace(projectId, spaceId, name);
  return success(res, null, '空间名称已更新');
}

async function applyRenameProjectSpace(projectId, spaceId, name, connection = db) {
  const [result] = await connection.query(
    `UPDATE project_spaces
     SET name = ?, updated_at = NOW()
     WHERE id = ? AND project_id = ?`,
    [name, spaceId, projectId]
  );
  if (result.affectedRows === 0) {
    throw new Error('空间不存在');
  }
}

async function assertProjectSpaceIsEmpty(projectId, spaceId, connection = db) {
  const [images] = await connection.query(
    'SELECT id FROM project_space_images WHERE space_id = ? LIMIT 1',
    [spaceId]
  );
  const [documents] = await connection.query(
    `SELECT id FROM project_design_documents
     WHERE project_id = ? AND space_key = ? LIMIT 1`,
    [projectId, String(spaceId)]
  );
  if (images[0] || documents[0]) {
    throw new Error('请先删除空间内资料再删除空间');
  }
}

async function deleteProjectSpace(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const spaceId = Number(req.params.spaceId);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [spaces] = await db.query(
    'SELECT id FROM project_spaces WHERE id = ? AND project_id = ?',
    [spaceId, projectId]
  );
  if (!spaces[0]) return error(res, '空间不存在', 404);
  try {
    await assertProjectSpaceIsEmpty(projectId, spaceId);
  } catch (spaceError) {
    return error(res, spaceError.message || '空间内还有资料');
  }
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    await createProjectSpaceChangeRequest(projectId, req.user.id, 'delete_space', {
      space_id: spaceId,
    });
    return success(res, null, '修改申请已提交，等待业主确认');
  }
  return applyDeleteProjectSpace(req, res, projectId, spaceId);
}

async function applyDeleteProjectSpace(req, res, projectId, spaceId, connection = db) {
  const [spaces] = await connection.query(
    `SELECT id FROM project_spaces
     WHERE id = ? AND project_id = ?`,
    [spaceId, projectId]
  );
  if (!spaces[0]) return error(res, '空间不存在', 404);
  try {
    await assertProjectSpaceIsEmpty(projectId, spaceId, connection);
  } catch (spaceError) {
    return error(res, spaceError.message || '空间内还有资料');
  }
  await connection.query('DELETE FROM project_spaces WHERE id = ?', [spaceId]);
  return success(res, null, '空间已删除');
}

async function uploadProjectSpaceImages(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const spaceId = Number(req.params.spaceId);
  const imageType = String(req.body.image_type || '');
  if (!['rendering', 'site_photo'].includes(imageType)) {
    await Promise.all((req.files || []).map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '图片类型不正确');
  }
  if (!(await canAccessProject(projectId, req.user.id))) {
    await Promise.all((req.files || []).map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '项目不存在或无权限', 404);
  }
  const [spaces] = await db.query(
    'SELECT id FROM project_spaces WHERE id = ? AND project_id = ?',
    [spaceId, projectId]
  );
  if (!spaces[0]) {
    await Promise.all((req.files || []).map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '空间不存在', 404);
  }
  if (!req.files?.length) return error(res, '请选择要上传的图片');
  const quotaError = await getProjectSpaceImageQuotaError(
    projectId,
    spaceId,
    req.user.id,
    req.files.length
  );
  if (quotaError) {
    await Promise.all(req.files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, quotaError, 429);
  }

  const host = `${req.protocol}://${req.get('host')}`;
  const imageUrls = req.files.map((file) =>
    storageService.uploadedFileUrl(
      req,
      file,
      `/uploads/project-spaces/${file.filename}`
    )
  );
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    await createProjectSpaceChangeRequest(projectId, req.user.id, 'upload_images', {
      space_id: spaceId,
      image_type: imageType,
      image_urls: imageUrls,
    });
    return success(res, null, '修改申请已提交，等待业主确认');
  }
  await applyUploadProjectSpaceImages(projectId, spaceId, imageType, imageUrls, req.user.id);
  return success(res, null, `${req.files.length}张图片上传成功`);
}

async function getProjectSpaceImageQuotaError(
  projectId,
  spaceId,
  userId,
  addingCount,
  connection = db
) {
  const currentSpaceImages = await countRows(
    'SELECT COUNT(*) AS total FROM project_space_images WHERE space_id = ?',
    [spaceId],
    connection
  );
  if (currentSpaceImages + addingCount > PROJECT_UPLOAD_QUOTAS.spaceImagesPerSpaceLimit) {
    return `单个空间最多保存 ${PROJECT_UPLOAD_QUOTAS.spaceImagesPerSpaceLimit} 张图片，请先删除不需要的图片`;
  }
  const todayImages = await countRows(
    `SELECT COUNT(*) AS total
     FROM project_space_images psi
     JOIN project_spaces ps ON ps.id = psi.space_id
     WHERE ps.project_id = ? AND psi.created_by = ?
       AND psi.created_at >= CURDATE()`,
    [projectId, userId],
    connection
  );
  if (todayImages + addingCount > PROJECT_UPLOAD_QUOTAS.spaceImagesDailyLimit) {
    return `同一项目每天最多上传 ${PROJECT_UPLOAD_QUOTAS.spaceImagesDailyLimit} 张空间图片，请明天再试`;
  }
  return '';
}

async function applyUploadProjectSpaceImages(
  projectId,
  spaceId,
  imageType,
  imageUrls,
  userId,
  connection = db
) {
  const quotaError = await getProjectSpaceImageQuotaError(
    projectId,
    spaceId,
    userId,
    imageUrls.length,
    connection
  );
  if (quotaError) throw new Error(quotaError);
  const [existingPrimary] = imageType === 'rendering'
    ? await connection.query(
      `SELECT id FROM project_space_images
       WHERE space_id = ? AND image_type = 'rendering' AND is_primary = 1
       LIMIT 1`,
      [spaceId]
    )
    : [[]];
  const values = imageUrls.map((imageUrl, index) => [
    spaceId,
    imageType,
    imageUrl,
    imageType === 'rendering' && !existingPrimary[0] && index === 0 ? 1 : 0,
    index,
    userId,
  ]);
  await connection.query(
    `INSERT INTO project_space_images
       (space_id, image_type, image_url, is_primary, sort_order, created_by)
     VALUES ${values.map(() => '(?, ?, ?, ?, ?, ?)').join(', ')}`,
    values.flat()
  );
}

async function setDefaultProjectSpaceImage(req, res) {
  const projectId = Number(req.params.id);
  const spaceId = Number(req.params.spaceId);
  const imageId = Number(req.params.imageId);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT psi.id
     FROM project_space_images psi
     JOIN project_spaces ps ON ps.id = psi.space_id
     WHERE psi.id = ? AND psi.space_id = ? AND ps.project_id = ?
       AND psi.image_type = 'rendering'`,
    [imageId, spaceId, projectId]
  );
  if (!rows[0]) return error(res, '效果图不存在', 404);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    await createProjectSpaceChangeRequest(projectId, req.user.id, 'set_default', {
      space_id: spaceId,
      image_id: imageId,
    });
    return success(res, null, '修改申请已提交，等待业主确认');
  }
  await applySetDefaultProjectSpaceImage(spaceId, imageId);
  return success(res, null, '默认效果图已更新');
}

async function applySetDefaultProjectSpaceImage(spaceId, imageId, connection = db) {
  await connection.query(
    `UPDATE project_space_images
     SET is_primary = 0
     WHERE space_id = ? AND image_type = 'rendering'`,
    [spaceId]
  );
  await connection.query(
    'UPDATE project_space_images SET is_primary = 1 WHERE id = ?',
    [imageId]
  );
}

async function deleteProjectSpaceImage(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const spaceId = Number(req.params.spaceId);
  const imageId = Number(req.params.imageId);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT psi.id, psi.image_url, psi.image_type, psi.is_primary
     FROM project_space_images psi
     JOIN project_spaces ps ON ps.id = psi.space_id
     WHERE psi.id = ? AND psi.space_id = ? AND ps.project_id = ?`,
    [imageId, spaceId, projectId]
  );
  if (!rows[0]) return error(res, '图片不存在', 404);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    await createProjectSpaceChangeRequest(projectId, req.user.id, 'delete_image', {
      space_id: spaceId,
      image_id: imageId,
    });
    return success(res, null, '修改申请已提交，等待业主确认');
  }
  await applyDeleteProjectSpaceImage(rows[0], spaceId, imageId);
  return success(res, null, '图片已删除');
}

async function applyDeleteProjectSpaceImage(image, spaceId, imageId, connection = db) {
  await connection.query('DELETE FROM project_space_images WHERE id = ?', [imageId]);
  if (image.image_type === 'rendering' && image.is_primary) {
    await connection.query(
      `UPDATE project_space_images
       SET is_primary = 1
       WHERE space_id = ? AND image_type = 'rendering'
       ORDER BY id ASC
       LIMIT 1`,
      [spaceId]
    );
  }
  const filename = path.basename(new URL(image.image_url).pathname);
  const filePath = path.join(__dirname, '..', 'uploads', 'project-spaces', filename);
  await fs.unlink(filePath).catch(() => {});
}

async function createProjectSpaceChangeRequest(projectId, requesterId, actionType, payload) {
  await db.query(
    `INSERT INTO project_space_change_requests
       (project_id, requester_id, action_type, payload, status)
     VALUES (?, ?, ?, ?, 0)`,
    [projectId, requesterId, actionType, JSON.stringify(payload)]
  );
}

async function getProjectSpaceChangeRequests(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  const params = [projectId];
  let visibilitySql = '';
  if (role !== 'owner') {
    visibilitySql = 'AND request.requester_id = ?';
    params.push(req.user.id);
  }
  const [rows] = await db.query(
    `SELECT request.id, request.project_id, request.requester_id,
            request.action_type, request.payload, request.status,
            request.review_message, request.reviewer_id, request.reviewed_at,
            request.created_at, request.updated_at,
            requester.nickname AS requester_name,
            reviewer.nickname AS reviewer_name
     FROM project_space_change_requests request
     JOIN users requester ON requester.id = request.requester_id
     LEFT JOIN users reviewer ON reviewer.id = request.reviewer_id
     WHERE request.project_id = ?
       ${visibilitySql}
     ORDER BY CASE request.status WHEN 0 THEN 0 ELSE 1 END,
              request.updated_at DESC, request.id DESC
     LIMIT 30`,
    params
  );
  return success(
    res,
    rows.map((row) => ({
      ...row,
      payload: parseJsonObject(row.payload),
    }))
  );
}

async function applyProjectSpaceChange(projectId, request, connection) {
  const payload = parseJsonObject(request.payload);
  switch (request.action_type) {
    case 'create_space':
      if (!payload.name) throw new Error('空间名称不能为空');
      await applyCreateProjectSpace(projectId, request.requester_id, String(payload.name), connection);
      return;
    case 'delete_space': {
      const spaceId = Number(payload.space_id);
      const [spaces] = await connection.query(
        `SELECT id FROM project_spaces
         WHERE id = ? AND project_id = ?`,
        [spaceId, projectId]
      );
      if (!spaces[0]) throw new Error('空间不存在');
      await assertProjectSpaceIsEmpty(projectId, spaceId, connection);
      await connection.query('DELETE FROM project_spaces WHERE id = ?', [spaceId]);
      return;
    }
    case 'rename_space': {
      const spaceId = Number(payload.space_id);
      const name = String(payload.name || '').trim().slice(0, 50);
      if (!spaceId || !name) throw new Error('空间名称不能为空');
      await applyRenameProjectSpace(projectId, spaceId, name, connection);
      return;
    }
    case 'upload_images': {
      const spaceId = Number(payload.space_id);
      const imageType = String(payload.image_type || '');
      const imageUrls = Array.isArray(payload.image_urls) ? payload.image_urls : [];
      if (!['rendering', 'site_photo'].includes(imageType) || !imageUrls.length) {
        throw new Error('图片申请内容不正确');
      }
      const [spaces] = await connection.query(
        'SELECT id FROM project_spaces WHERE id = ? AND project_id = ?',
        [spaceId, projectId]
      );
      if (!spaces[0]) throw new Error('空间不存在');
      await applyUploadProjectSpaceImages(
        projectId,
        spaceId,
        imageType,
        imageUrls,
        request.requester_id,
        connection
      );
      return;
    }
    case 'set_default':
      await applySetDefaultProjectSpaceImage(
        Number(payload.space_id),
        Number(payload.image_id),
        connection
      );
      return;
    case 'delete_image': {
      const spaceId = Number(payload.space_id);
      const imageId = Number(payload.image_id);
      const [rows] = await connection.query(
        `SELECT psi.id, psi.image_url, psi.image_type, psi.is_primary
         FROM project_space_images psi
         JOIN project_spaces ps ON ps.id = psi.space_id
         WHERE psi.id = ? AND psi.space_id = ? AND ps.project_id = ?`,
        [imageId, spaceId, projectId]
      );
      if (!rows[0]) throw new Error('图片不存在');
      await applyDeleteProjectSpaceImage(rows[0], spaceId, imageId, connection);
      return;
    }
    default:
      throw new Error('申请类型不正确');
  }
}

async function handleProjectSpaceChangeRequest(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  const action = String(req.body.action || '');
  const reviewMessage = req.body.review_message
    ? String(req.body.review_message).trim().slice(0, 300)
    : null;
  if (!['accept', 'reject'].includes(action)) {
    return error(res, '操作必须是 accept 或 reject');
  }
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以处理效果图修改申请', 403);
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM project_space_change_requests
       WHERE id = ? AND project_id = ? AND status = 0
       FOR UPDATE`,
      [requestId, projectId]
    );
    const request = rows[0];
    if (!request) {
      await connection.rollback();
      return error(res, '申请不存在或已处理', 404);
    }
    const newStatus = action === 'accept' ? 1 : 2;
    if (action === 'accept') {
      await applyProjectSpaceChange(projectId, request, connection);
    }
    await connection.query(
      `UPDATE project_space_change_requests
       SET status = ?, reviewer_id = ?, review_message = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [newStatus, req.user.id, reviewMessage, requestId]
    );
    await connection.commit();
    return success(
      res,
      { status: newStatus },
      action === 'accept' ? '已同意效果图修改' : '已拒绝效果图修改'
    );
  } catch (requestError) {
    await connection.rollback();
    return error(res, requestError.message || '处理失败');
  } finally {
    connection.release();
  }
}

function mapProjectCaseShare(row) {
  return {
    ...row,
    image_urls: parseJsonArray(row.image_urls),
    visible_fields: parseJsonObject(row.visible_fields),
  };
}

async function getProjectCaseShares(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);

  const params = [projectId];
  let visibilitySql = '';
  if (role !== 'owner') {
    visibilitySql = 'AND share.designer_id = ?';
    params.push(req.user.id);
  }

  const [rows] = await db.query(
    `SELECT share.id, share.project_id, share.designer_id, share.owner_id,
            share.title, share.style, share.summary, share.highlights,
            share.image_urls, share.visible_fields, share.status,
            share.review_message, share.reviewer_id, share.reviewed_at,
            share.created_at, share.updated_at,
            designer.nickname AS designer_name,
            owner.nickname AS owner_name,
            reviewer.nickname AS reviewer_name
     FROM project_case_shares share
     JOIN users designer ON designer.id = share.designer_id
     JOIN users owner ON owner.id = share.owner_id
     LEFT JOIN users reviewer ON reviewer.id = share.reviewer_id
     WHERE share.project_id = ?
       ${visibilitySql}
     ORDER BY CASE share.status WHEN 0 THEN 0 ELSE 1 END,
              share.updated_at DESC, share.id DESC
     LIMIT 30`,
    params
  );

  return success(res, rows.map(mapProjectCaseShare));
}

async function createProjectCaseShare(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);

  const title = String(req.body.title || '').trim().slice(0, 80);
  if (!title) return error(res, '案例标题不能为空');
  const style = req.body.style ? String(req.body.style).trim().slice(0, 40) : null;
  const summary = req.body.summary ? String(req.body.summary).trim().slice(0, 500) : null;
  const highlights = req.body.highlights
    ? String(req.body.highlights).trim().slice(0, 500)
    : null;
  const imageUrls = parseJsonArray(req.body.image_urls)
    .map((url) => String(url || '').trim())
    .filter(Boolean)
    .slice(0, 9);
  const visibleFields = parseJsonObject(req.body.visible_fields);

  const [[project]] = await db.query(
    `SELECT p.id, p.user_id AS owner_id
     FROM renovation_projects p
     WHERE p.id = ?
     LIMIT 1`,
    [projectId]
  );
  if (!project) return error(res, '项目不存在', 404);

  const [result] = await db.query(
    `INSERT INTO project_case_shares
       (project_id, designer_id, owner_id, title, style, summary, highlights,
        image_urls, visible_fields, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      projectId,
      req.user.id,
      project.owner_id,
      title,
      style,
      summary,
      highlights,
      JSON.stringify(imageUrls),
      JSON.stringify(visibleFields),
    ]
  );

  const ownerSideRecipients = uniqueUserIds(
    await getOwnerSideMemberUserIds(projectId),
    [project.owner_id]
  ).filter((userId) => Number(userId) !== Number(req.user.id));
  if (ownerSideRecipients.length) {
    await db.query(
      `INSERT INTO project_action_notifications
         (item_id, recipient_id, event_type, delivery_status, payload)
       VALUES ${ownerSideRecipients.map(() => "(?, ?, 'case_share_request', 'pending', ?)").join(', ')}`,
      ownerSideRecipients.flatMap((userId) => [
        result.insertId,
        userId,
        JSON.stringify({
          source: 'case_share_request',
          project_id: projectId,
          case_share_id: result.insertId,
          title,
        }),
      ])
    );
  }

  return success(
    res,
    { id: result.insertId, status: 0 },
    '设计师案例分享申请已提交，等待业主确认'
  );
}

async function handleProjectCaseShare(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const caseId = Number(req.params.caseId);
  const action = String(req.body.action || '');
  const reviewMessage = req.body.review_message
    ? String(req.body.review_message).trim().slice(0, 300)
    : null;
  if (!['accept', 'reject'].includes(action)) {
    return error(res, '操作必须是 accept 或 reject');
  }
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以处理案例分享申请', 403);
  }

  const newStatus = action === 'accept' ? 1 : 2;
  const [result] = await db.query(
    `UPDATE project_case_shares
     SET status = ?, reviewer_id = ?, review_message = ?, reviewed_at = NOW()
     WHERE id = ? AND project_id = ? AND status = 0`,
    [newStatus, req.user.id, reviewMessage, caseId, projectId]
  );
  if (!result.affectedRows) return error(res, '申请不存在或已处理', 404);

  return success(
    res,
    { status: newStatus },
    action === 'accept' ? '已同意公开为设计案例' : '已拒绝案例分享'
  );
}

async function removeProjectMember(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const memberId = Number(req.params.memberId);
  const [owners] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = 'owner' AND status = 1`,
    [projectId, req.user.id]
  );
  if (!owners[0]) return error(res, '只有业主可以移除项目成员', 403);

  const [members] = await db.query(
    `SELECT id, user_id, role FROM project_members
     WHERE id = ? AND project_id = ? AND status = 1`,
    [memberId, projectId]
  );
  if (!members[0]) return error(res, '项目成员不存在', 404);
  if (members[0].role === 'owner') return error(res, '不能移除项目业主', 400);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      'UPDATE project_members SET status = 2, updated_at = NOW() WHERE id = ?',
      [memberId]
    );
    if (members[0].role === 'designer') {
      await connection.query(
        `UPDATE renovation_projects
         SET designer_id = NULL
         WHERE id = ? AND designer_id = ?`,
        [projectId, members[0].user_id]
      );
    }
    await connection.commit();
  } catch (removeError) {
    await connection.rollback();
    throw removeError;
  } finally {
    connection.release();
  }
  return success(res, null, '项目成员已移除');
}

async function getMemberCandidates(req, res) {
  const role = String(req.query.role || '');
  if (!['owner_member', 'designer', 'project_manager', 'project_supervisor', 'merchant'].includes(role)) {
    return error(res, '成员身份不正确');
  }
  const projectId = Number(req.query.project_id);
  if (!projectId) return error(res, '项目ID不能为空');
  const keyword = String(req.query.keyword || '').trim();
  if (role !== 'merchant' && !/^1[3-9]\d{9}$/.test(keyword)) {
    return error(res, '请输入完整的 11 位手机号进行精准查找');
  }
  const [owners] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = 'owner' AND status = 1`,
    [projectId, req.user.id]
  );
  if (!owners[0]) return error(res, '只有业主可以添加成员', 403);

  if (role === 'owner_member') {
    const [rows] = await db.query(
      `SELECT u.id, u.nickname, u.avatar, u.city, u.bio, u.phone,
              'owner_member' AS role,
              pm.status AS member_status,
              NULL AS request_status
       FROM users u
       LEFT JOIN project_members pm
         ON pm.project_id = ? AND pm.user_id = u.id
            AND pm.role IN ('owner', 'owner_member') AND pm.status = 1
       WHERE u.id != ?
         AND u.phone = ?
       ORDER BY u.id DESC
       LIMIT 30`,
      [
        projectId,
        req.user.id,
        keyword,
      ]
    );
    return success(res, rows);
  }

  const memberMatchSql = role === 'merchant'
    ? '(u.nickname LIKE ? OR u.phone LIKE ? OR u.city LIKE ?)'
    : 'u.phone = ?';
  const memberMatchParams = role === 'merchant'
    ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`]
    : [keyword];
  const [rows] = await db.query(
    `SELECT u.id, u.nickname, u.avatar, u.city, u.bio, u.phone, ur.role,
            pm.status AS member_status,
            r.status AS request_status
     FROM user_roles ur
     JOIN users u ON u.id = ur.user_id
     LEFT JOIN project_members pm
       ON pm.project_id = ? AND pm.user_id = u.id
          AND pm.role = ur.role AND pm.status = 1
     LEFT JOIN project_member_requests r
       ON r.project_id = ? AND r.target_user_id = u.id
          AND r.member_role = ur.role
     WHERE ur.role = ? AND u.id != ?
       AND ${memberMatchSql}
     ORDER BY u.id DESC
     LIMIT 30`,
    [
      projectId,
      projectId,
      role,
      req.user.id,
      ...memberMatchParams,
    ]
  );
  return success(res, rows);
}

async function requestProjectMember(req, res) {
  const projectId = Number(req.body.project_id);
  const targetUserId = Number(req.body.target_user_id);
  const memberRole = String(req.body.member_role || '');
  const message = req.body.message
    ? String(req.body.message).trim().slice(0, 300)
    : null;
  if (!projectId || !targetUserId) return error(res, '申请信息不完整');
  if (!['designer', 'project_manager', 'project_supervisor', 'merchant'].includes(memberRole)) {
    return error(res, '成员身份不正确');
  }
  const [owners] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = 'owner' AND status = 1`,
    [projectId, req.user.id]
  );
  if (!owners[0]) return error(res, '只有业主可以添加成员', 403);
  const [targets] = await db.query(
    `SELECT id FROM user_roles WHERE user_id = ? AND role = ?`,
    [targetUserId, memberRole]
  );
  if (!targets[0]) return error(res, '该用户没有对应身份', 400);
  const [members] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = ? AND status = 1`,
    [projectId, targetUserId, memberRole]
  );
  if (members[0]) return error(res, '该用户已经是项目成员', 409);

  await db.query(
    `INSERT INTO project_member_requests
       (project_id, owner_id, target_user_id, member_role, status, message)
     VALUES (?, ?, ?, ?, 0, ?)
     ON DUPLICATE KEY UPDATE
       status = 0, message = VALUES(message), updated_at = NOW()`,
    [projectId, req.user.id, targetUserId, memberRole, message]
  );
  return success(res, null, '关联申请已发送');
}

async function getSentMemberRequests(req, res) {
  const projectId = Number(req.params.id);
  const [owners] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = 'owner' AND status = 1`,
    [projectId, req.user.id]
  );
  if (!owners[0]) return error(res, '只有业主可以查看成员邀请', 403);

  const [rows] = await db.query(
    `SELECT r.id, r.project_id, r.target_user_id, r.member_role,
            r.status, r.message, r.created_at, r.updated_at,
            u.nickname, u.phone, u.avatar, u.city
     FROM project_member_requests r
     JOIN users u ON u.id = r.target_user_id
     WHERE r.project_id = ? AND r.owner_id = ?
     ORDER BY CASE r.status WHEN 0 THEN 0 ELSE 1 END, r.updated_at DESC`,
    [projectId, req.user.id]
  );
  return success(res, rows);
}

async function cancelMemberRequest(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  const [owners] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = 'owner' AND status = 1`,
    [projectId, req.user.id]
  );
  if (!owners[0]) return error(res, '只有业主可以撤回成员邀请', 403);
  const [result] = await db.query(
    `DELETE FROM project_member_requests
     WHERE id = ? AND project_id = ? AND owner_id = ? AND status = 0`,
    [requestId, projectId, req.user.id]
  );
  if (!result.affectedRows) return error(res, '邀请不存在或已处理', 404);
  return success(res, null, '邀请已撤回');
}

async function getReceivedMemberRequests(req, res) {
  const requestedRole = String(req.query.role || req.user.role || '');
  if (!['designer', 'project_manager', 'project_supervisor', 'merchant'].includes(requestedRole)) {
    return error(res, '成员身份不正确');
  }
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? LIMIT 1`,
    [req.user.id, requestedRole]
  );
  if (!roleRows[0] && req.user.role !== requestedRole) {
    return error(res, '当前账号没有该身份', 403);
  }
  const [rows] = await db.query(
    `SELECT r.id, r.project_id, r.status, r.message, r.member_role,
            r.owner_id, u.nickname AS owner_nickname,
            u.avatar AS owner_avatar, u.city AS owner_city,
            p.house_area, p.current_stage
     FROM project_member_requests r
     JOIN users u ON u.id = r.owner_id
     JOIN renovation_projects p ON p.id = r.project_id
     WHERE r.target_user_id = ? AND r.member_role = ?
       AND COALESCE(p.lifecycle_status, 'active') = 'active'
     ORDER BY CASE r.status WHEN 0 THEN 0 ELSE 1 END, r.updated_at DESC`,
    [req.user.id, requestedRole]
  );
  return success(res, rows);
}

async function handleMemberRequest(req, res) {
  const requestId = Number(req.params.id);
  const action = String(req.body.action || '');
  const requestedRole = String(req.body.member_role || req.user.role || '');
  if (!['accept', 'reject'].includes(action)) {
    return error(res, '操作必须是 accept 或 reject');
  }
  if (!['designer', 'project_manager', 'project_supervisor', 'merchant'].includes(requestedRole)) {
    return error(res, '成员身份不正确');
  }
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? LIMIT 1`,
    [req.user.id, requestedRole]
  );
  if (!roleRows[0] && req.user.role !== requestedRole) {
    return error(res, '当前账号没有该身份', 403);
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM project_member_requests
       WHERE id = ? AND target_user_id = ? AND member_role = ?
         AND status = 0 FOR UPDATE`,
      [requestId, req.user.id, requestedRole]
    );
    if (!rows[0]) {
      await connection.rollback();
      return error(res, '申请不存在或已处理', 404);
    }
    const newStatus = action === 'accept' ? 1 : 2;
    if (action === 'accept') {
      await upsertProjectMember(
        connection,
        rows[0].project_id,
        req.user.id,
        rows[0].member_role
      );
      if (rows[0].member_role === 'designer') {
        await connection.query(
          `UPDATE renovation_projects SET designer_id = ?
           WHERE id = ? AND designer_id IS NULL
             AND COALESCE(lifecycle_status, 'active') = 'active'`,
          [req.user.id, rows[0].project_id]
        );
      }
    }
    await connection.query(
      `UPDATE project_member_requests
       SET status = ?, updated_at = NOW() WHERE id = ?`,
      [newStatus, requestId]
    );
    await connection.commit();
    return success(
      res,
      { status: newStatus },
      action === 'accept' ? '已加入项目' : '已拒绝申请'
    );
  } catch (requestError) {
    await connection.rollback();
    throw requestError;
  } finally {
    connection.release();
  }
}

function projectInvitationRoleLabel(role) {
  return {
    designer: '设计师',
    project_manager: '项目经理',
    project_supervisor: '项目监理',
    merchant: '商家',
  }[role] || '项目成员';
}

let projectInvitationMemberRoleReady = null;

async function ensureProjectInvitationMemberRoleColumn() {
  if (!projectInvitationMemberRoleReady) {
    projectInvitationMemberRoleReady = (async () => {
      const [columns] = await db.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'designer_project_invitations'
          AND COLUMN_NAME = 'member_role'
      `);
      if (columns.length) return true;
      try {
        await db.query(`
          ALTER TABLE designer_project_invitations
          ADD COLUMN member_role VARCHAR(32) NOT NULL DEFAULT 'designer' AFTER owner_id
        `);
        return true;
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') return true;
        console.warn('designer_project_invitations.member_role unavailable:', err.message);
        return false;
      }
    })().catch((err) => {
      projectInvitationMemberRoleReady = null;
      throw err;
    });
  }
  return projectInvitationMemberRoleReady;
}

// 设计师/项目经理搜索已经创建装修档案的业主
async function searchProjectOwners(req, res) {
  const keyword = String(req.query.keyword || '').trim();
  const memberRole = String(req.query.member_role || req.user.role || 'designer');
  if (!keyword) {
    return error(res, '请输入搜索关键词');
  }
  if (!['designer', 'project_manager', 'project_supervisor', 'merchant'].includes(memberRole)) {
    return error(res, '当前身份不能添加项目', 403);
  }
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? LIMIT 1`,
    [req.user.id, memberRole]
  );
  if (!roleRows[0] && req.user.role !== memberRole) {
    return error(res, '当前账号没有该身份', 403);
  }
  if (
    !checkRateLimit(ownerSearchAttempts, `search:${req.user.id}`, {
      limit: 20,
      windowMs: 24 * 60 * 60 * 1000,
    })
  ) {
    return error(res, '今日搜索次数已达上限，请明天再试', 429);
  }
  const hasMemberRole = await ensureProjectInvitationMemberRoleColumn();
  const invitationJoin = hasMemberRole
    ? 'LEFT JOIN designer_project_invitations i ON i.owner_id = u.id AND i.designer_id = ? AND i.`member_role` = ?'
    : 'LEFT JOIN designer_project_invitations i ON i.owner_id = u.id AND i.designer_id = ?';
  const [rows] = await db.query(
    `SELECT u.id, u.nickname, u.phone, u.avatar, u.city,
            p.id AS project_id, p.project_code, p.house_area, p.current_stage,
            p.designer_id,
            d.nickname AS designer_name,
            i.status AS invitation_status
     FROM renovation_projects p
     JOIN users u ON p.user_id = u.id
     LEFT JOIN users d ON p.designer_id = d.id
     ${invitationJoin}
     WHERE u.id != ?
       AND (u.phone = ? OR p.project_code = ?)
       AND COALESCE(p.lifecycle_status, 'active') = 'active'
     ORDER BY u.nickname, u.id
     LIMIT 5`,
    hasMemberRole
      ? [req.user.id, memberRole, req.user.id, keyword, keyword]
      : [req.user.id, req.user.id, keyword, keyword]
  );
  if (rows.length === 0) {
    checkRateLimit(ownerSearchAttempts, `miss:${req.user.id}`, {
      limit: 20,
      windowMs: 10 * 60 * 1000,
    });
    const misses = ownerSearchAttempts.get(`miss:${req.user.id}`) || [];
    if (misses.length >= 20) return error(res, '未命中次数过多，请稍后再试', 429);
  }
  return success(
    res,
    rows.map((row) => ({
      ...row,
      phone: maskPhone(row.phone),
    }))
  );
}

// 设计师/项目经理邀请业主将工地交给自己管理
async function inviteProjectOwner(req, res) {
  const ownerId = Number(req.body.owner_id);
  const memberRole = String(req.body.member_role || req.user.role || 'designer');
  const message = req.body.message ? String(req.body.message).trim().slice(0, 300) : null;
  if (!ownerId) return error(res, '业主ID不能为空');
  if (ownerId === req.user.id) return error(res, '不能邀请自己');
  if (!['designer', 'project_manager', 'project_supervisor', 'merchant'].includes(memberRole)) {
    return error(res, '当前身份不能添加项目', 403);
  }
  const [roleRows] = await db.query(
    `SELECT 1 FROM user_roles WHERE user_id = ? AND role = ? LIMIT 1`,
    [req.user.id, memberRole]
  );
  if (!roleRows[0] && req.user.role !== memberRole) {
    return error(res, '当前账号没有该身份', 403);
  }

  const [projects] = await db.query(
    `SELECT id, designer_id FROM renovation_projects
     WHERE user_id = ? AND COALESCE(lifecycle_status, 'active') = 'active'`,
    [ownerId]
  );
  if (!projects[0]) return error(res, '该用户还没有创建装修档案', 404);
  if (memberRole === 'designer' && Number(projects[0].designer_id) === req.user.id) {
    return success(res, { owner_id: ownerId }, '该工地已经由你管理');
  }
  const hasMemberRole = await ensureProjectInvitationMemberRoleColumn();
  const [memberships] = await db.query(
    `SELECT id
     FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = ? AND status = 1
     LIMIT 1`,
    [projects[0].id, req.user.id, memberRole]
  );
  if (memberships[0]) {
    return success(res, { owner_id: ownerId }, '该项目已经由你管理');
  }

  const [existingInvitations] = await db.query(
    `SELECT status, updated_at
     FROM designer_project_invitations
     WHERE designer_id = ? AND owner_id = ?
     ${hasMemberRole ? 'AND `member_role` = ?' : ''}
     LIMIT 1`,
    hasMemberRole
      ? [req.user.id, ownerId, memberRole]
      : [req.user.id, ownerId]
  );
  const existing = existingInvitations[0];
  if (Number(existing?.status) === 0) {
    return success(res, { owner_id: ownerId }, '邀请已发送，等待业主同意');
  }
  if (Number(existing?.status) === 2) {
    const rejectedAt = new Date(existing.updated_at).getTime();
    if (Date.now() - rejectedAt < 24 * 60 * 60 * 1000) {
      return error(res, '业主已拒绝邀请，24小时后才能再次发送');
    }
  }
  if (
    !checkRateLimit(ownerInviteAttempts, `invite:${req.user.id}`, {
      limit: 10,
      windowMs: 24 * 60 * 60 * 1000,
    })
  ) {
    return error(res, '今日邀请次数已达上限，请明天再试', 429);
  }

  await db.query(
    hasMemberRole
      ? `INSERT INTO designer_project_invitations
           (designer_id, owner_id, member_role, status, message)
         VALUES (?, ?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE
           status = 0,
           message = VALUES(message),
           updated_at = NOW()`
      : `INSERT INTO designer_project_invitations
           (designer_id, owner_id, status, message)
         VALUES (?, ?, 0, ?)
         ON DUPLICATE KEY UPDATE
           status = 0,
           message = VALUES(message),
           updated_at = NOW()`,
    hasMemberRole
      ? [req.user.id, ownerId, memberRole, message]
      : [req.user.id, ownerId, message]
  );
  return success(res, { owner_id: ownerId }, '邀请已发送，等待业主同意');
}

// 业主查看项目成员发来的工地管理邀请
async function getProjectInvitations(req, res) {
  const hasMemberRole = await ensureProjectInvitationMemberRoleColumn();
  const memberRoleSelect = hasMemberRole
    ? 'i.`member_role` AS member_role'
    : "'designer' AS member_role";
  const [rows] = await db.query(
    `SELECT i.id, i.status, ${memberRoleSelect}, i.message, i.created_at, i.updated_at,
            u.id AS designer_id, u.nickname AS designer_nickname,
            u.avatar AS designer_avatar, u.city AS designer_city, u.bio AS designer_bio
     FROM designer_project_invitations i
     JOIN users u ON i.designer_id = u.id
     WHERE i.owner_id = ?
     ORDER BY
       CASE i.status WHEN 0 THEN 0 ELSE 1 END,
       i.updated_at DESC`,
    [req.user.id]
  );
  return success(res, rows);
}

// 业主同意或拒绝项目成员邀请
async function handleProjectInvitation(req, res) {
  const invitationId = Number(req.params.id);
  const { action } = req.body;
  if (!['accept', 'reject'].includes(action)) {
    return error(res, '操作必须是 accept 或 reject');
  }

  const hasMemberRole = await ensureProjectInvitationMemberRoleColumn();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, designer_id, owner_id,
              ${hasMemberRole ? '`member_role`' : "'designer' AS member_role"}
       FROM designer_project_invitations
       WHERE id = ? AND owner_id = ? AND status = 0
       FOR UPDATE`,
      [invitationId, req.user.id]
    );
    if (!rows[0]) {
      await connection.rollback();
      return error(res, '邀请不存在或已处理', 404);
    }

    const newStatus = action === 'accept' ? 1 : 2;
    await connection.query(
      'UPDATE designer_project_invitations SET status = ?, updated_at = NOW() WHERE id = ?',
      [newStatus, invitationId]
    );
    if (action === 'accept') {
      if (rows[0].member_role === 'designer') {
        const [result] = await connection.query(
          `UPDATE renovation_projects
           SET designer_id = COALESCE(designer_id, ?)
           WHERE user_id = ? AND COALESCE(lifecycle_status, 'active') = 'active'`,
          [rows[0].designer_id, req.user.id]
        );
        if (result.affectedRows === 0) {
          await connection.rollback();
          return error(res, '装修档案不存在', 404);
        }
      }
      const [projects] = await connection.query(
        `SELECT id FROM renovation_projects
         WHERE user_id = ? AND COALESCE(lifecycle_status, 'active') = 'active'`,
        [req.user.id]
      );
      if (!projects.length) {
        await connection.rollback();
        return error(res, '装修档案不存在', 404);
      }
      for (const project of projects) {
        await upsertProjectMember(
          connection,
          project.id,
          rows[0].designer_id,
          rows[0].member_role
        );
      }
    }
    await connection.commit();
    return success(
      res,
      { status: newStatus },
      action === 'accept'
        ? `已同意，${projectInvitationRoleLabel(rows[0].member_role)}可以管理你的工地`
        : '已拒绝'
    );
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function planTask(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const [tasks] = await db.query(
    'SELECT project_id FROM renovation_tasks WHERE id = ?',
    [Number(req.params.taskId)]
  );
  if (!tasks[0]) return error(res, '任务不存在', 404);
  req.params.id = String(tasks[0].project_id);
  return planProjectTask(req, res);
}

async function addTask(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const {
    project_id: requestedProjectId,
    stage_id: stageId,
    task_name: taskName,
    planned_start: plannedStart,
    planned_end: plannedEnd,
    is_key: isKey,
  } = req.body;
  const [projects] = await db.query(
    `SELECT p.id
     FROM project_members pm
     JOIN renovation_projects p ON p.id = pm.project_id
     WHERE pm.user_id = ? AND pm.role = ? AND pm.status = 1
       AND COALESCE(p.lifecycle_status, 'active') = 'active'
       AND (? IS NULL OR p.id = ?)
     ORDER BY p.updated_at DESC
     LIMIT 1`,
    [
      req.user.id,
      req.user.role,
      requestedProjectId ? Number(requestedProjectId) : null,
      requestedProjectId ? Number(requestedProjectId) : null,
    ]
  );
  if (!projects[0]) return error(res, '暂无可管理项目', 404);
  req.params.id = String(projects[0].id);
  req.body = {
    project_id: projects[0].id,
    stage_id: stageId,
    task_name: taskName,
    planned_start: plannedStart,
    planned_end: plannedEnd,
    is_key: Boolean(isKey),
  };
  return createProjectTask(req, res);
}

async function getTips(req, res) {
  const defaultGeneralTips = [
    { type: 'stage', title: '阶段建议', content: '提前确认主材到货时间，避免施工等待。' },
    { type: 'general', title: '装修小贴士', content: '水电验收时拍照存档，方便日后维修定位。' },
    { type: 'general', title: '装修小贴士', content: '防水闭水试验建议保持至少 48 小时。' },
  ];
  const defaultFunctionTips = [
    {
      type: 'function_intro',
      title: '项目概览说明',
      content: '这里汇总项目档案、进度和验收信息，帮助你快速了解项目当前情况。你可以邀请设计师、项目经理一起协作，让装修过程更清楚、更好推进。',
    },
  ];
  const type = req.query.type ? String(req.query.type) : '';
  const allowedTypes = new Set(['general', 'function_intro', 'stage']);
  if (type && !allowedTypes.has(type)) return error(res, '日志信息分类不正确');
  const params = [];
  let typeSql = '';
  if (type) {
    typeSql = 'AND type = ?';
    params.push(type);
  }
  const limit = type === 'function_intro' ? 1 : 3;
  const [rows] = await db.query(
    `SELECT type, title, content
     FROM project_tips
     WHERE is_active = 1
       ${typeSql}
     ORDER BY sort_order ASC, id ASC
     LIMIT ${limit}`,
    params
  );
  const hasGarbledTips = rows.some((tip) =>
    /[ÃÂâèäåæçé�]/.test(`${tip.title || ''}${tip.content || ''}`)
  );
  if (rows.length > 0 && !hasGarbledTips) return success(res, rows);
  if (type === 'function_intro') return success(res, defaultFunctionTips);
  return success(res, defaultGeneralTips);
}

// ========== App 兼容接口 ==========

// GET /api/renovation/projects - 获取当前用户的项目列表
async function getProjects(req, res) {
  const [projects] = await db.query(
    `SELECT p.*, u.nickname AS designer_name
     FROM renovation_projects p
     LEFT JOIN users u ON p.designer_id = u.id
     WHERE p.user_id = ?
       AND COALESCE(p.lifecycle_status, 'active') = 'active'
     ORDER BY p.created_at DESC, p.id DESC`,
    [req.user.id]
  );
  return success(res, {
    projects: projects.map((project) => ({
      id: project.id,
      project_code: project.project_code,
      project_name: normalizeProjectName(project.project_name),
      house_area: Number(project.house_area),
      start_date: project.start_date,
      total_days: project.total_days,
      current_stage: project.current_stage,
      status: project.status,
      lifecycle_status: normalizeProjectLifecycle(project),
      archived_at: project.archived_at || null,
      project_type: project.project_type,
      house_layout: project.house_layout,
      floor_plan_image: project.floor_plan_image,
      renovation_method: project.renovation_method,
      budget_range: project.budget_range,
      expected_move_in_date: project.expected_move_in_date,
      resident_info: project.resident_info,
      lifestyle_notes: project.lifestyle_notes,
      style_preference: project.style_preference,
      key_spaces: project.key_spaces,
      special_needs: project.special_needs,
      designer_id: project.designer_id,
      designer_name: project.designer_name || null,
      created_at: project.created_at,
    })),
    total: projects.length,
  });
}

async function getAccessibleProjects(req, res) {
  const includeArchived =
    req.query.include_archived === '1' || req.query.includeArchived === '1';
  const [rows] = await db.query(
    `SELECT p.id, p.project_code, p.project_name, p.house_area, p.start_date, p.total_days, p.current_stage,
            p.status, p.project_type, p.house_layout, p.floor_plan_image,
            p.renovation_method, p.budget_range, p.expected_move_in_date,
            p.resident_info, p.lifestyle_notes, p.style_preference,
            p.key_spaces, p.special_needs, p.lifecycle_status, p.archived_at,
            p.created_at, pm.role AS member_role,
            owner.nickname AS owner_nickname, owner.phone AS owner_phone,
            owner.city AS owner_city
     FROM project_members pm
     JOIN renovation_projects p ON p.id = pm.project_id
     JOIN users owner ON owner.id = p.user_id
     WHERE pm.user_id = ? AND pm.status = 1
       AND COALESCE(p.lifecycle_status, 'active') != 'deleted'
       AND (
         COALESCE(p.lifecycle_status, 'active') = 'active'
         OR (? = 1 AND pm.role = 'owner')
       )
     ORDER BY FIELD(pm.role, 'owner', 'owner_member', 'project_manager', 'project_supervisor', 'designer', 'merchant'),
              FIELD(COALESCE(p.lifecycle_status, 'active'), 'active', 'archived'),
              p.updated_at DESC, p.id DESC`,
    [req.user.id, includeArchived ? 1 : 0]
  );
  return success(res, {
    projects: rows.map((project) => ({
      ...project,
      project_name: normalizeProjectName(project.project_name),
    })),
    total: rows.length,
  });
}

// GET /api/renovation/projects/:id - 获取单个项目详情
async function getProjectDetail(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在', 404);
  }
  const [rows] = await db.query(
    `SELECT p.*, u.nickname AS designer_name
     FROM renovation_projects p
     LEFT JOIN users u ON p.designer_id = u.id
     WHERE p.id = ?
       AND COALESCE(p.lifecycle_status, 'active') != 'deleted'`,
    [projectId]
  );
  if (!rows[0]) return error(res, '项目不存在', 404);
  const calendar = await calendarForProject(rows[0]);
  const role = await getProjectMemberRole(projectId, req.user.id);
  calendar.access = {
    role,
    read_only: role === companyAdminViewerRole,
    source: role === companyAdminViewerRole ? 'company_admin' : 'project_member',
  };
  return success(res, calendar);
}

async function getProjectCheckIns(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  await ensureProjectCheckInCircleSharesTable();

  const canViewAllCheckIns = role === 'owner';
  const visibilityClause = canViewAllCheckIns
    ? ''
    : `AND (
         checkin.user_id = ?
         OR EXISTS (
           SELECT 1
           FROM project_checkin_shares visible_share
           WHERE visible_share.checkin_id = checkin.id
             AND visible_share.shared_with_user_id = ?
         )
       )`;
  const [rows] = await db.query(
    `SELECT checkin.id, checkin.project_id, checkin.user_id, checkin.role,
            checkin.description, checkin.checkin_date,
            checkin.shared_with_members, checkin.created_at, checkin.updated_at,
            user.nickname AS user_nickname, user.avatar AS user_avatar
     FROM project_checkins checkin
     JOIN users user ON user.id = checkin.user_id
     WHERE checkin.project_id = ?
     ${visibilityClause}
     ORDER BY checkin.checkin_date DESC, checkin.created_at DESC, checkin.id DESC`,
    canViewAllCheckIns
      ? [projectId]
      : [projectId, req.user.id, req.user.id]
  );
  if (!rows.length) return success(res, []);
  const ids = rows.map((item) => item.id);
  const [media] = await db.query(
    `SELECT id, checkin_id, media_type, media_url, created_at
     FROM project_checkin_media
     WHERE checkin_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY id`,
    ids
  );
  const host = `${req.protocol}://${req.get('host')}`;
  const mediaMap = new Map();
  for (const item of media) {
    if (item.media_url && String(item.media_url).startsWith('/uploads/')) {
      item.media_url = `${host}/api${item.media_url}`;
    }
    if (!mediaMap.has(item.checkin_id)) mediaMap.set(item.checkin_id, []);
    mediaMap.get(item.checkin_id).push(item);
  }
  const [shares] = await db.query(
    `SELECT share.checkin_id, share.shared_with_user_id AS user_id,
            user.nickname, user.avatar
     FROM project_checkin_shares share
     JOIN users user ON user.id = share.shared_with_user_id
     WHERE share.checkin_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY share.id`,
    ids
  );
  const shareMap = new Map();
  for (const item of shares) {
    if (!shareMap.has(item.checkin_id)) shareMap.set(item.checkin_id, []);
    shareMap.get(item.checkin_id).push(item);
  }
  const [circleShares] = await db.query(
    `SELECT checkin_id
     FROM project_checkin_circle_shares
     WHERE checkin_id IN (${ids.map(() => '?').join(', ')})`,
    ids
  );
  const circleShareSet = new Set(circleShares.map((item) => Number(item.checkin_id)));
  return success(
    res,
    rows.map((item) => ({
      ...item,
      media: mediaMap.get(item.id) || [],
      shared_members: shareMap.get(item.id) || [],
      shared_to_circle: circleShareSet.has(Number(item.id)),
    }))
  );
}

async function createProjectCheckIn(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const description = String(req.body.description || '').trim().slice(0, 1000);
  const checkInDate = String(req.body.checkin_date || '');
  const sharedMemberIds = parseAssigneeIds(req.body.shared_member_ids);
  const files = req.files || [];
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) {
    await removeUploadedFiles(files);
    return error(res, '项目不存在或无权限', 404);
  }
  if (!description && !files.length) {
    await removeUploadedFiles(files);
    return error(res, '请填写打卡描述或添加图片、视频');
  }
  if (!checkInDate || Number.isNaN(Date.parse(checkInDate))) {
    await removeUploadedFiles(files);
    return error(res, '打卡日期不正确');
  }
  if (sharedMemberIds.includes(req.user.id)) {
    await removeUploadedFiles(files);
    return error(res, '不能分享给自己');
  }
  if (sharedMemberIds.length) {
    const [members] = await db.query(
      `SELECT user_id FROM project_members
       WHERE project_id = ? AND status = 1
         AND user_id IN (${sharedMemberIds.map(() => '?').join(', ')})`,
      [projectId, ...sharedMemberIds]
    );
    if (members.length !== sharedMemberIds.length) {
      await removeUploadedFiles(files);
      return error(res, '分享成员包含非项目成员');
    }
  }
  const todayCheckIns = await countRows(
    `SELECT COUNT(*) AS total FROM project_checkins
     WHERE project_id = ? AND user_id = ? AND created_at >= CURDATE()`,
    [projectId, req.user.id]
  );
  if (todayCheckIns >= PROJECT_UPLOAD_QUOTAS.checkInDailyLimit) {
    await removeUploadedFiles(files);
    return error(res, `同一项目每天最多发布 ${PROJECT_UPLOAD_QUOTAS.checkInDailyLimit} 条工地打卡，请明天再试`, 429);
  }
  const totalCheckIns = await countRows(
    `SELECT COUNT(*) AS total FROM project_checkins
     WHERE project_id = ?`,
    [projectId]
  );
  if (totalCheckIns >= PROJECT_UPLOAD_QUOTAS.checkInTotalLimit) {
    await removeUploadedFiles(files);
    return error(res, `同一项目工地打卡最多 ${PROJECT_UPLOAD_QUOTAS.checkInTotalLimit} 条，请先删除不需要的打卡记录`, 429);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_checkins
       (project_id, user_id, role, description, checkin_date, shared_with_members)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        req.user.id,
        role,
        description,
        checkInDate,
        sharedMemberIds.length ? 1 : 0,
      ]
    );
    if (sharedMemberIds.length) {
      await connection.query(
        `INSERT INTO project_checkin_shares
         (checkin_id, shared_with_user_id, shared_by)
         VALUES ${sharedMemberIds.map(() => '(?, ?, ?)').join(', ')}`,
        sharedMemberIds.flatMap((userId) => [result.insertId, userId, req.user.id])
      );
    }
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_checkin_media
         (checkin_id, media_type, media_url)
         VALUES ${files.map(() => '(?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          result.insertId,
          file.mimetype.startsWith('video/') ? 'video' : 'image',
          file.storageUrl || `${host}/api/uploads/check-ins/${file.filename}`,
        ])
      );
    }
    if (sharedMemberIds.length) {
      await emitProjectEvent(ProjectEventType.SITE_CHECK_IN_SHARED, {
        projectId,
        actorId: req.user.id,
        targetUserIds: sharedMemberIds,
        entityType: 'site_check_in',
        entityId: result.insertId,
        title: '工地打卡分享',
        content: description || '项目成员分享了一条工地打卡记录',
        route: 'received_site_check_in',
        deepLink: { projectId, checkInId: result.insertId },
      }, connection);
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '工地打卡已保存');
  } catch (checkInError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw checkInError;
  } finally {
    connection.release();
  }
}

async function updateProjectCheckInShares(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const checkInId = Number(req.params.checkInId);
  const sharedMemberIds = parseAssigneeIds(req.body.shared_member_ids);
  const shareNote = String(req.body.share_note || '').trim().slice(0, 200);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);

  const [rows] = await db.query(
    'SELECT id, user_id, description FROM project_checkins WHERE id = ? AND project_id = ? LIMIT 1',
    [checkInId, projectId]
  );
  const checkIn = rows[0];
  if (!checkIn) return error(res, '打卡记录不存在', 404);
  if (role !== 'owner' && Number(checkIn.user_id) !== Number(req.user.id)) {
    return error(res, '只能分享自己的打卡记录', 403);
  }
  if (sharedMemberIds.includes(Number(checkIn.user_id))) {
    return error(res, '不能分享给打卡人本人');
  }
  if (sharedMemberIds.length) {
    const [members] = await db.query(
      `SELECT user_id FROM project_members
       WHERE project_id = ? AND status = 1
         AND user_id IN (${sharedMemberIds.map(() => '?').join(', ')})`,
      [projectId, ...sharedMemberIds]
    );
    if (members.length !== sharedMemberIds.length) {
      return error(res, '分享成员包含非项目成员');
    }
  }
  let newlySharedMemberIds = sharedMemberIds;
  if (sharedMemberIds.length) {
    const [existingShares] = await db.query(
      `SELECT shared_with_user_id
       FROM project_checkin_shares
       WHERE checkin_id = ?
         AND shared_with_user_id IN (${sharedMemberIds.map(() => '?').join(', ')})`,
      [checkInId, ...sharedMemberIds]
    );
    const existingShareIds = new Set(
      existingShares.map((item) => Number(item.shared_with_user_id))
    );
    newlySharedMemberIds = sharedMemberIds.filter((userId) => !existingShareIds.has(Number(userId)));
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (sharedMemberIds.length) {
      await connection.query(
        `INSERT IGNORE INTO project_checkin_shares
         (checkin_id, shared_with_user_id, shared_by, share_note)
         VALUES ${sharedMemberIds.map(() => '(?, ?, ?, ?)').join(', ')}`,
        sharedMemberIds.flatMap((userId) => [
          checkInId,
          userId,
          req.user.id,
          shareNote || null,
        ])
      );
    }
    await connection.query(
      `UPDATE project_checkins
       SET shared_with_members = EXISTS (
         SELECT 1 FROM project_checkin_shares WHERE checkin_id = ?
       )
       WHERE id = ?`,
      [checkInId, checkInId]
    );
    if (newlySharedMemberIds.length) {
      await emitProjectEvent(ProjectEventType.SITE_CHECK_IN_SHARED, {
        projectId,
        actorId: req.user.id,
        targetUserIds: newlySharedMemberIds,
        entityType: 'site_check_in',
        entityId: checkInId,
        title: '工地打卡分享',
        content: shareNote || checkIn.description || '项目成员分享了一条工地打卡记录',
        route: 'received_site_check_in',
        deepLink: { projectId, checkInId },
      }, connection);
    }
    await connection.commit();
    return success(res, null, '分享设置已更新');
  } catch (shareError) {
    await connection.rollback();
    throw shareError;
  } finally {
    connection.release();
  }
}

async function getReceivedProjectCheckInShare(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const checkInId = Number(req.params.checkInId);
  if (!checkInId) return error(res, '打卡分享不存在', 404);

  const [rows] = await db.query(
    `SELECT share.id AS share_id, share.share_note,
            checkin.checkin_date,
            project.project_name, project.current_stage,
            COALESCE(sharer.nickname, checkin_user.nickname, '项目成员') AS shared_by_name,
            COALESCE(sharer.avatar, checkin_user.avatar, '') AS shared_by_avatar
     FROM project_checkin_shares share
     JOIN project_checkins checkin ON checkin.id = share.checkin_id
     JOIN renovation_projects project ON project.id = checkin.project_id
     LEFT JOIN users sharer ON sharer.id = share.shared_by
     LEFT JOIN users checkin_user ON checkin_user.id = checkin.user_id
     WHERE share.checkin_id = ?
       AND share.shared_with_user_id = ?
       AND checkin.project_id = ?
     LIMIT 1`,
    [checkInId, req.user.id, projectId]
  );
  const share = rows[0];
  if (!share) return error(res, '这条打卡分享不存在或你无权查看', 404);

  const [media] = await db.query(
    `SELECT id, media_type, media_url
     FROM project_checkin_media
     WHERE checkin_id = ? AND media_type = 'image'
     ORDER BY id`,
    [checkInId]
  );
  const host = `${req.protocol}://${req.get('host')}`;
  const images = media.map((item) => ({
    ...item,
    media_url: item.media_url && String(item.media_url).startsWith('/uploads/')
      ? `${host}/api${item.media_url}`
      : item.media_url,
  }));
  return success(res, {
    share_id: share.share_id,
    project_name: normalizeProjectName(share.project_name),
    current_stage: share.current_stage,
    checkin_date: share.checkin_date,
    shared_by_name: share.shared_by_name,
    shared_by_avatar: share.shared_by_avatar || '',
    share_note: share.share_note || '',
    images,
  });
}

async function createProjectCheckInWechatShare(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const checkInId = Number(req.params.checkInId);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);

  const [rows] = await db.query(
    'SELECT id, user_id FROM project_checkins WHERE id = ? AND project_id = ? LIMIT 1',
    [checkInId, projectId]
  );
  const checkIn = rows[0];
  if (!checkIn) return error(res, '打卡记录不存在', 404);
  if (role !== 'owner' && Number(checkIn.user_id) !== Number(req.user.id)) {
    return error(res, '只能分享自己的打卡记录', 403);
  }

  await ensureProjectCheckInWechatSharesTable();
  const [existingShares] = await db.query(
    'SELECT token FROM project_checkin_wechat_shares WHERE checkin_id = ? AND shared_by = ? LIMIT 1',
    [checkInId, req.user.id]
  );
  if (existingShares[0]) {
    return success(res, {
      token: existingShares[0].token,
      path: `/pages/checkin-share-view/index?token=${existingShares[0].token}`,
    });
  }

  const token = crypto.randomBytes(24).toString('hex');
  await db.query(
    `INSERT INTO project_checkin_wechat_shares (checkin_id, token, shared_by)
     VALUES (?, ?, ?)`,
    [checkInId, token, req.user.id]
  );
  return success(res, {
    token,
    path: `/pages/checkin-share-view/index?token=${token}`,
  });
}

async function getProjectCheckInWechatShare(req, res) {
  const token = String(req.params.token || '').trim();
  if (!/^[a-f0-9]{48}$/.test(token)) return error(res, '分享链接无效', 404);

  await ensureProjectCheckInWechatSharesTable();
  const [rows] = await db.query(
    `SELECT
       share.token,
       checkin.id,
       checkin.project_id,
       checkin.user_id,
       checkin.role,
       checkin.description,
       checkin.checkin_date,
       checkin.created_at,
       project.project_name,
       project.current_stage,
       user.nickname AS user_nickname,
       user.avatar AS user_avatar
     FROM project_checkin_wechat_shares share
     JOIN project_checkins checkin ON checkin.id = share.checkin_id
     JOIN renovation_projects project ON project.id = checkin.project_id
     LEFT JOIN users user ON user.id = checkin.user_id
     WHERE share.token = ?
     LIMIT 1`,
    [token]
  );
  const checkIn = rows[0];
  if (!checkIn) return error(res, '分享内容不存在或已失效', 404);

  const [media] = await db.query(
    `SELECT id, media_type, media_url
     FROM project_checkin_media
     WHERE checkin_id = ?
     ORDER BY id`,
    [checkIn.id]
  );
  return success(res, {
    token,
    id: checkIn.id,
    project_id: checkIn.project_id,
    project_name: checkIn.project_name || '装修项目',
    current_stage: checkIn.current_stage || '',
    user_id: checkIn.user_id,
    role: checkIn.role,
    description: checkIn.description || '',
    checkin_date: checkIn.checkin_date,
    created_at: checkIn.created_at,
    user_nickname: checkIn.user_nickname || '项目成员',
    user_avatar: checkIn.user_avatar || '',
    media,
  });
}

async function shareProjectCheckInToCircle(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const checkInId = Number(req.params.checkInId);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  await ensureProjectCheckInCircleSharesTable();

  const [rows] = await db.query(
    `SELECT checkin.*, project.current_stage, project.user_id AS owner_id, owner.city AS owner_city
     FROM project_checkins checkin
     JOIN renovation_projects project ON project.id = checkin.project_id
     LEFT JOIN users owner ON owner.id = project.user_id
     WHERE checkin.id = ? AND checkin.project_id = ?
     LIMIT 1`,
    [checkInId, projectId]
  );
  const checkIn = rows[0];
  if (!checkIn) return error(res, '打卡记录不存在', 404);
  if (role !== 'owner' && Number(checkIn.user_id) !== Number(req.user.id)) {
    return error(res, '只能分享自己的打卡记录', 403);
  }
  const [existingShares] = await db.query(
    'SELECT note_id FROM project_checkin_circle_shares WHERE checkin_id = ? LIMIT 1',
    [checkInId]
  );
  if (existingShares[0]) {
    return success(res, { note_id: existingShares[0].note_id }, '这条打卡已分享到装修圈');
  }
  const [media] = await db.query(
    `SELECT media_type, media_url
     FROM project_checkin_media
     WHERE checkin_id = ? AND media_type = 'image'
     ORDER BY id
     LIMIT 9`,
    [checkInId]
  );
  if (!String(checkIn.description || '').trim() && !media.length) {
    return error(res, '打卡内容为空，无法分享到装修圈');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const titleSource = String(checkIn.description || '').trim() || '工地打卡';
    const title = titleSource.length > 30 ? titleSource.slice(0, 30) : titleSource;
    const publishRole = notePublishRoles.has(checkIn.role) ? checkIn.role : null;
    const [result] = await connection.query(
      `INSERT INTO notes
       (user_id, title, content, source_type, stage_id, publish_role, city, category, status)
       VALUES (?, ?, ?, 'site_check_in', ?, ?, ?, 'site_check_in', 1)`,
      [
        checkIn.user_id,
        title,
        String(checkIn.description || '').trim() || '分享了一条工地打卡记录',
        checkIn.current_stage || null,
        publishRole,
        checkIn.owner_city || '',
      ]
    );
    if (media.length) {
      await connection.query(
        `INSERT INTO note_images (note_id, url, sort_order)
         VALUES ${media.map(() => '(?, ?, ?)').join(', ')}`,
        media.flatMap((item, index) => [result.insertId, item.media_url, index])
      );
    }
    await connection.query(
      `INSERT INTO project_checkin_circle_shares (checkin_id, note_id, shared_by)
       VALUES (?, ?, ?)`,
      [checkInId, result.insertId, req.user.id]
    );
    await connection.commit();
    return success(res, { note_id: result.insertId }, '已分享到装修圈');
  } catch (shareError) {
    await connection.rollback();
    throw shareError;
  } finally {
    connection.release();
  }
}

async function deleteProjectCheckIn(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const checkInId = Number(req.params.checkInId);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  await ensureProjectCheckInCircleSharesTable();

  const [rows] = await db.query(
    'SELECT id, user_id FROM project_checkins WHERE id = ? AND project_id = ? LIMIT 1',
    [checkInId, projectId]
  );
  const checkIn = rows[0];
  if (!checkIn) return error(res, '打卡记录不存在', 404);
  if (role !== 'owner' && Number(checkIn.user_id) !== Number(req.user.id)) {
    return error(res, '只能删除自己的打卡记录', 403);
  }

  const [media] = await db.query(
    'SELECT media_url FROM project_checkin_media WHERE checkin_id = ?',
    [checkInId]
  );
  const [circleShares] = await db.query(
    'SELECT note_id FROM project_checkin_circle_shares WHERE checkin_id = ? AND note_id IS NOT NULL',
    [checkInId]
  );
  const noteIds = circleShares
    .map((item) => Number(item.note_id))
    .filter((id) => Number.isInteger(id) && id > 0);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (noteIds.length) {
      await connection.query(
        `DELETE FROM notes WHERE id IN (${noteIds.map(() => '?').join(', ')})`,
        noteIds
      );
    }
    await connection.query('DELETE FROM project_checkin_circle_shares WHERE checkin_id = ?', [checkInId]);
    await connection.query('DELETE FROM project_checkin_shares WHERE checkin_id = ?', [checkInId]);
    await connection.query('DELETE FROM project_checkin_media WHERE checkin_id = ?', [checkInId]);
    await connection.query('DELETE FROM project_checkins WHERE id = ?', [checkInId]);
    await connection.commit();
  } catch (deleteError) {
    await connection.rollback();
    throw deleteError;
  } finally {
    connection.release();
  }

  await Promise.allSettled(
    media
      .map((item) => uploadPathFromUrl(item.media_url, 'check-ins'))
      .filter(Boolean)
      .map((filePath) => fs.unlink(filePath))
  );
  return success(res, null, '打卡记录已删除');
}

function uploadPathFromUrl(value, folder) {
  const raw = String(value || '');
  const marker = `/uploads/${folder}/`;
  const index = raw.indexOf(marker);
  if (index < 0) return null;
  const relative = raw.slice(index + '/uploads/'.length);
  if (!relative || relative.includes('..')) return null;
  return path.join(__dirname, '..', 'uploads', relative);
}

const expenseCategories = new Set([
  'material',
  'labor',
  'design',
  'construction',
  'management',
  'furniture',
  'appliance',
  'whole_house_custom',
  'soft_decoration',
  'other',
]);
const expensePaymentMethods = new Set([
  'wechat',
  'alipay',
  'bank_card',
  'cash',
  'other',
]);
const expenseStatuses = new Set([
  'paid',
  'pending',
  'refunded',
  'partial_refund',
]);
const designDocumentCategories = new Set([
  'original_floor_plan',
  'measurement',
  'layout_plan',
  'rendering',
  'construction_drawing',
  'hydropower',
  'other',
]);
const designDocumentStatuses = new Set([
  'draft',
  'pending',
  'confirmed',
  'revision_requested',
  'superseded',
  'voided',
  'archived',
]);
const handoverStatuses = new Set([
  'draft',
  'pending_confirm',
  'confirmed',
  'revision_needed',
  'archived',
  // Legacy handover状态，保留读取和过渡兼容。
  'pending',
  'needs_supplement',
]);
const materialCategories = new Set([
  'tile',
  'floor',
  'door_window',
  'bathroom',
  'cabinet',
  'wardrobe',
  'lighting',
  'hardware',
  'paint',
  'appliance',
  'other',
]);
const materialSupplierTypes = new Set([
  'owner',
  'decoration_company',
  'designer',
  'merchant',
  'other',
]);
const materialArrivalStatuses = new Set([
  'pending',
  'ordered',
  'arrived',
  'installed',
  'returned',
]);
const materialSpaceTags = new Set([
  'whole_house',
  'living_room',
  'kitchen',
  'master_bedroom',
  'bedroom',
  'bathroom',
  'balcony',
  'other',
]);

async function getProjectExpenses(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  if (!(await isOwnerSide(projectId, req.user.id))) {
    return error(res, '无权限查看费用支出', 403);
  }
  const [rows] = await db.query(
    `SELECT expense.id, expense.project_id, expense.created_by,
            expense.expense_date, expense.category, expense.title,
            expense.amount, expense.payment_method, expense.payee,
            expense.note, expense.include_in_total, expense.status,
            expense.created_at, expense.updated_at,
            user.nickname AS creator_name
     FROM project_expenses expense
     JOIN users user ON user.id = expense.created_by
     WHERE expense.project_id = ? AND expense.created_by = ?
     ORDER BY expense.expense_date DESC, expense.created_at DESC, expense.id DESC`,
    [projectId, req.user.id]
  );
  const [summaryRows] = await db.query(
    `SELECT
       COALESCE(SUM(CASE
         WHEN status != 'refunded' THEN amount
         ELSE 0
       END), 0) AS total_amount,
       COALESCE(SUM(CASE
         WHEN status = 'paid' THEN amount
         ELSE 0
       END), 0) AS paid_amount,
       COALESCE(SUM(CASE
         WHEN status = 'pending' THEN amount
         ELSE 0
       END), 0) AS pending_amount,
       COUNT(*) AS total_count
     FROM project_expenses
     WHERE project_id = ? AND created_by = ?`,
    [projectId, req.user.id]
  );
  if (!rows.length) {
    return success(res, {
      summary: {
        total_amount: Number(summaryRows[0]?.total_amount || 0),
        paid_amount: Number(summaryRows[0]?.paid_amount || 0),
        pending_amount: Number(summaryRows[0]?.pending_amount || 0),
        total_count: Number(summaryRows[0]?.total_count || 0),
      },
      expenses: [],
    });
  }

  const ids = rows.map((item) => item.id);
  const [media] = await db.query(
    `SELECT id, expense_id, media_type, media_url, created_at
     FROM project_expense_media
     WHERE expense_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY id`,
    ids
  );
  const mediaMap = new Map();
  for (const item of media) {
    if (!mediaMap.has(item.expense_id)) mediaMap.set(item.expense_id, []);
    mediaMap.get(item.expense_id).push(item);
  }
  return success(res, {
    summary: {
      total_amount: Number(summaryRows[0]?.total_amount || 0),
      paid_amount: Number(summaryRows[0]?.paid_amount || 0),
      pending_amount: Number(summaryRows[0]?.pending_amount || 0),
      total_count: Number(summaryRows[0]?.total_count || 0),
    },
    expenses: rows.map((item) => ({
      ...item,
      amount: Number(item.amount),
      media: mediaMap.get(item.id) || [],
    })),
  });
}

async function createProjectExpense(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const expenseDate = String(req.body.expense_date || '');
  const category = String(req.body.category || 'other');
  const title = String(req.body.title || '').trim().slice(0, 120);
  const amount = Number(req.body.amount);
  const paymentMethod = String(req.body.payment_method || 'other');
  const payee = String(req.body.payee || '').trim().slice(0, 120);
  const note = String(req.body.note || '').trim().slice(0, 1000);
  const linkUrl = String(req.body.link_url || '').trim().slice(0, 500);
  const status = String(req.body.status || 'paid');
  const files = req.files || [];

  if (!(await canAccessProject(projectId, req.user.id))) {
    await removeUploadedFiles(files);
    return error(res, '项目不存在或无权限', 404);
  }
  if (!expenseDate || Number.isNaN(Date.parse(expenseDate))) {
    await removeUploadedFiles(files);
    return error(res, '支出日期不正确');
  }
  if (!expenseCategories.has(category)) {
    await removeUploadedFiles(files);
    return error(res, '费用分类不正确');
  }
  if (!title) {
    await removeUploadedFiles(files);
    return error(res, '请填写费用名称');
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    await removeUploadedFiles(files);
    return error(res, '费用金额不正确');
  }
  if (!expensePaymentMethods.has(paymentMethod)) {
    await removeUploadedFiles(files);
    return error(res, '支付方式不正确');
  }
  if (!expenseStatuses.has(status)) {
    await removeUploadedFiles(files);
    return error(res, '费用状态不正确');
  }
  if (files.length > PROJECT_UPLOAD_QUOTAS.expenseReceiptLimit) {
    await removeUploadedFiles(files);
    return error(res, `费用票据最多上传 ${PROJECT_UPLOAD_QUOTAS.expenseReceiptLimit} 张`);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_expenses
       (project_id, created_by, expense_date, category, title, amount,
        payment_method, payee, note, include_in_total, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        req.user.id,
        expenseDate,
        category,
        title,
        amount,
        paymentMethod,
        payee || null,
        note || null,
        1,
        status,
      ]
    );
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_expense_media
         (expense_id, media_type, media_url)
         VALUES ${files.map(() => '(?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          result.insertId,
          file.mimetype.startsWith('video/') ? 'video' : 'image',
          file.storageUrl || `${host}/uploads/expenses/${file.filename}`,
        ])
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '费用支出已记录');
  } catch (expenseError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw expenseError;
  } finally {
    connection.release();
  }
}

async function loadProjectExpenseForManage(projectId, expenseId, userId) {
  const [rows] = await db.query(
    `SELECT id, project_id, created_by
     FROM project_expenses
     WHERE id = ? AND project_id = ?
     LIMIT 1`,
    [expenseId, projectId]
  );
  const expense = rows[0];
  if (!expense) return { error: '费用记录不存在', status: 404 };
  const role = await getProjectMemberRole(projectId, userId);
  if (!role) return { error: '项目不存在或无权限', status: 404 };
  if (Number(expense.created_by) !== Number(userId)) {
    return { error: '只能管理自己记录的费用', status: 403 };
  }
  return { expense, role };
}

async function updateProjectExpense(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const expenseId = Number(req.params.expenseId);
  const guard = await loadProjectExpenseForManage(projectId, expenseId, req.user.id);
  if (guard.error) return error(res, guard.error, guard.status);

  const expenseDate = String(req.body.expense_date || '');
  const category = String(req.body.category || 'other');
  const title = String(req.body.title || '').trim().slice(0, 120);
  const amount = Number(req.body.amount);
  const paymentMethod = String(req.body.payment_method || 'other');
  const payee = String(req.body.payee || '').trim().slice(0, 120);
  const note = String(req.body.note || '').trim().slice(0, 1000);
  const status = String(req.body.status || 'paid');

  if (!expenseDate || Number.isNaN(Date.parse(expenseDate))) {
    return error(res, '支出日期不正确');
  }
  if (!expenseCategories.has(category)) return error(res, '费用分类不正确');
  if (!title) return error(res, '请填写费用名称');
  if (!Number.isFinite(amount) || amount <= 0) return error(res, '费用金额不正确');
  if (!expensePaymentMethods.has(paymentMethod)) return error(res, '支付方式不正确');
  if (!expenseStatuses.has(status)) return error(res, '费用状态不正确');

  await db.query(
    `UPDATE project_expenses
     SET expense_date = ?, category = ?, title = ?, amount = ?,
         payment_method = ?, payee = ?, note = ?, include_in_total = ?,
         status = ?
     WHERE id = ? AND project_id = ?`,
    [
      expenseDate,
      category,
      title,
      amount,
      paymentMethod,
      payee || null,
      note || null,
      1,
      status,
      expenseId,
      projectId,
    ]
  );
  return success(res, { id: expenseId, updated: true }, '费用支出已更新');
}

async function deleteProjectExpense(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const expenseId = Number(req.params.expenseId);
  const guard = await loadProjectExpenseForManage(projectId, expenseId, req.user.id);
  if (guard.error) return error(res, guard.error, guard.status);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM project_expense_media WHERE expense_id = ?', [expenseId]);
    await connection.query('DELETE FROM project_expenses WHERE id = ? AND project_id = ?', [
      expenseId,
      projectId,
    ]);
    await connection.commit();
    return success(res, { id: expenseId, deleted: true }, '费用支出已删除');
  } catch (deleteError) {
    await connection.rollback();
    throw deleteError;
  } finally {
    connection.release();
  }
}

async function getProjectDesignDocuments(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT doc.id, doc.project_id, doc.version_group_id, doc.version_no,
            doc.is_current, doc.superseded_by,
            doc.category, doc.space_key, doc.title, doc.file_url,
            doc.storage_key, doc.preview_url, doc.thumbnail_url,
            doc.preview_status, doc.preview_type,
            doc.file_type, doc.mime_type, doc.file_size, doc.original_name,
            doc.version_note, doc.status, doc.uploaded_by, doc.reviewed_by,
            doc.reviewed_at, doc.confirmed_at, doc.voided_at,
            doc.created_at, doc.updated_at,
            uploader.nickname AS uploader_name, uploader.avatar AS uploader_avatar,
            reviewer.nickname AS reviewer_name
     FROM project_design_documents doc
     JOIN users uploader ON uploader.id = doc.uploaded_by
     LEFT JOIN users reviewer ON reviewer.id = doc.reviewed_by
     WHERE doc.project_id = ?
     ORDER BY doc.is_current DESC,
              FIELD(doc.status, 'draft', 'pending', 'revision_requested', 'confirmed', 'superseded', 'voided', 'archived'),
              doc.created_at DESC, doc.id DESC`,
    [projectId]
  );
  if (!rows.length) return success(res, []);
  const groupIds = [...new Set(rows.map((row) => row.version_group_id || row.id))];
  const [references] = await db.query(
    `SELECT ref.id, ref.project_id, ref.disclosure_id, ref.design_document_id,
            ref.design_document_version_id, ref.purpose, ref.snapshot_title,
            ref.snapshot_version_no, ref.snapshot_file_url,
            ref.snapshot_category, ref.snapshot_space_key, ref.created_at,
            handover.title AS disclosure_title, handover.status AS disclosure_status
     FROM construction_disclosure_documents ref
     JOIN project_handovers handover ON handover.id = ref.disclosure_id
     WHERE ref.project_id = ?
       AND ref.design_document_id IN (${groupIds.map(() => '?').join(', ')})
     ORDER BY ref.created_at DESC, ref.id DESC`,
    [projectId, ...groupIds]
  );
  const [revisionRequests] = await db.query(
    `SELECT request.id, request.project_id, request.design_document_id,
            request.design_document_version_id, request.version_no,
            request.requested_by, request.assignee_id, request.reason,
            request.status, request.created_at, request.updated_at,
            requester.nickname AS requester_name,
            assignee.nickname AS assignee_name
     FROM project_design_document_revision_requests request
     JOIN users requester ON requester.id = request.requested_by
     LEFT JOIN users assignee ON assignee.id = request.assignee_id
     WHERE request.project_id = ?
       AND request.design_document_id IN (${groupIds.map(() => '?').join(', ')})
     ORDER BY request.created_at DESC, request.id DESC`,
    [projectId, ...groupIds]
  );
  const referencesByGroup = new Map();
  const referencesByVersion = new Map();
  for (const item of references) {
    if (!referencesByGroup.has(item.design_document_id)) {
      referencesByGroup.set(item.design_document_id, []);
    }
    if (!referencesByVersion.has(item.design_document_version_id)) {
      referencesByVersion.set(item.design_document_version_id, []);
    }
    referencesByGroup.get(item.design_document_id).push(item);
    referencesByVersion.get(item.design_document_version_id).push(item);
  }
  const revisionRequestsByGroup = new Map();
  const revisionRequestsByVersion = new Map();
  for (const item of revisionRequests) {
    if (!revisionRequestsByGroup.has(item.design_document_id)) {
      revisionRequestsByGroup.set(item.design_document_id, []);
    }
    if (!revisionRequestsByVersion.has(item.design_document_version_id)) {
      revisionRequestsByVersion.set(item.design_document_version_id, []);
    }
    revisionRequestsByGroup.get(item.design_document_id).push(item);
    revisionRequestsByVersion.get(item.design_document_version_id).push(item);
  }
  const versionsByGroup = new Map();
  for (const row of rows) {
    const groupId = row.version_group_id || row.id;
    if (!versionsByGroup.has(groupId)) versionsByGroup.set(groupId, []);
    versionsByGroup.get(groupId).push({
      id: row.id,
      version_group_id: groupId,
      version_no: row.version_no || 1,
      is_current: Boolean(row.is_current),
      status: row.status,
      title: row.title,
      file_url: normalizeDesignStorageUrl(row.file_url, req),
      preview_url: normalizeDesignStorageUrl(row.preview_url, req),
      thumbnail_url: normalizeDesignStorageUrl(row.thumbnail_url, req),
      preview_status: row.preview_status,
      preview_type: row.preview_type,
      created_at: row.created_at,
      confirmed_at: row.confirmed_at,
      voided_at: row.voided_at,
      disclosure_references: referencesByVersion.get(row.id) || [],
      revision_requests: revisionRequestsByVersion.get(row.id) || [],
    });
  }
  return success(
    res,
    rows.map((row) => {
      const groupId = row.version_group_id || row.id;
      return {
        ...row,
        original_name: normalizeUploadedOriginalName(row.original_name),
        file_url: normalizeDesignStorageUrl(row.file_url, req),
        preview_url: normalizeDesignStorageUrl(row.preview_url, req),
        thumbnail_url: normalizeDesignStorageUrl(row.thumbnail_url, req),
        version_group_id: groupId,
        is_current: row.is_current === null || row.is_current === undefined
          ? true
          : Boolean(row.is_current),
        disclosure_references: referencesByVersion.get(row.id) || [],
        group_disclosure_references: referencesByGroup.get(groupId) || [],
        revision_requests: revisionRequestsByVersion.get(row.id) || [],
        group_revision_requests: revisionRequestsByGroup.get(groupId) || [],
        latest_revision_request: (revisionRequestsByVersion.get(row.id) || [])[0] || null,
        version_history: versionsByGroup.get(groupId) || [],
      };
    })
  );
}

function getDesignDocumentFileType(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (file.mimetype.startsWith('image/')) return 'image';
  if (extension === '.pdf' || file.mimetype === 'application/pdf') return 'pdf';
  if (['.doc', '.docx'].includes(extension)) return 'word';
  if (['.xls', '.xlsx'].includes(extension)) return 'excel';
  if (['.dwg', '.dxf'].includes(extension)) return 'cad';
  if (['.zip', '.rar', '.7z'].includes(extension)) return 'archive';
  return 'file';
}

function normalizeUploadedOriginalName(originalName) {
  const value = String(originalName || '').trim();
  if (!value) return value;
  if (!/[ÃÂÄÅÆÇÈÉåæäçéè]/.test(value)) return value;
  try {
    const decoded = Buffer.from(value, 'latin1').toString('utf8');
    return decoded.includes('\uFFFD') ? value : decoded;
  } catch (_) {
    return value;
  }
}

function normalizeDesignStorageUrl(value, req) {
  const raw = String(value || '').trim();
  if (!raw) return value;
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch (_) {}
  if (pathname.startsWith('/storage/')) {
    return `${req.protocol}://${req.get('host')}/api${pathname}`;
  }
  return value;
}

async function getProjectDesignDocumentQuotaError(projectId, userId) {
  const totalDocuments = await countRows(
    'SELECT COUNT(*) AS total FROM project_design_documents WHERE project_id = ?',
    [projectId]
  );
  if (totalDocuments >= PROJECT_UPLOAD_QUOTAS.designDocumentsPerProjectLimit) {
    return `同一项目最多保存 ${PROJECT_UPLOAD_QUOTAS.designDocumentsPerProjectLimit} 份设计文档，请先删除或归档不需要的资料`;
  }
  const todayDocuments = await countRows(
    `SELECT COUNT(*) AS total FROM project_design_documents
     WHERE project_id = ? AND uploaded_by = ? AND created_at >= CURDATE()`,
    [projectId, userId]
  );
  if (todayDocuments >= PROJECT_UPLOAD_QUOTAS.designDocumentsDailyLimit) {
    return `同一项目每天最多新增 ${PROJECT_UPLOAD_QUOTAS.designDocumentsDailyLimit} 份设计文档，请明天再试`;
  }
  return '';
}

async function uploadProjectDesignDocument(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role)) {
    await removeUploadedFiles(req.file ? [req.file] : []);
    return error(res, '项目不存在或无上传权限', 404);
  }
  if (!req.file) return error(res, '请选择要上传的设计资料');
  const designDocumentQuotaError = await getProjectDesignDocumentQuotaError(
    projectId,
    req.user.id
  );
  if (designDocumentQuotaError) {
    await removeUploadedFiles([req.file]);
    return error(res, designDocumentQuotaError, 429);
  }
  const fileType = getDesignDocumentFileType(req.file);
  const originalName = normalizeUploadedOriginalName(req.file.originalname);
  try {
    const stored = await storageService.storeDesignDocument({
      req,
      file: req.file,
      fileType,
    });
    await removeUploadedFiles([req.file]);
    return success(res, {
      url: stored.fileUrl,
      storage_key: stored.storageKey,
      preview_url: stored.previewUrl,
      thumbnail_url: stored.thumbnailUrl,
      preview_status: stored.previewStatus,
      preview_type: stored.previewType,
      file_type: fileType,
      mime_type: req.file.mimetype,
      file_size: req.file.size,
      original_name: originalName,
    });
  } catch (uploadError) {
    await removeUploadedFiles([req.file]);
    throw uploadError;
  }
}

async function createProjectDesignDocument(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role)) {
    return error(res, '项目不存在或无上传权限', 404);
  }
  const category = String(req.body.category || 'other');
  const spaceKey = String(req.body.space_key || 'whole_house').trim().slice(0, 32);
  const title = String(req.body.title || '').trim().slice(0, 120);
  const fileUrl = String(req.body.file_url || '').trim();
  const storageKey = String(req.body.storage_key || '').trim().slice(0, 500);
  const previewUrl = String(req.body.preview_url || '').trim().slice(0, 500);
  const thumbnailUrl = String(req.body.thumbnail_url || '').trim().slice(0, 500);
  const requestedPreviewStatus = String(req.body.preview_status || '').trim();
  const requestedPreviewType = String(req.body.preview_type || '').trim();
  const fileType = String(req.body.file_type || 'image').trim().slice(0, 32);
  const mimeType = String(req.body.mime_type || '').trim().slice(0, 120);
  const fileSize = Math.max(0, Number(req.body.file_size || 0));
  const originalName = String(req.body.original_name || '').trim().slice(0, 255);
  const versionNote = String(req.body.version_note || '').trim().slice(0, 500);
  const requestedVersionGroupId = req.body.version_group_id
    ? Number(req.body.version_group_id)
    : null;
  if (!designDocumentCategories.has(category)) {
    return error(res, '设计资料分类不正确');
  }
  if (!title) return error(res, '请填写资料标题');
  if (!fileUrl) {
    return error(res, fileType === 'webview_link' ? '请填写链接地址' : '请上传设计资料文件');
  }
  const designDocumentQuotaError = await getProjectDesignDocumentQuotaError(
    projectId,
    req.user.id
  );
  if (designDocumentQuotaError) {
    return error(res, designDocumentQuotaError, 429);
  }
  const previewStatuses = new Set(['pending', 'ready', 'failed', 'none']);
  const previewTypes = new Set(['image', 'pdf', 'none']);
  const previewStatus = previewStatuses.has(requestedPreviewStatus)
    ? requestedPreviewStatus
    : (previewUrl ? 'ready' : 'none');
  const previewType = previewTypes.has(requestedPreviewType)
    ? requestedPreviewType
    : (fileType === 'image' ? 'image' : fileType === 'pdf' ? 'pdf' : 'none');
  if (fileType === 'webview_link') {
    let parsedUrl;
    try {
      parsedUrl = new URL(fileUrl);
    } catch (_) {
      return error(res, '链接地址不正确');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      return error(res, '链接地址只支持 http 或 https');
    }
    if (category !== 'rendering') {
      return error(res, '链接资料仅支持添加到效果图');
    }
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    let versionGroupId = requestedVersionGroupId;
    let versionNo = 1;
    let currentDocument = null;
    let hasDisclosureReferences = false;
    if (versionGroupId) {
      const [currentRows] = await connection.query(
        `SELECT id, version_no
         FROM project_design_documents
         WHERE project_id = ? AND version_group_id = ? AND is_current = 1
         ORDER BY version_no DESC, id DESC
         LIMIT 1
         FOR UPDATE`,
        [projectId, versionGroupId]
      );
      currentDocument = currentRows[0] || null;
      const [maxRows] = await connection.query(
        `SELECT COALESCE(MAX(version_no), 0) AS max_version
         FROM project_design_documents
         WHERE project_id = ? AND version_group_id = ?`,
        [projectId, versionGroupId]
      );
      versionNo = Number(maxRows[0]?.max_version || 0) + 1;
      if (currentDocument) {
        const [referenceRows] = await connection.query(
          `SELECT id
           FROM construction_disclosure_documents
           WHERE project_id = ? AND design_document_version_id = ?
           LIMIT 1`,
          [projectId, currentDocument.id]
        );
        hasDisclosureReferences = Boolean(referenceRows[0]);
      }
    }
    const [result] = await connection.query(
      `INSERT INTO project_design_documents
       (project_id, version_group_id, version_no, is_current, category,
        space_key, title, file_url, storage_key, preview_url, thumbnail_url,
        preview_status, preview_type, file_type, mime_type, file_size,
        original_name, version_note, status, uploaded_by)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        projectId,
        versionGroupId,
        versionNo,
        category,
        spaceKey || 'whole_house',
        title,
        fileUrl,
        storageKey || null,
        previewUrl || null,
        thumbnailUrl || null,
        previewStatus,
        previewType,
        fileType || 'image',
        mimeType || null,
        Number.isFinite(fileSize) ? fileSize : 0,
        originalName || null,
        versionNote || null,
        req.user.id,
      ]
    );
    const documentId = result.insertId;
    if (!versionGroupId) {
      versionGroupId = documentId;
      await connection.query(
        'UPDATE project_design_documents SET version_group_id = ? WHERE id = ?',
        [versionGroupId, documentId]
      );
    }
    if (currentDocument) {
      await connection.query(
        `UPDATE project_design_documents
         SET is_current = 0, status = 'superseded', superseded_by = ?
         WHERE id = ?`,
        [documentId, currentDocument.id]
      );
    }
    await connection.commit();
    return success(
      res,
      {
        id: documentId,
        version_group_id: versionGroupId,
        version_no: versionNo,
        has_disclosure_references: hasDisclosureReferences,
        disclosure_warning: hasDisclosureReferences
          ? '已有设计交底引用旧版本，是否需要重新交底？'
          : null,
      },
      hasDisclosureReferences
        ? '设计资料新版已上传。已有设计交底引用旧版本，是否需要重新交底？'
        : '设计资料已上传'
    );
  } catch (createError) {
    await connection.rollback();
    throw createError;
  } finally {
    connection.release();
  }
}

// Future physical-delete routes must call this guard before removing a design
// document row or file. Documents referenced by design handovers are
// immutable evidence and should only be voided or archived.
async function canDeleteDesignDocument(documentId, connection = db) {
  const [references] = await connection.query(
    `SELECT id
     FROM construction_disclosure_documents
     WHERE design_document_version_id = ? OR design_document_id = ?
     LIMIT 1`,
    [documentId, documentId]
  );
  if (references[0]) {
    return {
      canDelete: false,
      reason: '该资料已被设计交底引用，只能作废或归档',
    };
  }
  return { canDelete: true, reason: null };
}

async function updateProjectDesignDocument(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const documentId = Number(req.params.documentId);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role)) {
    return error(res, '项目不存在或无编辑权限', 404);
  }
  const category = String(req.body.category || 'other');
  const spaceKey = String(req.body.space_key || 'whole_house').trim().slice(0, 32);
  const title = String(req.body.title || '').trim().slice(0, 120);
  const versionNote = String(req.body.version_note || '').trim().slice(0, 500);
  if (!designDocumentCategories.has(category)) {
    return error(res, '设计资料分类不正确');
  }
  if (!title) return error(res, '请填写资料标题');
  const [documents] = await db.query(
    `SELECT id, file_type
     FROM project_design_documents
     WHERE id = ? AND project_id = ?`,
    [documentId, projectId]
  );
  const document = documents[0];
  if (!document) return error(res, '设计资料不存在', 404);
  if (document.file_type === 'webview_link' && category !== 'rendering') {
    return error(res, '链接资料仅支持添加到效果图');
  }
  await db.query(
    `UPDATE project_design_documents
     SET category = ?, space_key = ?, title = ?, version_note = ?
     WHERE id = ? AND project_id = ?`,
    [
      category,
      spaceKey || 'whole_house',
      title,
      versionNote || null,
      documentId,
      projectId,
    ]
  );
  return success(res, null, '设计资料已更新');
}

async function updateProjectDesignDocumentStatus(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const documentId = Number(req.params.documentId);
  if (!(await isOwnerSide(projectId, req.user.id))) {
    return error(res, '只有业主方可以确认设计资料', 403);
  }
  const status = String(req.body.status || '');
  if (!designDocumentStatuses.has(status) || ['draft', 'pending', 'superseded'].includes(status)) {
    return error(res, '设计资料状态不正确');
  }
  const revisionReason = String(req.body.revision_reason || '').trim().slice(0, 500);
  const assigneeId = req.body.assignee_id ? Number(req.body.assignee_id) : null;
  if (status === 'revision_requested') {
    if (!revisionReason) return error(res, '请填写修改原因');
    if (assigneeId) {
      const assignee = await requireActiveProjectMember(projectId, assigneeId);
      if (!assignee) return error(res, '修改人不是项目成员');
    }
  }
  const [documents] = await db.query(
    `SELECT id, version_group_id, version_no, title, uploaded_by
     FROM project_design_documents
     WHERE id = ? AND project_id = ?`,
    [documentId, projectId]
  );
  const document = documents[0];
  if (!document) return error(res, '设计资料不存在', 404);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    if (status === 'revision_requested') {
      await connection.query(
        `INSERT INTO project_design_document_revision_requests
         (project_id, design_document_id, design_document_version_id,
          version_no, requested_by, assignee_id, reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
        [
          projectId,
          document.version_group_id || document.id,
          document.id,
          document.version_no || 1,
          req.user.id,
          assigneeId || null,
          revisionReason,
        ]
      );
    }
    const [result] = await connection.query(
      `UPDATE project_design_documents
       SET status = ?, reviewed_by = ?, reviewed_at = NOW(),
           confirmed_at = CASE WHEN ? = 'confirmed' THEN NOW() ELSE confirmed_at END,
           voided_at = CASE WHEN ? = 'voided' THEN NOW() ELSE voided_at END,
           is_current = CASE WHEN ? IN ('voided', 'archived') THEN 0 ELSE is_current END
       WHERE id = ? AND project_id = ?`,
      [status, req.user.id, status, status, status, documentId, projectId]
    );
    if (result.affectedRows === 0) {
      await connection.rollback();
      return error(res, '设计资料不存在', 404);
    }
    if (status === 'confirmed' || status === 'revision_requested') {
      await emitProjectEvent(
        status === 'confirmed'
          ? ProjectEventType.DESIGN_DOCUMENT_CONFIRMED
          : ProjectEventType.DESIGN_DOCUMENT_REVISION_REQUESTED,
        {
          projectId,
          actorId: req.user.id,
          targetUserIds: await getDesignDocumentNotificationTargets(
            projectId,
            document.uploaded_by,
            connection
          ),
          entityType: 'design_document',
          entityId: documentId,
          title: status === 'confirmed' ? '设计资料已确认' : '设计资料需修改',
          content: document.title || '设计资料',
          route: 'project_design_documents',
          deepLink: { projectId, documentId },
        },
        connection
      );
    }
    await connection.commit();
    return success(res, null, '设计资料状态已更新');
  } catch (statusError) {
    await connection.rollback();
    throw statusError;
  } finally {
    connection.release();
  }
}

async function getProjectHandovers(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT handover.id, handover.project_id, handover.stage_id, handover.title,
            handover.content, handover.target_user_id, handover.status,
            handover.version_no,
            handover.created_by, handover.confirmed_by, handover.confirmed_at,
            handover.created_at, handover.updated_at,
            creator.nickname AS creator_name, creator.avatar AS creator_avatar,
            target.nickname AS target_name, target.avatar AS target_avatar,
            confirmer.nickname AS confirmer_name
     FROM project_handovers handover
     JOIN users creator ON creator.id = handover.created_by
     LEFT JOIN users target ON target.id = handover.target_user_id
     LEFT JOIN users confirmer ON confirmer.id = handover.confirmed_by
     WHERE handover.project_id = ?
     ORDER BY FIELD(handover.status, 'draft', 'pending_confirm', 'pending',
                    'revision_needed', 'needs_supplement', 'confirmed', 'archived'),
              handover.created_at DESC, handover.id DESC`,
    [projectId]
  );
  if (!rows.length) return success(res, []);
  const ids = rows.map((item) => item.id);
  const [media] = await db.query(
    `SELECT id, handover_id, media_type, media_url, uploaded_by, created_at
     FROM project_handover_media
     WHERE handover_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY id`,
    ids
  );
  const mediaMap = new Map();
  for (const item of media) {
    if (!mediaMap.has(item.handover_id)) mediaMap.set(item.handover_id, []);
    mediaMap.get(item.handover_id).push(item);
  }
  const [documents] = await db.query(
    `SELECT ref.id, ref.project_id, ref.disclosure_id,
            ref.design_document_id, ref.design_document_version_id,
            ref.purpose, ref.snapshot_title, ref.snapshot_version_no,
            ref.snapshot_file_url, ref.snapshot_category,
            ref.snapshot_space_key, ref.created_at
     FROM construction_disclosure_documents ref
     WHERE ref.disclosure_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY ref.id`,
    ids
  );
  const documentMap = new Map();
  for (const item of documents) {
    if (!documentMap.has(item.disclosure_id)) documentMap.set(item.disclosure_id, []);
    documentMap.get(item.disclosure_id).push(item);
  }
  const [notes] = await db.query(
    `SELECT note.id, note.project_id, note.handover_id, note.content,
            note.created_by, note.created_at, author.nickname AS creator_name,
            author.avatar AS creator_avatar
     FROM project_handover_notes note
     JOIN users author ON author.id = note.created_by
     WHERE note.handover_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY note.created_at ASC, note.id ASC`,
    ids
  );
  const noteMap = new Map();
  const noteIds = notes.map((item) => item.id);
  let noteMedia = [];
  if (noteIds.length) {
    const [rows] = await db.query(
      `SELECT id, note_id, media_type, media_url, uploaded_by, created_at
       FROM project_handover_note_media
       WHERE note_id IN (${noteIds.map(() => '?').join(', ')})
       ORDER BY id`,
      noteIds
    );
    noteMedia = rows;
  }
  const noteMediaMap = new Map();
  for (const item of noteMedia) {
    if (!noteMediaMap.has(item.note_id)) noteMediaMap.set(item.note_id, []);
    noteMediaMap.get(item.note_id).push(item);
  }
  for (const item of notes) {
    if (!noteMap.has(item.handover_id)) noteMap.set(item.handover_id, []);
    noteMap.get(item.handover_id).push({
      ...item,
      media: noteMediaMap.get(item.id) || [],
    });
  }
  return success(
    res,
    rows.map((item) => ({
      ...item,
      stage_name: stages.find((stage) => stage.id === Number(item.stage_id))?.name || null,
      media: mediaMap.get(item.id) || [],
      design_documents: documentMap.get(item.id) || [],
      notes: noteMap.get(item.id) || [],
    }))
  );
}

async function createProjectHandoverNote(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const handoverId = Number(req.params.handoverId);
  const files = req.files || [];
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) {
    await removeUploadedFiles(files);
    return error(res, '只有当前项目成员可以添加备注', 403);
  }
  const content = String(req.body.content || '').trim().slice(0, 1000);
  if (!content && files.length === 0) {
    return error(res, '请填写备注文字或添加照片');
  }
  const [handovers] = await db.query(
    'SELECT id FROM project_handovers WHERE id = ? AND project_id = ?',
    [handoverId, projectId]
  );
  if (!handovers.length) {
    await removeUploadedFiles(files);
    return error(res, '设计交底不存在', 404);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_handover_notes
       (project_id, handover_id, content, created_by)
       VALUES (?, ?, ?, ?)`,
      [projectId, handoverId, content || null, req.user.id]
    );
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_handover_note_media
         (note_id, media_type, media_url, uploaded_by)
         VALUES ${files.map(() => '(?, ?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          result.insertId,
          'image',
          file.storageUrl || `${host}/uploads/handover-notes/${file.filename}`,
          req.user.id,
        ])
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '备注已添加');
  } catch (noteError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw noteError;
  } finally {
    connection.release();
  }
}

async function getProjectDesignHandoverItems(req, res) {
  const projectId = Number(req.params.id);
  const stageId = req.query.stage_id ? Number(req.query.stage_id) : null;
  const usage = String(req.query.usage || 'progress').trim();
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const usageFilter = usage === 'inspection'
    ? "AND item.check_type IN ('inspection_check', 'both')"
    : "AND item.check_type IN ('progress_note', 'both')";
  const stageFilter = stageId
    ? usage === 'progress'
      ? 'AND item.related_stage_id = ?'
      : 'AND (item.related_stage_id = ? OR item.related_stage_id IS NULL)'
    : '';
  const params = stageId ? [projectId, stageId] : [projectId];
  const [rows] = await db.query(
    `SELECT item.id, item.project_id, item.design_handover_id,
            item.related_stage_id, item.importance, item.check_type,
            item.source_section, item.summary, item.sort_order,
            handover.title AS source_title,
            handover.version_no AS source_version_no
     FROM project_design_handover_items item
     JOIN project_handovers handover ON handover.id = item.design_handover_id
     WHERE item.project_id = ?
       AND handover.status = 'confirmed'
       ${stageFilter}
       ${usageFilter}
     ORDER BY item.related_stage_id IS NULL ASC,
              FIELD(item.importance, 'critical', 'important', 'normal'),
              item.sort_order, item.id`,
    params
  );
  if (rows.length) return success(res, rows);
  const [handovers] = await db.query(
    `SELECT id, project_id, stage_id, title, content, version_no
     FROM project_handovers
     WHERE project_id = ?
       AND status = 'confirmed'
       ${stageId
         ? usage === 'progress'
           ? 'AND stage_id = ?'
           : 'AND (stage_id = ? OR stage_id IS NULL)'
         : ''}
     ORDER BY stage_id IS NULL ASC, confirmed_at DESC, id DESC
     LIMIT 5`,
    stageId ? [projectId, stageId] : [projectId]
  );
  const fallbackItems = handovers.flatMap((handover) =>
    buildDesignHandoverItems({
      projectId,
      handoverId: handover.id,
      stageId: handover.stage_id,
      content: handover.content,
    })
      .filter((item) =>
        usage === 'inspection'
          ? ['inspection_check', 'both'].includes(item.checkType)
          : ['progress_note', 'both'].includes(item.checkType)
      )
      .map((item, index) => ({
        id: 0,
        project_id: projectId,
        design_handover_id: handover.id,
        related_stage_id: item.relatedStageId,
        importance: item.importance,
        check_type: item.checkType,
        source_section: item.sourceSection,
        summary: item.summary,
        sort_order: item.sortOrder + index,
        source_title: handover.title,
        source_version_no: handover.version_no || 1,
      }))
  );
  return success(res, fallbackItems);
}

async function createProjectHandover(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  const files = req.files || [];
  if (!['designer', 'project_manager', 'project_supervisor'].includes(role)) {
    await removeUploadedFiles(files);
    return error(res, '只有设计师、项目经理或管理员可以创建设计交底', 403);
  }
  if (files.length > PROJECT_UPLOAD_QUOTAS.handoverImageLimit) {
    await removeUploadedFiles(files);
    return error(res, `设计交底图片最多上传 ${PROJECT_UPLOAD_QUOTAS.handoverImageLimit} 张`);
  }
  const todayHandoverImages = await countRows(
    `SELECT COUNT(*) AS total
     FROM project_handover_media media
     JOIN project_handovers handover ON handover.id = media.handover_id
     WHERE handover.project_id = ? AND media.uploaded_by = ?
       AND media.created_at >= CURDATE()`,
    [projectId, req.user.id]
  );
  if (todayHandoverImages + files.length > PROJECT_UPLOAD_QUOTAS.handoverImagesDailyLimit) {
    await removeUploadedFiles(files);
    return error(res, `同一项目每天最多上传 ${PROJECT_UPLOAD_QUOTAS.handoverImagesDailyLimit} 张交底图片，请明天再试`, 429);
  }
  const title = String(req.body.title || '').trim().slice(0, 120);
  const content = String(req.body.content || '').trim().slice(0, 3000);
  const linkUrl = String(req.body.link_url || '').trim().slice(0, 500);
  const stageId = req.body.stage_id ? Number(req.body.stage_id) : null;
  const targetUserId = req.body.target_user_id
    ? Number(req.body.target_user_id)
    : null;
  const rawDesignDocumentIds = (() => {
    if (Array.isArray(req.body.design_document_ids)) return req.body.design_document_ids;
    if (typeof req.body.design_document_ids === 'string') {
      try {
        const parsed = JSON.parse(req.body.design_document_ids);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {
        return req.body.design_document_ids.split(',');
      }
    }
    return [];
  })();
  const designDocumentIds = [
    ...new Set(
      rawDesignDocumentIds
        .map((item) => Number(item))
        .filter((item) => Number.isInteger(item) && item > 0)
    ),
  ];
  if (!title) {
    await removeUploadedFiles(files);
    return error(res, '请填写设计交底标题');
  }
  if (!content) {
    await removeUploadedFiles(files);
    return error(res, '请填写设计交底内容');
  }
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
    await removeUploadedFiles(files);
    return error(res, '补充资料链接必须以 http:// 或 https:// 开头');
  }
  if (stageId !== null && !stages.some((stage) => stage.id === stageId)) {
    await removeUploadedFiles(files);
    return error(res, '装修阶段不正确');
  }
  if (targetUserId !== null) {
    const member = await requireActiveProjectMember(projectId, targetUserId);
    if (!member) {
      await removeUploadedFiles(files);
      return error(res, '指定人员不是当前项目成员');
    }
  }
  let referencedDocuments = [];
  if (!designDocumentIds.length) {
    await removeUploadedFiles(files);
    return error(res, '请选择引用设计资料');
  }
  if (designDocumentIds.length) {
    const [documents] = await db.query(
      `SELECT id, project_id, version_group_id, version_no, title, file_url,
              category, space_key, status, is_current
       FROM project_design_documents
       WHERE project_id = ? AND id IN (${designDocumentIds.map(() => '?').join(', ')})`,
      [projectId, ...designDocumentIds]
    );
    if (documents.length !== designDocumentIds.length) {
      await removeUploadedFiles(files);
      return error(res, '引用的设计资料不存在');
    }
    const invalidReference = documents.find((document) => !Boolean(document.is_current));
    if (invalidReference) {
      await removeUploadedFiles(files);
      return error(res, '设计交底只能引用当前版本的设计资料');
    }
    referencedDocuments = documents;
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_handovers
       (project_id, stage_id, title, content, target_user_id, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'pending_confirm', ?)`,
      [projectId, stageId, title, content, targetUserId, req.user.id]
    );
    if (files.length || linkUrl) {
      const host = `${req.protocol}://${req.get('host')}`;
      const mediaRows = files.map((file) => ({
        type: file.mimetype.startsWith('image/') ? 'image' : 'file',
        url: file.storageUrl || `${host}/uploads/handovers/${file.filename}`,
      }));
      if (linkUrl) mediaRows.push({ type: 'link', url: linkUrl });
      await connection.query(
        `INSERT INTO project_handover_media
         (handover_id, media_type, media_url, uploaded_by)
         VALUES ${mediaRows.map(() => '(?, ?, ?, ?)').join(', ')}`,
        mediaRows.flatMap((media) => [
          result.insertId,
          media.type,
          media.url,
          req.user.id,
        ])
      );
    }
    await replaceDesignHandoverItems(connection, {
      projectId,
      handoverId: result.insertId,
      stageId,
      content,
    });
    if (referencedDocuments.length) {
      await connection.query(
        `INSERT INTO construction_disclosure_documents
         (project_id, disclosure_id, design_document_id,
          design_document_version_id, purpose, snapshot_title,
          snapshot_version_no, snapshot_file_url, snapshot_category,
          snapshot_space_key)
         VALUES ${referencedDocuments.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
        referencedDocuments.flatMap((document) => [
          projectId,
          result.insertId,
          document.version_group_id || document.id,
          document.id,
          '设计交底依据',
          document.title,
          document.version_no || 1,
          document.file_url,
          document.category || 'other',
          document.space_key || 'whole_house',
        ])
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '设计交底已发布，等待项目经理确认');
  } catch (handoverError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw handoverError;
  } finally {
    connection.release();
  }
}

async function updateProjectHandoverStatus(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const handoverId = Number(req.params.handoverId);
  const rawStatus = String(req.body.status || '');
  const status = rawStatus === 'needs_supplement' ? 'revision_needed' : rawStatus;
  if (!handoverStatuses.has(status) || ['pending', 'pending_confirm', 'draft'].includes(status)) {
    return error(res, '设计交底状态不正确');
  }
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  const [rows] = await db.query(
    `SELECT id, target_user_id, status, title, created_by FROM project_handovers
     WHERE id = ? AND project_id = ?`,
    [handoverId, projectId]
  );
  const handover = rows[0];
  if (!handover) return error(res, '设计交底不存在', 404);
  if (handover.status === 'confirmed' && status !== 'confirmed' && status !== 'archived') {
    return error(res, '设计交底已确认，不能直接修改原内容，请创建新版本或追加补充说明', 409);
  }
  const canReview =
    isOwnerSideRole(role) ||
    (['project_manager', 'project_supervisor', 'supervisor', 'manager'].includes(role) &&
      (!handover.target_user_id ||
        Number(handover.target_user_id) === Number(req.user.id)));
  if (!canReview) return error(res, '只有业主方或指定项目成员可以确认或要求补充设计交底', 403);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE project_handovers
       SET status = ?,
           confirmed_by = CASE
             WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN ?
             ELSE confirmed_by
           END,
           confirmed_at = CASE
             WHEN ? = 'confirmed' AND confirmed_at IS NULL THEN NOW()
             ELSE confirmed_at
           END
       WHERE id = ? AND project_id = ?`,
      [status, status, req.user.id, status, handoverId, projectId]
    );
    if (status === 'confirmed' || status === 'revision_needed') {
      await emitProjectEvent(
        status === 'confirmed'
          ? ProjectEventType.DESIGN_HANDOVER_CONFIRMED
          : ProjectEventType.DESIGN_HANDOVER_REVISION_REQUESTED,
        {
          projectId,
          actorId: req.user.id,
          targetUserIds: uniqueUserIds(
            [handover.created_by],
            await getOwnerSideMemberUserIds(projectId, connection)
          ),
          entityType: 'design_handover',
          entityId: handoverId,
          title: status === 'confirmed' ? '设计交底已确认' : '设计交底需补充',
          content: handover.title || '设计交底',
          route: 'project_handover',
          deepLink: { projectId, handoverId },
        },
        connection
      );
    }
    await connection.commit();
    return success(res, null, '设计交底状态已更新');
  } catch (handoverStatusError) {
    await connection.rollback();
    throw handoverStatusError;
  } finally {
    connection.release();
  }
}

async function getProjectMaterials(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT material.id, material.project_id, material.name, material.category,
            material.location, material.space_tags, material.brand_model, material.quantity,
            material.unit, material.budget_unit_price, material.actual_unit_price,
            material.supplier_type, material.arrival_status,
            material.confirm_status, material.note, material.created_by,
            material.confirmed_by, material.confirmed_at,
            material.created_at, material.updated_at,
            creator.nickname AS creator_name,
            confirmer.nickname AS confirmer_name
     FROM project_material_items material
     JOIN users creator ON creator.id = material.created_by
     LEFT JOIN users confirmer ON confirmer.id = material.confirmed_by
     WHERE material.project_id = ?
     ORDER BY FIELD(material.confirm_status, 'pending', 'confirmed'),
              FIELD(material.arrival_status, 'pending', 'ordered', 'arrived', 'installed', 'returned'),
              material.created_at DESC, material.id DESC`,
    [projectId]
  );
  if (!rows.length) return success(res, []);
  const ids = rows.map((item) => item.id);
  const [media] = await db.query(
    `SELECT id, material_id, media_type, media_url, uploaded_by, created_at
     FROM project_material_media
     WHERE material_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY id`,
    ids
  );
  const mediaMap = new Map();
  for (const item of media) {
    if (!mediaMap.has(item.material_id)) mediaMap.set(item.material_id, []);
    mediaMap.get(item.material_id).push(item);
  }
  const [notes] = await db.query(
    `SELECT note.id, note.project_id, note.material_id, note.content,
            note.created_by, note.created_at, author.nickname AS creator_name,
            author.avatar AS creator_avatar
     FROM project_material_notes note
     JOIN users author ON author.id = note.created_by
     WHERE note.material_id IN (${ids.map(() => '?').join(', ')})
     ORDER BY note.created_at ASC, note.id ASC`,
    ids
  );
  const noteIds = notes.map((item) => item.id);
  let noteMedia = [];
  if (noteIds.length) {
    const [rows] = await db.query(
      `SELECT id, note_id, media_type, media_url, uploaded_by, created_at
       FROM project_material_note_media
       WHERE note_id IN (${noteIds.map(() => '?').join(', ')})
       ORDER BY id`,
      noteIds
    );
    noteMedia = rows;
  }
  const noteMediaMap = new Map();
  for (const item of noteMedia) {
    if (!noteMediaMap.has(item.note_id)) noteMediaMap.set(item.note_id, []);
    noteMediaMap.get(item.note_id).push(item);
  }
  const noteMap = new Map();
  for (const item of notes) {
    if (!noteMap.has(item.material_id)) noteMap.set(item.material_id, []);
    noteMap.get(item.material_id).push({
      ...item,
      media: noteMediaMap.get(item.id) || [],
    });
  }
  return success(
    res,
    rows.map((item) => ({
      ...item,
      budget_total: multiplyMoney(item.quantity, item.budget_unit_price),
      actual_total: multiplyMoney(item.quantity, item.actual_unit_price),
      media: mediaMap.get(item.id) || [],
      notes: noteMap.get(item.id) || [],
    }))
  );
}

async function createProjectMaterialNote(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const projectId = Number(req.params.id);
  const materialId = Number(req.params.materialId);
  const files = req.files || [];
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) {
    await removeUploadedFiles(files);
    return error(res, '只有当前项目成员可以添加备注', 403);
  }
  const content = String(req.body.content || '').trim().slice(0, 1000);
  if (!content && files.length === 0) return error(res, '请填写备注文字或添加照片');
  const [materials] = await db.query(
    'SELECT id FROM project_material_items WHERE id = ? AND project_id = ?',
    [materialId, projectId]
  );
  if (!materials.length) {
    await removeUploadedFiles(files);
    return error(res, '材料信息不存在', 404);
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_material_notes
       (project_id, material_id, content, created_by)
       VALUES (?, ?, ?, ?)`,
      [projectId, materialId, content || null, req.user.id]
    );
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_material_note_media
         (note_id, media_type, media_url, uploaded_by)
         VALUES ${files.map(() => '(?, ?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          result.insertId,
          'image',
          file.storageUrl || `${host}/uploads/material-notes/${file.filename}`,
          req.user.id,
        ])
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '备注已添加');
  } catch (noteError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw noteError;
  } finally {
    connection.release();
  }
}

async function createProjectMaterialSupplement(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const projectId = Number(req.params.id);
  const materialId = Number(req.params.materialId);
  const files = req.files || [];
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) {
    await removeUploadedFiles(files);
    return error(res, '只有当前项目成员可以补充材料资料', 403);
  }
  const linkUrl = String(req.body.link_url || '').trim().slice(0, 500);
  if (!files.length && !linkUrl) return error(res, '请选择文件或填写链接');
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
    await removeUploadedFiles(files);
    return error(res, '资料链接必须以 http:// 或 https:// 开头');
  }
  const [materials] = await db.query(
    'SELECT id FROM project_material_items WHERE id = ? AND project_id = ?',
    [materialId, projectId]
  );
  if (!materials.length) {
    await removeUploadedFiles(files);
    return error(res, '材料信息不存在', 404);
  }
  const host = `${req.protocol}://${req.get('host')}`;
  const rows = files.map((file) => ({
    type: file.mimetype.startsWith('image/') ? 'image' : 'file',
    url: file.storageUrl || `${host}/uploads/materials/${file.filename}`,
  }));
  if (linkUrl) rows.push({ type: 'link', url: linkUrl });
  await db.query(
    `INSERT INTO project_material_media
     (material_id, media_type, media_url, uploaded_by)
     VALUES ${rows.map(() => '(?, ?, ?, ?)').join(', ')}`,
    rows.flatMap((item) => [materialId, item.type, item.url, req.user.id])
  );
  return success(res, null, '补充资料已添加');
}

async function createProjectMaterial(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  const files = req.files || [];
  if (!role) {
    await removeUploadedFiles(files);
    return error(res, '项目不存在或无新建权限', 404);
  }
  if (files.length > PROJECT_UPLOAD_QUOTAS.materialImageLimit) {
    await removeUploadedFiles(files);
    return error(res, `辅助材料最多上传 ${PROJECT_UPLOAD_QUOTAS.materialImageLimit} 个文件`);
  }
  const todayMaterialImages = await countRows(
    `SELECT COUNT(*) AS total
     FROM project_material_media media
     JOIN project_material_items material ON material.id = media.material_id
     WHERE material.project_id = ? AND media.uploaded_by = ?
       AND media.created_at >= CURDATE()`,
    [projectId, req.user.id]
  );
  if (todayMaterialImages + files.length > PROJECT_UPLOAD_QUOTAS.materialImagesDailyLimit) {
    await removeUploadedFiles(files);
    return error(res, `同一项目每天最多上传 ${PROJECT_UPLOAD_QUOTAS.materialImagesDailyLimit} 个材料文件，请明天再试`, 429);
  }
  const name = String(req.body.name || '').trim().slice(0, 120);
  const category = String(req.body.category || 'other');
  const location = String(req.body.location || '').trim().slice(0, 80);
  const spaceTags = parseMaterialSpaceTags(req.body.space_tags);
  const brandModel = String(req.body.brand_model || '').trim().slice(0, 160);
  const quantity = parseOptionalNumber(req.body.quantity);
  const unit = String(req.body.unit || '').trim().slice(0, 20);
  const budgetUnitPrice = parseOptionalNumber(req.body.budget_unit_price);
  const actualUnitPrice = parseOptionalNumber(req.body.actual_unit_price);
  const supplierType = String(req.body.supplier_type || 'other');
  const arrivalStatus = String(req.body.arrival_status || 'pending');
  const note = String(req.body.note || '').trim().slice(0, 1000);

  if (!name) {
    await removeUploadedFiles(files);
    return error(res, '请填写材料名称');
  }
  if (linkUrl && !/^https?:\/\//i.test(linkUrl)) {
    await removeUploadedFiles(files);
    return error(res, '辅助材料链接必须以 http:// 或 https:// 开头');
  }
  if (!materialCategories.has(category)) {
    await removeUploadedFiles(files);
    return error(res, '材料分类不正确');
  }
  if (!materialSupplierTypes.has(supplierType)) {
    await removeUploadedFiles(files);
    return error(res, '供应方类型不正确');
  }
  if (!materialArrivalStatuses.has(arrivalStatus)) {
    await removeUploadedFiles(files);
    return error(res, '到场状态不正确');
  }
  const invalidSpaceTag = spaceTags.find((tag) => !materialSpaceTags.has(tag));
  if (invalidSpaceTag) {
    await removeUploadedFiles(files);
    return error(res, '使用位置标签不正确');
  }
  if (quantity !== null && quantity <= 0) {
    await removeUploadedFiles(files);
    return error(res, '数量必须大于0');
  }
  if (budgetUnitPrice !== null && budgetUnitPrice < 0) {
    await removeUploadedFiles(files);
    return error(res, '预算单价不正确');
  }
  if (actualUnitPrice !== null && actualUnitPrice < 0) {
    await removeUploadedFiles(files);
    return error(res, '实际单价不正确');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_material_items
       (project_id, name, category, location, space_tags, brand_model, quantity, unit,
        budget_unit_price, actual_unit_price, supplier_type, arrival_status,
        confirm_status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        projectId,
        name,
        category,
        location || null,
        spaceTags.length ? JSON.stringify(spaceTags) : null,
        brandModel || null,
        quantity,
        unit || null,
        budgetUnitPrice,
        actualUnitPrice,
        supplierType,
        arrivalStatus,
        note || null,
        req.user.id,
      ]
    );
    if (files.length || linkUrl) {
      const host = `${req.protocol}://${req.get('host')}`;
      const mediaRows = files.map((file) => ({
        type: file.mimetype.startsWith('image/') ? 'image' : 'file',
        url: file.storageUrl || `${host}/uploads/materials/${file.filename}`,
      }));
      if (linkUrl) mediaRows.push({ type: 'link', url: linkUrl });
      await connection.query(
        `INSERT INTO project_material_media
         (material_id, media_type, media_url, uploaded_by)
         VALUES ${mediaRows.map(() => '(?, ?, ?, ?)').join(', ')}`,
        mediaRows.flatMap((media) => [
          result.insertId,
          media.type,
          media.url,
          req.user.id,
        ])
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '材料已添加');
  } catch (materialError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw materialError;
  } finally {
    connection.release();
  }
}

async function confirmProjectMaterial(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const materialId = Number(req.params.materialId);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以确认材料项', 403);
  }
  const [result] = await db.query(
    `UPDATE project_material_items
     SET confirm_status = 'confirmed', confirmed_by = ?, confirmed_at = NOW()
     WHERE id = ? AND project_id = ?`,
    [req.user.id, materialId, projectId]
  );
  if (result.affectedRows === 0) return error(res, '材料不存在', 404);
  return success(res, null, '材料项已确认');
}

function parseMaterialSpaceTags(value) {
  const rawTags = (() => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {
        return value.split(',');
      }
    }
    return [];
  })();
  return [
    ...new Set(
      rawTags
        .map((item) => String(item || '').trim())
        .filter(Boolean)
        .slice(0, 8)
    ),
  ];
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function multiplyMoney(quantity, unitPrice) {
  const qty = Number(quantity);
  const price = Number(unitPrice);
  if (!Number.isFinite(qty) || !Number.isFinite(price)) return null;
  return Number((qty * price).toFixed(2));
}

// GET /api/renovation/projects/:id/tasks - 获取项目下的任务列表
async function getProjectTasks(req, res) {
  const projectId = Number(req.params.id);
  const [projectRows] = await db.query(
    `SELECT p.id FROM renovation_projects p
     WHERE p.id = ?
       AND EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
       )`,
    [projectId, req.user.id]
  );
  if (!projectRows[0]) return error(res, '项目不存在', 404);

  const [tasks] = await db.query(
    `SELECT id, stage_id, task_name, is_key, planned_start, planned_end,
            actual_start, actual_end, status, remark
     FROM renovation_tasks
     WHERE project_id = ?
     ORDER BY stage_id, planned_start, id`,
    [projectId]
  );
  return success(res, { tasks });
}

async function getProjectTodos(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT id, stage_id, task_name, is_key, planned_start, planned_end,
            actual_start, actual_end, status, remark,
            CASE
              WHEN planned_start <= CURDATE() AND planned_end >= CURDATE()
                THEN 'today'
              WHEN status != 2 AND planned_end < CURDATE()
                THEN 'overdue'
              ELSE 'upcoming'
            END AS todo_group
     FROM renovation_tasks
     WHERE project_id = ?
       AND (
         status != 2
         OR (planned_start <= CURDATE() AND planned_end >= CURDATE())
       )
     ORDER BY
       CASE
         WHEN planned_start <= CURDATE() AND planned_end >= CURDATE() THEN 0
         WHEN status != 2 AND planned_end < CURDATE() THEN 1
         ELSE 2
       END,
       planned_end, planned_start, id`,
    [projectId]
  );
  const items = rows.map((task) => ({
    ...task,
    stage_name: stages.find((stage) => stage.id === Number(task.stage_id))?.name || '装修阶段',
    stage_emoji: stages.find((stage) => stage.id === Number(task.stage_id))?.emoji || '📋',
  }));
  const actionItems = await getProjectActionItems(projectId, req.user.id);
  return success(res, {
    today: items.filter((item) => item.todo_group === 'today'),
    overdue: items.filter((item) => item.todo_group === 'overdue'),
    upcoming: items.filter((item) => item.todo_group === 'upcoming'),
    action_items: actionItems,
    counts: {
      today: items.filter((item) => item.todo_group === 'today').length,
      overdue: items.filter((item) => item.todo_group === 'overdue').length,
      pending: items.filter((item) => Number(item.status) !== 2).length,
      action_pending: actionItems.filter((item) => item.status === 'pending').length,
    },
  });
}

async function getProjectActionItems(projectId, userId) {
  const [items] = await db.query(
    `SELECT item.id, item.project_id, item.content, item.due_date, item.status,
            item.created_at, item.updated_at, item.created_by,
            creator.nickname AS creator_name
     FROM project_action_items item
     JOIN users creator ON creator.id = item.created_by
     WHERE item.project_id = ?
       AND (
         item.created_by = ?
         OR EXISTS (
           SELECT 1 FROM project_action_item_assignees assigned_filter
           WHERE assigned_filter.item_id = item.id
             AND assigned_filter.user_id = ?
         )
         OR EXISTS (
           SELECT 1 FROM project_action_item_feedback feedback_filter
           WHERE feedback_filter.item_id = item.id
             AND feedback_filter.submitted_by = ?
         )
       )
     ORDER BY CASE item.status WHEN 'pending' THEN 0 ELSE 1 END,
              item.due_date, item.updated_at DESC`,
    [projectId, userId, userId, userId]
  );
  if (!items.length) return [];
  const itemIds = items.map((item) => item.id);
  const placeholders = itemIds.map(() => '?').join(', ');
  const [assignees] = await db.query(
    `SELECT assigned.item_id, assigned.user_id, member.role,
            user.nickname, user.avatar
     FROM project_action_item_assignees assigned
     JOIN users user ON user.id = assigned.user_id
     LEFT JOIN project_members member
       ON member.project_id = ? AND member.user_id = assigned.user_id
      AND member.status = 1
     WHERE assigned.item_id IN (${placeholders})
     ORDER BY assigned.item_id, assigned.created_at`,
    [projectId, ...itemIds]
  );
  const [feedback] = await db.query(
    `SELECT feedback.id, feedback.item_id, feedback.submitted_by,
            feedback.result, feedback.content, feedback.created_at,
            user.nickname AS submitter_name
     FROM project_action_item_feedback feedback
     JOIN users user ON user.id = feedback.submitted_by
     WHERE feedback.item_id IN (${placeholders})
     ORDER BY feedback.item_id, feedback.created_at DESC`,
    itemIds
  );
  const [media] = await db.query(
    `SELECT id, item_id, feedback_id, media_type, media_url, created_at
     FROM project_action_item_media
     WHERE item_id IN (${placeholders})
     ORDER BY id`,
    itemIds
  );
  const assigneeMap = new Map();
  const feedbackMap = new Map();
  const itemMediaMap = new Map();
  const feedbackMediaMap = new Map();
  for (const assignee of assignees) {
    if (!assigneeMap.has(assignee.item_id)) assigneeMap.set(assignee.item_id, []);
    assigneeMap.get(assignee.item_id).push(assignee);
  }
  for (const attachment of media) {
    if (attachment.feedback_id) {
      if (!feedbackMediaMap.has(attachment.feedback_id)) {
        feedbackMediaMap.set(attachment.feedback_id, []);
      }
      feedbackMediaMap.get(attachment.feedback_id).push(attachment);
    } else {
      if (!itemMediaMap.has(attachment.item_id)) itemMediaMap.set(attachment.item_id, []);
      itemMediaMap.get(attachment.item_id).push(attachment);
    }
  }
  for (const entry of feedback) {
    if (!feedbackMap.has(entry.item_id)) feedbackMap.set(entry.item_id, []);
    feedbackMap.get(entry.item_id).push({
      ...entry,
      media: feedbackMediaMap.get(entry.id) || [],
    });
  }
  return items.map((item) => ({
    ...item,
    created_by: Number(item.created_by),
    is_assignee: (assigneeMap.get(item.id) || []).some(
      (assignee) => Number(assignee.user_id) === Number(userId)
    ),
    assignees: assigneeMap.get(item.id) || [],
    media: itemMediaMap.get(item.id) || [],
    feedback: feedbackMap.get(item.id) || [],
  }));
}

function parseAssigneeIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  }
  try {
    const parsed = JSON.parse(String(value || '[]'));
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  } catch {
    return [];
  }
}

async function removeUploadedFiles(files) {
  await Promise.all((files || []).map((file) => fs.unlink(file.path).catch(() => {})));
}

async function createProjectActionItem(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const content = String(req.body.content || '').trim().slice(0, 1000);
  const dueDate = String(req.body.due_date || '');
  const assigneeIds = parseAssigneeIds(req.body.assignee_ids);
  const files = req.files || [];
  if (!(await canAccessProject(projectId, req.user.id))) {
    await removeUploadedFiles(files);
    return error(res, '项目不存在或无权限', 404);
  }
  if (!content || !dueDate || Number.isNaN(Date.parse(dueDate))) {
    await removeUploadedFiles(files);
    return error(res, '请填写事项内容和处理日期');
  }
  if (!assigneeIds.length) {
    await removeUploadedFiles(files);
    return error(res, '请至少选择一位项目成员');
  }
  const [members] = await db.query(
    `SELECT user_id FROM project_members
     WHERE project_id = ? AND status = 1 AND user_id IN (${assigneeIds.map(() => '?').join(', ')})`,
    [projectId, ...assigneeIds]
  );
  if (members.length !== assigneeIds.length) {
    await removeUploadedFiles(files);
    return error(res, '所选处理人包含非项目成员');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_action_items
       (project_id, created_by, content, due_date, status)
       VALUES (?, ?, ?, ?, 'pending')`,
      [projectId, req.user.id, content, dueDate]
    );
    await connection.query(
      `INSERT INTO project_action_item_assignees (item_id, user_id)
       VALUES ${assigneeIds.map(() => '(?, ?)').join(', ')}`,
      assigneeIds.flatMap((userId) => [result.insertId, userId])
    );
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_action_item_media
         (item_id, feedback_id, media_type, media_url, uploaded_by)
         VALUES ${files.map(() => '(?, NULL, ?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          result.insertId,
          file.mimetype.startsWith('video/') ? 'video' : 'image',
          file.storageUrl || `${host}/uploads/action-items/${file.filename}`,
          req.user.id,
        ])
      );
    }
    await connection.query(
      `INSERT INTO project_action_notifications
       (item_id, recipient_id, event_type, delivery_status, payload)
       VALUES ${assigneeIds.map(() => "(?, ?, 'assigned', 'pending', ?)").join(', ')}`,
      assigneeIds.flatMap((userId) => [
        result.insertId,
        userId,
        JSON.stringify({ project_id: projectId, item_id: result.insertId }),
      ])
    );
    await connection.commit();
    return success(
      res,
      { id: result.insertId, notification_status: 'pending' },
      '事项已创建并加入推送队列'
    );
  } catch (itemError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw itemError;
  } finally {
    connection.release();
  }
}

async function submitProjectActionItemFeedback(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const result = String(req.body.result || '');
  const content = String(req.body.content || '').trim().slice(0, 1000);
  const files = req.files || [];
  if (!['completed', 'incomplete', 'rejected'].includes(result)) {
    await removeUploadedFiles(files);
    return error(res, '处理结果不正确');
  }
  if (!content && !files.length) {
    return error(res, '请填写反馈内容或添加图片、视频');
  }
  if (!(await canAccessProject(projectId, req.user.id))) {
    await removeUploadedFiles(files);
    return error(res, '项目不存在或无权限', 404);
  }
  const [items] = await db.query(
    `SELECT item.id, item.created_by,
            EXISTS(
              SELECT 1 FROM project_action_item_assignees assigned
              WHERE assigned.item_id = item.id AND assigned.user_id = ?
            ) AS is_assignee,
            EXISTS(
              SELECT 1 FROM project_members member
              WHERE member.project_id = item.project_id AND member.user_id = ?
                AND member.role = 'owner' AND member.status = 1
            ) AS is_owner
     FROM project_action_items item
     WHERE item.id = ? AND item.project_id = ?`,
    [req.user.id, req.user.id, itemId, projectId]
  );
  if (!items[0]) {
    await removeUploadedFiles(files);
    return error(res, '事项不存在', 404);
  }
  if (
    !items[0].is_assignee &&
    !items[0].is_owner &&
    Number(items[0].created_by) !== Number(req.user.id)
  ) {
    await removeUploadedFiles(files);
    return error(res, '你不是该事项的相关人员', 403);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [feedback] = await connection.query(
      `INSERT INTO project_action_item_feedback
       (item_id, submitted_by, result, content)
       VALUES (?, ?, ?, ?)`,
      [itemId, req.user.id, result, content || null]
    );
    await connection.query(
      'UPDATE project_action_items SET status = ? WHERE id = ?',
      [result, itemId]
    );
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_action_item_media
         (item_id, feedback_id, media_type, media_url, uploaded_by)
         VALUES ${files.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          itemId,
          feedback.insertId,
          file.mimetype.startsWith('video/') ? 'video' : 'image',
          file.storageUrl || `${host}/uploads/action-items/${file.filename}`,
          req.user.id,
        ])
      );
    }
    if (Number(items[0].created_by) !== Number(req.user.id)) {
      await connection.query(
        `INSERT INTO project_action_notifications
         (item_id, recipient_id, event_type, delivery_status, payload)
         VALUES (?, ?, 'feedback', 'pending', ?)`,
        [
          itemId,
          items[0].created_by,
          JSON.stringify({ project_id: projectId, item_id: itemId, result }),
        ]
      );
    }
    await connection.commit();
    return success(
      res,
      { id: feedback.insertId, status: result, notification_status: 'pending' },
      '处理反馈已提交'
    );
  } catch (feedbackError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw feedbackError;
  } finally {
    connection.release();
  }
}

// GET /api/renovation/projects/:id/progress - 获取项目进度
async function getProjectProgress(req, res) {
  const projectId = Number(req.params.id);
  if (!projectId || !(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在', 404);
  }
  let projectRows;
  try {
    [projectRows] = await db.query(
      `SELECT p.id, p.current_stage, p.status, p.start_date, p.total_days,
              p.pace_mode, p.pace_updated_at, p.lifecycle_status
       FROM renovation_projects p
       WHERE p.id = ?`,
      [projectId]
    );
  } catch (queryError) {
    if (queryError.code !== 'ER_BAD_FIELD_ERROR') throw queryError;
    console.error('project progress base query fell back', {
      projectId,
      code: queryError.code,
      message: queryError.message,
    });
    [projectRows] = await db.query(
      `SELECT p.id, p.current_stage, p.status, p.start_date
       FROM renovation_projects p
       WHERE p.id = ?`,
      [projectId]
    );
  }
  if (!projectRows[0]) return error(res, '项目不存在', 404);
  if (normalizeProjectLifecycle(projectRows[0]) === 'active') {
    try {
      await recomputeProjectProgressDerivedStatuses(projectId);
    } catch (progressError) {
      console.error('project progress derived status skipped', {
        projectId,
        code: progressError.code,
        message: progressError.message,
      });
    }
  }

  const [taskStats] = await db.query(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 1 THEN 1 ELSE 0 END) AS in_progress,
       SUM(CASE WHEN status = 3 OR (status != 2 AND planned_end < CURDATE())
                THEN 1 ELSE 0 END) AS delayed,
       MAX(planned_end) AS expected_end
     FROM renovation_tasks WHERE project_id = ?`,
    [projectId]
  );

  const stats = taskStats[0];
  const total = Number(stats.total) || 0;
  const completed = Number(stats.completed) || 0;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const [tasks] = await db.query(
    'SELECT stage_id, status FROM renovation_tasks WHERE project_id = ?',
    [projectId]
  );
  const derivedProgress = deriveProgressFromTasks(
    tasks,
    projectRows[0].current_stage,
    projectRows[0].status
  );
  let designBriefRows = [];
  try {
    [designBriefRows] = await db.query(
      `SELECT id, title, content, confirmed_at
       FROM project_handovers
       WHERE project_id = ?
         AND status = 'confirmed'
         AND (stage_id = ? OR stage_id IS NULL)
       ORDER BY stage_id IS NULL ASC, confirmed_at DESC, id DESC
       LIMIT 5`,
      [projectId, derivedProgress.current_stage]
    );
  } catch (handoverError) {
    if (handoverError.code !== 'ER_NO_SUCH_TABLE' && handoverError.code !== 'ER_BAD_FIELD_ERROR') {
      throw handoverError;
    }
    console.error('project progress design brief query skipped', {
      projectId,
      code: handoverError.code,
      message: handoverError.message,
    });
  }
  const designBriefTips = designBriefRows.map((row) => {
    const sections = extractDesignBriefSections(row.content);
    return {
      handover_id: row.id,
      title: row.title,
      confirmed_at: row.confirmed_at,
      design_focus: sections['本项目设计重点'] || '',
      process_notes: sections['特殊工艺说明'] || '',
      acceptance_tips: [
        sections['关键尺寸/不可随意变更项'],
        sections['易错点提醒'],
        sections['材料/五金注意事项'],
      ].filter(Boolean).join('\n'),
    };
  }).filter((item) =>
    item.design_focus || item.process_notes || item.acceptance_tips
  );

  return success(res, {
    project_id: projectId,
    current_stage: derivedProgress.current_stage,
    status: derivedProgress.status,
    total_tasks: total,
    completed_tasks: completed,
    in_progress_tasks: Number(stats.in_progress) || 0,
    delayed_tasks: Number(stats.delayed) || 0,
    progress_percent: percent,
    expected_end: stats.expected_end,
    pace_mode: projectRows[0].pace_mode || 'normal',
    pace_updated_at: projectRows[0].pace_updated_at,
    design_brief_tips: designBriefTips,
  });
}

async function requireProjectOwner(projectId, userId) {
  const [rows] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = 'owner' AND status = 1`,
    [projectId, userId]
  );
  return Boolean(rows[0]);
}

async function canManageProjectProgress(projectId, userId) {
  const role = await getProjectMemberRole(projectId, userId);
  return ['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role);
}

const progressChangeRoles = new Set([
  'owner',
  'designer',
  'project_manager',
  'project_supervisor',
]);

function parseProgressChangeJson(value, fallback = {}) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

function progressChangeTimestamp(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function progressChangeTargetUnchanged(current, expected) {
  const expectedTime = progressChangeTimestamp(expected);
  if (expectedTime === null) return true;
  return progressChangeTimestamp(current) === expectedTime;
}

function progressChangeDisplayTitle(entityType, action, payload, before) {
  const name = String(
    payload?.task_name || payload?.title || before?.task_name || before?.title || '项目事项'
  ).trim();
  const actionLabel = { create: '新建', update: '修改', delete: '删除' }[action] || '调整';
  return `${actionLabel}${entityType === 'task' ? '事项' : '子事项'}：${name}`;
}

async function queueProjectProgressChange({
  projectId,
  entityType,
  targetId = null,
  action,
  beforeSnapshot = null,
  proposedPayload = null,
  userId,
  role,
}) {
  const [result] = await db.query(
    `INSERT INTO project_progress_change_requests
       (project_id, entity_type, target_id, action, before_snapshot,
        proposed_payload, target_updated_at, submitted_by, submitted_role, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      projectId,
      entityType,
      targetId,
      action,
      beforeSnapshot ? JSON.stringify(beforeSnapshot) : null,
      proposedPayload ? JSON.stringify(proposedPayload) : null,
      beforeSnapshot?.updated_at || null,
      userId,
      role || null,
    ]
  );
  const ownerIds = await getActiveProjectMemberUserIds(projectId, ['owner']);
  await emitProjectEvent(ProjectEventType.PROGRESS_CHANGE_SUBMITTED, {
    projectId,
    actorId: userId,
    targetUserIds: ownerIds,
    entityType: 'progress_change_request',
    entityId: result.insertId,
    title: '有新的项目进度变更待确认',
    content: progressChangeDisplayTitle(entityType, action, proposedPayload, beforeSnapshot),
    route: 'project_progress',
    deepLink: { projectId, progressTab: 'details' },
  });
  return Number(result.insertId);
}

function progressChangeResponse(res, requestId) {
  return success(
    res,
    { pending_confirmation: true, request_id: requestId },
    '已提交，等待业主确认'
  );
}

async function getProjectProgressChangeRequests(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const role = await getProjectMemberRole(projectId, req.user.id);
  const requestedStatus = String(req.query.status || 'pending');
  const statuses = new Set(['pending', 'approved', 'rejected', 'cancelled', 'conflict']);
  const status = statuses.has(requestedStatus) ? requestedStatus : 'pending';
  const params = [projectId, status];
  const relatedWhere = role === 'owner' ? '' : ' AND request.submitted_by = ?';
  if (role !== 'owner') params.push(req.user.id);
  const [rows] = await db.query(
    `SELECT request.id, request.project_id, request.entity_type, request.target_id,
            request.action, request.before_snapshot, request.proposed_payload,
            request.submitted_by, request.submitted_role, request.status,
            request.reviewed_by, request.review_note, request.reviewed_at,
            request.created_at, request.updated_at,
            submitter.nickname AS submitter_name,
            reviewer.nickname AS reviewer_name
     FROM project_progress_change_requests request
     JOIN users submitter ON submitter.id = request.submitted_by
     LEFT JOIN users reviewer ON reviewer.id = request.reviewed_by
     WHERE request.project_id = ? AND request.status = ?${relatedWhere}
     ORDER BY request.created_at DESC, request.id DESC
     LIMIT 100`,
    params
  );
  return success(
    res,
    rows.map((row) => ({
      ...row,
      before_snapshot: parseProgressChangeJson(row.before_snapshot, null),
      proposed_payload: parseProgressChangeJson(row.proposed_payload, null),
      can_review: role === 'owner' && row.status === 'pending',
      can_cancel:
        Number(row.submitted_by) === Number(req.user.id) && row.status === 'pending',
    }))
  );
}

async function progressItemDepthWith(executor, projectId, parentId) {
  if (!parentId) return 0;
  let depth = 1;
  let cursor = Number(parentId);
  while (cursor) {
    const [rows] = await executor.query(
      'SELECT id, parent_id FROM project_progress_items WHERE id = ? AND project_id = ?',
      [cursor, projectId]
    );
    if (!rows[0]) return -1;
    cursor = Number(rows[0].parent_id || 0);
    if (cursor) depth += 1;
    if (depth >= 3) break;
  }
  return depth;
}

async function applyTaskProgressChange(connection, request, before, payload) {
  const projectId = Number(request.project_id);
  if (request.action === 'create') {
    const stageId = Number(payload.stage_id);
    const taskName = String(payload.task_name || '').trim().slice(0, 100);
    const plannedStart = payload.planned_start;
    const plannedEnd = payload.planned_end;
    if (!stages.some((stage) => stage.id === stageId) || !taskName) {
      return { conflict: '事项信息已失效，请重新提交' };
    }
    if (
      !plannedStart ||
      !plannedEnd ||
      Number.isNaN(Date.parse(plannedStart)) ||
      Number.isNaN(Date.parse(plannedEnd)) ||
      Date.parse(plannedEnd) < Date.parse(plannedStart)
    ) {
      return { conflict: '计划日期已失效，请重新提交' };
    }
    const [result] = await connection.query(
      `INSERT INTO renovation_tasks
       (project_id, stage_id, task_name, is_key, planned_start, planned_end, status, remark)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [
        projectId,
        stageId,
        taskName,
        payload.is_key ? 1 : 0,
        plannedStart,
        plannedEnd,
        String(payload.remark || '').trim().slice(0, 500) || null,
      ]
    );
    return { entityId: Number(result.insertId) };
  }

  const [rows] = await connection.query(
    'SELECT * FROM renovation_tasks WHERE id = ? AND project_id = ? FOR UPDATE',
    [request.target_id, projectId]
  );
  const current = rows[0];
  if (!current) return { conflict: '原事项已不存在' };
  if (!progressChangeTargetUnchanged(current.updated_at, request.target_updated_at)) {
    return { conflict: '原事项已发生变化，请重新提交' };
  }
  if (request.action === 'delete') {
    const [childrenResult, inspectionsResult, stepRecord] = await Promise.all([
      connection.query(
        'SELECT COUNT(*) AS total FROM project_progress_items WHERE project_id = ? AND task_id = ?',
        [projectId, request.target_id]
      ),
      connection.query(
        'SELECT id FROM project_inspections WHERE project_id = ? AND task_id = ? LIMIT 1',
        [projectId, request.target_id]
      ),
      findProjectInspectionStepRecordForTask(
        connection,
        projectId,
        request.target_id
      ),
    ]);
    const [children] = childrenResult;
    const [inspections] = inspectionsResult;
    if (Number(children[0]?.total || 0) > 0 || inspections[0] || stepRecord) {
      return { conflict: '事项已有下级内容或现场记录，不能删除' };
    }
    await connection.query(
      'DELETE FROM renovation_tasks WHERE id = ? AND project_id = ?',
      [request.target_id, projectId]
    );
    return { entityId: Number(request.target_id) };
  }

  const taskName = String(payload.task_name || current.task_name).trim().slice(0, 100);
  const plannedStart = payload.planned_start || dateOnly(current.planned_start);
  const plannedEnd = payload.planned_end || dateOnly(current.planned_end);
  const nextStatus = payload.status === undefined
    ? Number(current.status)
    : Number(payload.status);
  if (
    !taskName ||
    !plannedStart ||
    !plannedEnd ||
    Date.parse(plannedEnd) < Date.parse(plannedStart) ||
    ![0, 1, 2, 3].includes(nextStatus)
  ) {
    return { conflict: '事项内容已失效，请重新提交' };
  }
  await connection.query(
    `UPDATE renovation_tasks
     SET task_name = ?, planned_start = ?, planned_end = ?, remark = ?, is_key = ?,
         status = ?,
         actual_start = CASE
           WHEN ? = 1 THEN COALESCE(actual_start, CURDATE())
           ELSE actual_start
         END,
         actual_end = CASE
           WHEN ? = 2 THEN COALESCE(actual_end, CURDATE())
           ELSE actual_end
         END
     WHERE id = ? AND project_id = ?`,
    [
      taskName,
      plannedStart,
      plannedEnd,
      String(payload.remark ?? current.remark ?? '').trim().slice(0, 500) || null,
      payload.is_key === undefined ? Number(current.is_key || 0) : payload.is_key ? 1 : 0,
      nextStatus,
      nextStatus,
      nextStatus,
      request.target_id,
      projectId,
    ]
  );
  return { entityId: Number(request.target_id) };
}

async function resolveProgressItemParent(connection, projectId, item) {
  const depth = await progressItemDepthWith(connection, projectId, item.parentId);
  if (depth < 0) return '父级子事项不存在';
  if (depth >= 3) return '进度计划最多支持三级';
  if (item.parentId) {
    const [parents] = await connection.query(
      'SELECT stage_id, task_id FROM project_progress_items WHERE id = ? AND project_id = ?',
      [item.parentId, projectId]
    );
    if (!parents[0]) return '父级子事项不存在';
    item.stageId = Number(parents[0].stage_id);
    item.taskId = parents[0].task_id ? Number(parents[0].task_id) : null;
  } else if (item.taskId) {
    const [tasks] = await connection.query(
      'SELECT id, stage_id FROM renovation_tasks WHERE id = ? AND project_id = ?',
      [item.taskId, projectId]
    );
    if (!tasks[0]) return '所属事项不存在';
    item.stageId = Number(tasks[0].stage_id);
  }
  return null;
}

async function collectProgressItemIds(connection, projectId, itemId) {
  const ids = [Number(itemId)];
  for (let index = 0; index < ids.length; index += 1) {
    const [children] = await connection.query(
      'SELECT id FROM project_progress_items WHERE project_id = ? AND parent_id = ?',
      [projectId, ids[index]]
    );
    for (const child of children) ids.push(Number(child.id));
  }
  return ids;
}

async function applyProgressItemChange(connection, request, before, payload) {
  const projectId = Number(request.project_id);
  if (request.action === 'create') {
    const item = sanitizeProgressItemBody(payload);
    const relationError = await resolveProgressItemParent(connection, projectId, item);
    const validationError = relationError || validateProgressItem(item);
    if (validationError) return { conflict: validationError };
    if (item.templateKey) {
      const [duplicates] = await connection.query(
        'SELECT id FROM project_progress_items WHERE project_id = ? AND template_key = ? LIMIT 1',
        [projectId, item.templateKey]
      );
      if (duplicates[0]) return { conflict: '该事项已加入项目进度' };
    }
    const [result] = await connection.query(
      `INSERT INTO project_progress_items
       (project_id, stage_id, task_id, parent_id, template_key, title,
        planned_start, planned_end, actual_finish, status, remark, is_key_node,
        requires_inspection, inspection_template_key, sort_order, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      [
        projectId,
        item.stageId,
        item.taskId,
        item.parentId,
        item.templateKey,
        item.title,
        item.plannedStart,
        item.plannedEnd,
        null,
        item.remark,
        item.isKeyNode,
        item.requiresInspection,
        item.inspectionTemplateKey,
        item.sortOrder,
        request.submitted_by,
      ]
    );
    await recordProjectProgressItemAdjustment(connection, {
      projectId,
      itemId: result.insertId,
      action: 'created',
      changes: buildProgressItemChanges(null, item, { includeAll: true }),
      userId: request.submitted_by,
      role: request.submitted_role,
    });
    return { entityId: Number(result.insertId) };
  }

  const [rows] = await connection.query(
    'SELECT * FROM project_progress_items WHERE id = ? AND project_id = ? FOR UPDATE',
    [request.target_id, projectId]
  );
  const current = rows[0];
  if (!current) return { conflict: '原子事项已不存在' };
  if (!progressChangeTargetUnchanged(current.updated_at, request.target_updated_at)) {
    return { conflict: '原子事项已发生变化，请重新提交' };
  }
  if (request.action === 'delete') {
    const ids = await collectProgressItemIds(connection, projectId, request.target_id);
    const [[inspections], [stepRecords]] = await Promise.all([
      connection.query(
        'SELECT id FROM project_inspections WHERE project_id = ? AND progress_item_id IN (?) LIMIT 1',
        [projectId, ids]
      ),
      connection.query(
        'SELECT id FROM project_inspection_step_records WHERE project_id = ? AND progress_item_id IN (?) LIMIT 1',
        [projectId, ids]
      ),
    ]);
    if (inspections[0] || stepRecords[0]) {
      return { conflict: '子事项已有现场记录，不能删除' };
    }
    await recordProjectProgressItemAdjustment(connection, {
      projectId,
      itemId: request.target_id,
      action: 'deleted',
      changes: [],
      userId: request.submitted_by,
      role: request.submitted_role,
    });
    await connection.query(
      'DELETE FROM project_progress_items WHERE project_id = ? AND id IN (?)',
      [projectId, ids]
    );
    return { entityId: Number(request.target_id) };
  }

  const item = sanitizeProgressItemBody({
    ...payload,
    stage_id: payload.stage_id ?? current.stage_id,
    task_id: payload.task_id ?? current.task_id,
    parent_id: payload.parent_id ?? current.parent_id,
    template_key: payload.template_key ?? current.template_key,
    actual_finish: current.actual_finish,
    requires_inspection: payload.requires_inspection ?? current.requires_inspection,
    inspection_template_key:
      payload.inspection_template_key ?? current.inspection_template_key,
  });
  if (item.parentId === Number(request.target_id)) {
    return { conflict: '不能把自己设为父级子事项' };
  }
  const relationError = await resolveProgressItemParent(connection, projectId, item);
  const validationError = relationError || validateProgressItem(item);
  if (validationError) return { conflict: validationError };
  const changes = buildProgressItemChanges(current, item);
  await connection.query(
    `UPDATE project_progress_items
     SET stage_id = ?, task_id = ?, parent_id = ?, title = ?, planned_start = ?,
         planned_end = ?, remark = ?, is_key_node = ?, template_key = ?,
         requires_inspection = ?, inspection_template_key = ?, sort_order = ?
     WHERE id = ? AND project_id = ?`,
    [
      item.stageId,
      item.taskId,
      item.parentId,
      item.title,
      item.plannedStart,
      item.plannedEnd,
      item.remark,
      item.isKeyNode,
      item.templateKey,
      item.requiresInspection,
      item.inspectionTemplateKey,
      item.sortOrder,
      request.target_id,
      projectId,
    ]
  );
  if (changes.length) {
    await recordProjectProgressItemAdjustment(connection, {
      projectId,
      itemId: request.target_id,
      action: 'updated',
      changes,
      userId: request.submitted_by,
      role: request.submitted_role,
    });
  }
  return { entityId: Number(request.target_id) };
}

async function reviewProjectProgressChangeRequest(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const projectId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  const action = String(req.body.action || '');
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!['approve', 'reject'].includes(action)) return error(res, '确认操作不正确');
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以确认项目进度变更', 403);
  }
  const connection = await db.getConnection();
  let submittedBy = 0;
  let displayTitle = '项目进度变更';
  let conflictMessage = '';
  let shouldRefreshProgress = false;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM project_progress_change_requests
       WHERE id = ? AND project_id = ? AND status = 'pending' FOR UPDATE`,
      [requestId, projectId]
    );
    const request = rows[0];
    if (!request) {
      await connection.rollback();
      return error(res, '待确认事项不存在或已处理', 404);
    }
    submittedBy = Number(request.submitted_by);
    const before = parseProgressChangeJson(request.before_snapshot, null);
    const payload = parseProgressChangeJson(request.proposed_payload, {});
    displayTitle = progressChangeDisplayTitle(
      request.entity_type,
      request.action,
      payload,
      before
    );
    if (action === 'reject') {
      await connection.query(
        `UPDATE project_progress_change_requests
         SET status = 'rejected', reviewed_by = ?, review_note = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.user.id, note || null, requestId]
      );
      await connection.commit();
    } else {
      const result = request.entity_type === 'task'
        ? await applyTaskProgressChange(connection, request, before, payload)
        : await applyProgressItemChange(connection, request, before, payload);
      if (result.conflict) {
        await connection.query(
          `UPDATE project_progress_change_requests
           SET status = 'conflict', reviewed_by = ?, review_note = ?, reviewed_at = NOW()
           WHERE id = ?`,
          [req.user.id, result.conflict, requestId]
        );
        await connection.commit();
        conflictMessage = result.conflict;
      } else {
        await connection.query(
          `UPDATE project_progress_change_requests
           SET status = 'approved', target_id = COALESCE(target_id, ?),
               reviewed_by = ?, review_note = ?, reviewed_at = NOW()
           WHERE id = ?`,
          [result.entityId || null, req.user.id, note || null, requestId]
        );
        await connection.commit();
        shouldRefreshProgress = true;
      }
    }
  } catch (reviewError) {
    await connection.rollback();
    throw reviewError;
  } finally {
    connection.release();
  }
  if (conflictMessage) {
    await emitProjectEvent(ProjectEventType.PROGRESS_CHANGE_REJECTED, {
      projectId,
      actorId: req.user.id,
      targetUserIds: [submittedBy],
      entityType: 'progress_change_request',
      entityId: requestId,
      title: '项目进度变更需要重新提交',
      content: conflictMessage,
      route: 'project_progress',
      deepLink: { projectId, progressTab: 'details' },
    });
    return error(res, conflictMessage, 409);
  }
  if (shouldRefreshProgress) {
    await refreshProjectStageByTaskCompletion(projectId);
  }
  await emitProjectEvent(
    action === 'approve'
      ? ProjectEventType.PROGRESS_CHANGE_APPROVED
      : ProjectEventType.PROGRESS_CHANGE_REJECTED,
    {
      projectId,
      actorId: req.user.id,
      targetUserIds: [submittedBy],
      entityType: 'progress_change_request',
      entityId: requestId,
      title: action === 'approve' ? '项目进度变更已确认' : '项目进度变更已拒绝',
      content: displayTitle,
      route: 'project_progress',
      deepLink: { projectId, progressTab: 'details' },
    }
  );
  return success(
    res,
    { status: action === 'approve' ? 'approved' : 'rejected' },
    action === 'approve' ? '已确认并更新项目进度' : '已拒绝该变更'
  );
}

async function cancelProjectProgressChangeRequest(req, res) {
  const projectId = Number(req.params.id);
  const requestId = Number(req.params.requestId);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [result] = await db.query(
    `UPDATE project_progress_change_requests
     SET status = 'cancelled', reviewed_at = NOW()
     WHERE id = ? AND project_id = ? AND submitted_by = ? AND status = 'pending'`,
    [requestId, projectId, req.user.id]
  );
  if (!result.affectedRows) return error(res, '待确认事项不存在或已处理', 404);
  return success(res, { status: 'cancelled' }, '已撤回变更申请');
}

async function requireActiveProjectMember(projectId, userId) {
  if (!userId) return null;
  const [rows] = await db.query(
    `SELECT pm.user_id, pm.role, u.nickname
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ? AND pm.user_id = ? AND pm.status = 1`,
    [projectId, userId]
  );
  return rows[0] || null;
}

async function getActiveProjectMemberUserIds(projectId, roles, executor = db) {
  const [rows] = await executor.query(
    `SELECT DISTINCT user_id
     FROM project_members
     WHERE project_id = ?
       AND status = 1
       AND role IN (${roles.map(() => '?').join(', ')})`,
    [projectId, ...roles]
  );
  return rows.map((row) => Number(row.user_id)).filter(Boolean);
}

async function getOwnerSideMemberUserIds(projectId, executor = db) {
  return getActiveProjectMemberUserIds(projectId, ['owner', 'owner_member'], executor);
}

function uniqueUserIds(...groups) {
  return [
    ...new Set(
      groups
        .flat()
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ),
  ];
}

async function getDesignDocumentNotificationTargets(projectId, uploadedBy, executor = db) {
  const targets = new Set();
  if (uploadedBy) targets.add(Number(uploadedBy));
  const designerIds = await getActiveProjectMemberUserIds(projectId, ['designer'], executor);
  const ownerSideIds = await getOwnerSideMemberUserIds(projectId, executor);
  designerIds.forEach((id) => targets.add(id));
  ownerSideIds.forEach((id) => targets.add(id));
  return [...targets].filter(Boolean);
}

function extractDesignBriefSections(content) {
  const labels = [
    '本项目设计重点',
    '特殊工艺说明',
    '客户特殊要求',
    '关键尺寸/不可随意变更项',
    '易错点提醒',
    '材料/五金注意事项',
    '项目经理备注',
  ];
  const sections = {};
  let current = null;
  let buffer = [];
  const flush = () => {
    if (!current) return;
    sections[current] = buffer.join('\n').trim();
    buffer = [];
  };
  for (const rawLine of String(content || '').split('\n')) {
    const line = rawLine.trim();
    const matched = labels.find((label) =>
      line === label || line === `${label}:` || line === `${label}：`
    );
    if (matched) {
      flush();
      current = matched;
    } else if (current) {
      buffer.push(rawLine);
    }
  }
  flush();
  return sections;
}

function designHandoverItemMeta(section) {
  switch (section) {
    case '关键尺寸/不可随意变更项':
      return { importance: 'critical', checkType: 'inspection_check' };
    case '特殊工艺说明':
    case '易错点提醒':
      return { importance: 'important', checkType: 'both' };
    case '材料/五金注意事项':
      return { importance: 'important', checkType: 'inspection_check' };
    default:
      return { importance: 'normal', checkType: 'progress_note' };
  }
}

function buildDesignHandoverItems({ projectId, handoverId, stageId, content }) {
  const sections = extractDesignBriefSections(content);
  let sortOrder = 0;
  return Object.entries(sections)
    .map(([section, summary]) => {
      const value = String(summary || '').trim().slice(0, 500);
      if (!value) return null;
      const meta = designHandoverItemMeta(section);
      sortOrder += 10;
      return {
        projectId,
        handoverId,
        relatedStageId: stageId || null,
        importance: meta.importance,
        checkType: meta.checkType,
        sourceSection: section,
        summary: value,
        sortOrder,
      };
    })
    .filter(Boolean);
}

async function replaceDesignHandoverItems(connection, { projectId, handoverId, stageId, content }) {
  await connection.query(
    'DELETE FROM project_design_handover_items WHERE design_handover_id = ? AND project_id = ?',
    [handoverId, projectId]
  );
  const items = buildDesignHandoverItems({ projectId, handoverId, stageId, content });
  if (!items.length) return;
  await connection.query(
    `INSERT INTO project_design_handover_items
     (project_id, design_handover_id, related_stage_id, importance,
      check_type, source_section, summary, sort_order)
     VALUES ${items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    items.flatMap((item) => [
      item.projectId,
      item.handoverId,
      item.relatedStageId,
      item.importance,
      item.checkType,
      item.sourceSection,
      item.summary,
      item.sortOrder,
    ])
  );
}

async function designHandoverInspectionItems(connection, projectId, stageId) {
  const [rows] = await connection.query(
    `SELECT item.id, item.design_handover_id, item.summary,
            handover.title AS source_title,
            handover.version_no AS source_version_no
     FROM project_design_handover_items item
     JOIN project_handovers handover ON handover.id = item.design_handover_id
     WHERE item.project_id = ?
       AND handover.status = 'confirmed'
       AND (item.related_stage_id = ? OR item.related_stage_id IS NULL)
       AND item.check_type IN ('inspection_check', 'both')
     ORDER BY item.related_stage_id IS NULL ASC,
              FIELD(item.importance, 'critical', 'important', 'normal'),
              item.sort_order, item.id
     LIMIT 12`,
    [projectId, stageId]
  );
  if (rows.length) return rows;
  const [handovers] = await connection.query(
    `SELECT id, project_id, stage_id, title, content, version_no
     FROM project_handovers
     WHERE project_id = ?
       AND status = 'confirmed'
       AND (stage_id = ? OR stage_id IS NULL)
     ORDER BY stage_id IS NULL ASC, confirmed_at DESC, id DESC
     LIMIT 5`,
    [projectId, stageId]
  );
  return handovers.flatMap((handover) =>
    buildDesignHandoverItems({
      projectId,
      handoverId: handover.id,
      stageId: handover.stage_id,
      content: handover.content,
    })
      .filter((item) => ['inspection_check', 'both'].includes(item.checkType))
      .map((item) => ({
        id: null,
        design_handover_id: handover.id,
        summary: item.summary,
        source_title: handover.title,
        source_version_no: handover.version_no || 1,
      }))
  );
}

async function createInspectionDesignChecks(connection, { projectId, inspectionId, stageId }) {
  const items = await designHandoverInspectionItems(connection, projectId, stageId);
  if (!items.length) return;
  await connection.query(
    `INSERT INTO project_inspection_design_checks
     (project_id, inspection_id, design_handover_id, design_handover_item_id,
      snapshot_source_title, snapshot_version_no, snapshot_summary)
     VALUES ${items.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    items.flatMap((item) => [
      projectId,
      inspectionId,
      item.design_handover_id,
      item.id,
      item.source_title,
      item.source_version_no || 1,
      item.summary,
    ])
  );
}

async function refreshProjectStageByTaskCompletion(projectId) {
  await recomputeProjectProgressDerivedStatuses(projectId);
  const [rows] = await db.query(
    `SELECT stage_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 2 THEN 1 ELSE 0 END) AS completed
     FROM renovation_tasks
     WHERE project_id = ?
     GROUP BY stage_id
     ORDER BY stage_id`,
    [projectId]
  );
  const [requiredInspectionRows] = await db.query(
    `SELECT stage_id, COUNT(*) AS incomplete
     FROM project_progress_items
     WHERE project_id = ?
       AND requires_inspection = 1
       AND status != 'completed'
     GROUP BY stage_id`,
    [projectId]
  );
  if (!rows.length && !requiredInspectionRows.length) return null;
  let currentStage = stages[stages.length - 1].id;
  let allCompleted = true;
  for (const stage of stages) {
    const row = rows.find((item) => Number(item.stage_id) === stage.id);
    const requiredInspectionRow = requiredInspectionRows.find(
      (item) => Number(item.stage_id) === stage.id
    );
    const tasksIncomplete = row && Number(row.completed) < Number(row.total);
    const inspectionsIncomplete = Number(requiredInspectionRow?.incomplete || 0) > 0;
    if (tasksIncomplete || inspectionsIncomplete) {
      currentStage = stage.id;
      allCompleted = false;
      break;
    }
  }
  const [projects] = await db.query(
    'SELECT status FROM renovation_projects WHERE id = ?',
    [projectId]
  );
  if (!projects[0]) return null;
  const status = allCompleted ? 2 : Number(projects[0].status) === 3 ? 3 : 1;
  await db.query(
    'UPDATE renovation_projects SET current_stage = ?, status = ? WHERE id = ?',
    [currentStage, status, projectId]
  );
  return { current_stage: currentStage, status };
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function derivedLeafProgressStatus(item, inspection) {
  if (inspection?.status === 'passed') return 'completed';
  if (!item.requires_inspection && item.actual_finish) return 'completed';
  if (
    inspection &&
    ['draft', 'in_progress', 'pending', 'rework'].includes(inspection.status)
  ) {
    return 'in_progress';
  }
  const today = dateOnly(new Date());
  const start = dateOnly(item.planned_start);
  const end = dateOnly(item.planned_end);
  if (end && end < today) return 'delayed';
  if (start && start > today) return 'pending';
  if ((start && start <= today) || (end && end >= today)) return 'in_progress';
  return 'pending';
}

function aggregateProgressStatuses(statuses) {
  if (!statuses.length) return null;
  if (statuses.every((status) => status === 'completed')) return 'completed';
  if (statuses.some((status) => status === 'delayed')) return 'delayed';
  if (statuses.some((status) => status === 'in_progress')) return 'in_progress';
  return 'pending';
}

function progressStatusToTaskStatus(status) {
  return { pending: 0, in_progress: 1, completed: 2, delayed: 3 }[status] ?? 0;
}

async function recomputeProjectProgressDerivedStatuses(projectId) {
  const [items] = await db.query(
    `SELECT id, project_id, stage_id, task_id, parent_id, planned_start,
            planned_end, actual_finish, status, requires_inspection
     FROM project_progress_items
     WHERE project_id = ?
     ORDER BY id DESC`,
    [projectId]
  );
  if (!items.length) return;

  const [inspections] = await db.query(
    `SELECT i.progress_item_id, i.status, i.reviewed_at, i.updated_at
     FROM project_inspections i
     JOIN (
       SELECT progress_item_id, MAX(updated_at) AS updated_at
       FROM project_inspections
       WHERE project_id = ? AND progress_item_id IS NOT NULL
       GROUP BY progress_item_id
     ) latest ON latest.progress_item_id = i.progress_item_id
             AND latest.updated_at = i.updated_at
     WHERE i.project_id = ? AND i.progress_item_id IS NOT NULL`,
    [projectId, projectId]
  );
  const inspectionByItem = new Map(
    inspections.map((inspection) => [Number(inspection.progress_item_id), inspection])
  );
  const childrenByParent = new Map();
  for (const item of items) {
    if (!item.parent_id) continue;
    const key = Number(item.parent_id);
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(item);
  }
  const statusByItem = new Map();
  const computeItem = (item) => {
    const itemId = Number(item.id);
    if (statusByItem.has(itemId)) return statusByItem.get(itemId);
    const inspection = inspectionByItem.get(itemId);
    const children = childrenByParent.get(itemId) || [];
    const childStatus = aggregateProgressStatuses(children.map(computeItem));
    let status;
    if (childStatus && childStatus !== 'completed') {
      status = childStatus;
    } else if (item.requires_inspection) {
      status = derivedLeafProgressStatus(item, inspection);
    } else {
      status = childStatus || derivedLeafProgressStatus(item, inspection);
    }
    statusByItem.set(itemId, status);
    return status;
  };
  for (const item of items) computeItem(item);

  await Promise.all(
    items.map((item) => {
      const status = statusByItem.get(Number(item.id));
      const passed = inspectionByItem.get(Number(item.id))?.status === 'passed';
      const clearUnverifiedFinish =
        Boolean(item.requires_inspection) && status !== 'completed';
      return db.query(
        `UPDATE project_progress_items
         SET status = ?, actual_finish = CASE
           WHEN ? = 1 THEN COALESCE(actual_finish, CURDATE())
           WHEN ? = 1 THEN NULL
           ELSE actual_finish
         END
         WHERE id = ? AND project_id = ?`,
        [
          status,
          passed ? 1 : 0,
          clearUnverifiedFinish ? 1 : 0,
          item.id,
          projectId,
        ]
      );
    })
  );

  const statusesByTask = new Map();
  for (const item of items) {
    if (item.parent_id || !item.task_id) continue;
    const taskId = Number(item.task_id);
    if (!statusesByTask.has(taskId)) statusesByTask.set(taskId, []);
    statusesByTask.get(taskId).push(statusByItem.get(Number(item.id)));
  }
  await Promise.all(
    Array.from(statusesByTask.entries()).map(([taskId, statuses]) => {
      const status = aggregateProgressStatuses(statuses);
      if (!status) return Promise.resolve();
      return db.query(
        `UPDATE renovation_tasks
         SET status = ?,
             actual_start = CASE WHEN ? IN (1, 2, 3) THEN COALESCE(actual_start, CURDATE()) ELSE actual_start END,
             actual_end = CASE WHEN ? = 2 THEN COALESCE(actual_end, CURDATE()) ELSE actual_end END
         WHERE id = ? AND project_id = ?`,
        [
          progressStatusToTaskStatus(status),
          progressStatusToTaskStatus(status),
          progressStatusToTaskStatus(status),
          taskId,
          projectId,
        ]
      );
    })
  );
}

function paceFactor(mode) {
  return mode === 'accelerated' ? 0.8 : mode === 'relaxed' ? 1.2 : 1;
}

async function rescheduleIncompleteTasks(connection, projectId, mode, startDate) {
  const [tasks] = await connection.query(
    `SELECT id, planned_start, planned_end
     FROM renovation_tasks
     WHERE project_id = ? AND status != 2
     ORDER BY stage_id, planned_start, id`,
    [projectId]
  );
  const factor = paceFactor(mode);
  let cursor = new Date(`${startDate}T00:00:00`);
  for (const task of tasks) {
    const originalStart = new Date(`${task.planned_start}T00:00:00`);
    const originalEnd = new Date(`${task.planned_end}T00:00:00`);
    const originalDays = Math.max(
      1,
      Math.round((originalEnd - originalStart) / 86400000) + 1
    );
    const adjustedDays = Math.max(1, Math.round(originalDays * factor));
    const end = new Date(cursor);
    end.setDate(end.getDate() + adjustedDays - 1);
    await connection.query(
      `UPDATE renovation_tasks
       SET planned_start = ?, planned_end = ?,
           status = CASE WHEN status = 3 THEN 0 ELSE status END
       WHERE id = ?`,
      [localDateOnly(cursor), localDateOnly(end), task.id]
    );
    cursor = new Date(end);
    cursor.setDate(cursor.getDate() + 1);
  }
}

async function getProgressProposal(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT proposal.id, proposal.project_id, proposal.pace_mode,
            proposal.planned_start, proposal.note, proposal.status,
            proposal.created_at, proposal.updated_at,
            submitter.nickname AS submitter_name,
            reviewer.nickname AS reviewer_name
     FROM project_progress_proposals proposal
     JOIN users submitter ON submitter.id = proposal.submitted_by
     LEFT JOIN users reviewer ON reviewer.id = proposal.reviewed_by
     WHERE proposal.project_id = ?
     ORDER BY CASE proposal.status WHEN 'pending' THEN 0 ELSE 1 END,
              proposal.updated_at DESC
     LIMIT 1`,
    [projectId]
  );
  return success(res, rows[0] || null);
}

async function submitProgressProposal(req, res) {
  const projectId = Number(req.params.id);
  const mode = String(req.body.pace_mode || '');
  const plannedStart = String(req.body.planned_start || '');
  const note = String(req.body.note || '').trim().slice(0, 500);
  if (!['normal', 'accelerated', 'relaxed'].includes(mode)) {
    return error(res, '项目节奏不正确');
  }
  if (!plannedStart || Number.isNaN(Date.parse(plannedStart))) {
    return error(res, '计划开始日期不正确');
  }
  const [members] = await db.query(
    `SELECT role FROM project_members
     WHERE project_id = ? AND user_id = ? AND status = 1
       AND role IN ('designer', 'project_manager', 'project_supervisor')`,
    [projectId, req.user.id]
  );
  if (!members[0]) return error(res, '只有设计师、项目经理或项目监理可以提交进度方案', 403);

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(
      `UPDATE project_progress_proposals
       SET status = 'rejected', reviewed_at = NOW()
       WHERE project_id = ? AND status = 'pending'`,
      [projectId]
    );
    const [result] = await connection.query(
      `INSERT INTO project_progress_proposals
       (project_id, submitted_by, pace_mode, planned_start, note, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [projectId, req.user.id, mode, plannedStart, note || null]
    );
    await connection.commit();
    return success(res, { id: result.insertId }, '进度方案已提交，等待业主确认');
  } catch (proposalError) {
    await connection.rollback();
    throw proposalError;
  } finally {
    connection.release();
  }
}

async function reviewProgressProposal(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const proposalId = Number(req.params.proposalId);
  const action = String(req.body.action || '');
  if (!['approve', 'reject'].includes(action)) {
    return error(res, '操作必须是 approve 或 reject');
  }
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以确认进度方案', 403);
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT * FROM project_progress_proposals
       WHERE id = ? AND project_id = ? AND status = 'pending'
       FOR UPDATE`,
      [proposalId, projectId]
    );
    if (!rows[0]) {
      await connection.rollback();
      return error(res, '进度方案不存在或已处理', 404);
    }
    if (action === 'approve') {
      await rescheduleIncompleteTasks(
        connection,
        projectId,
        rows[0].pace_mode,
        rows[0].planned_start
      );
      await connection.query(
        `UPDATE renovation_projects
         SET pace_mode = ?, status = 1, pace_updated_at = NOW()
         WHERE id = ?`,
        [rows[0].pace_mode, projectId]
      );
    }
    await connection.query(
      `UPDATE project_progress_proposals
       SET status = ?, reviewed_by = ?, reviewed_at = NOW()
       WHERE id = ?`,
      [action === 'approve' ? 'approved' : 'rejected', req.user.id, proposalId]
    );
    await connection.commit();
    return success(
      res,
      { status: action === 'approve' ? 'approved' : 'rejected' },
      action === 'approve' ? '进度方案已确认并同步' : '进度方案已拒绝'
    );
  } catch (reviewError) {
    await connection.rollback();
    throw reviewError;
  } finally {
    connection.release();
  }
}

async function updateProjectPace(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const mode = String(req.body.mode || '');
  if (!['normal', 'accelerated', 'relaxed', 'paused'].includes(mode)) {
    return error(res, '项目节奏不正确');
  }
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以调整项目节奏', 403);
  }
  if (mode === 'paused') {
    await db.query(
      `UPDATE renovation_projects
       SET pace_mode = 'paused', status = 3, pace_updated_at = NOW()
       WHERE id = ?`,
      [projectId]
    );
    return success(res, { pace_mode: mode }, '项目已暂停');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    await rescheduleIncompleteTasks(
      connection,
      projectId,
      mode,
      localDateOnly(new Date())
    );
    await connection.query(
      `UPDATE renovation_projects
       SET pace_mode = ?, status = 1, pace_updated_at = NOW()
       WHERE id = ?`,
      [mode, projectId]
    );
    await connection.commit();
  } catch (paceError) {
    await connection.rollback();
    throw paceError;
  } finally {
    connection.release();
  }
  return success(res, { pace_mode: mode }, '项目节奏已更新');
}

async function planProjectTask(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const taskId = Number(req.params.taskId);
  const plannedStart = req.body.planned_start;
  const plannedEnd = req.body.planned_end;
  const taskName = req.body.task_name === undefined
    ? undefined
    : String(req.body.task_name || '').trim().slice(0, 100);
  const remark = req.body.remark === undefined
    ? undefined
    : String(req.body.remark || '').trim().slice(0, 1000);
  const status = req.body.status === undefined ? undefined : Number(req.body.status);
  const isKey = req.body.is_key === undefined ? undefined : (req.body.is_key ? 1 : 0);
  if (plannedStart && Number.isNaN(Date.parse(plannedStart))) {
    return error(res, '计划开始日期不正确');
  }
  if (plannedEnd && Number.isNaN(Date.parse(plannedEnd))) {
    return error(res, '计划结束日期不正确');
  }
  if (plannedStart && plannedEnd && Date.parse(plannedEnd) < Date.parse(plannedStart)) {
    return error(res, '计划结束时间不能早于开始时间');
  }
  if (taskName !== undefined && !taskName) {
    return error(res, '请填写任务名称');
  }
  if (status !== undefined && ![0, 1, 2, 3].includes(status)) {
    return error(res, '任务状态不正确');
  }
  if (
    plannedStart === undefined &&
    plannedEnd === undefined &&
    taskName === undefined &&
    remark === undefined &&
    status === undefined &&
    isKey === undefined
  ) {
    return error(res, '没有可更新的内容');
  }
  const memberRole = await getProjectMemberRole(projectId, req.user.id);
  if (!progressChangeRoles.has(memberRole)) {
    return error(res, '只有业主、设计师或项目经理可以调整任务', 403);
  }
  if (memberRole !== 'owner') {
    const [existingRows] = await db.query(
      `SELECT id, project_id, stage_id, task_name, is_key, planned_start,
              planned_end, actual_start, actual_end, status, remark, updated_at
       FROM renovation_tasks WHERE id = ? AND project_id = ?`,
      [taskId, projectId]
    );
    const existing = existingRows[0];
    if (!existing) return error(res, '任务不存在', 404);
    const requestId = await queueProjectProgressChange({
      projectId,
      entityType: 'task',
      targetId: taskId,
      action: 'update',
      beforeSnapshot: existing,
      proposedPayload: {
        stage_id: Number(existing.stage_id),
        task_name: taskName ?? existing.task_name,
        planned_start: plannedStart ?? dateOnly(existing.planned_start),
        planned_end: plannedEnd ?? dateOnly(existing.planned_end),
        remark: remark ?? existing.remark,
        is_key: isKey === undefined ? Boolean(existing.is_key) : Boolean(isKey),
        status: status === undefined ? Number(existing.status) : status,
      },
      userId: req.user.id,
      role: memberRole,
    });
    return progressChangeResponse(res, requestId);
  }
  const fields = [];
  const params = [];
  if (plannedStart !== undefined) {
    fields.push('planned_start = ?');
    params.push(plannedStart);
  }
  if (plannedEnd !== undefined) {
    fields.push('planned_end = ?');
    params.push(plannedEnd);
  }
  if (taskName !== undefined) {
    fields.push('task_name = ?');
    params.push(taskName);
  }
  if (remark !== undefined) {
    fields.push('remark = ?');
    params.push(remark);
  }
  if (status !== undefined) {
    fields.push('status = ?');
    params.push(status);
    if (status === 1) fields.push('actual_start = COALESCE(actual_start, CURDATE())');
    if (status === 2) fields.push('actual_end = CURDATE()');
  }
  if (isKey !== undefined) {
    fields.push('is_key = ?');
    params.push(isKey);
  }
  if (!fields.length) return error(res, '没有可更新的内容');
  params.push(taskId, projectId);
  const [result] = await db.query(
    `UPDATE renovation_tasks
     SET ${fields.join(', ')}
     WHERE id = ? AND project_id = ?`,
    params
  );
  if (!result.affectedRows) return error(res, '任务不存在', 404);
  const progress = await refreshProjectStageByTaskCompletion(projectId);
  return success(res, { updated: true, progress }, '任务已更新');
}

async function createProjectTask(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const stageId = Number(req.body.stage_id);
  const taskName = String(req.body.task_name || '').trim().slice(0, 100);
  const plannedStart = req.body.planned_start;
  const plannedEnd = req.body.planned_end;
  const status = req.body.status === undefined ? 0 : Number(req.body.status);
  const isKey = req.body.is_key ? 1 : 0;
  const memberRole = await getProjectMemberRole(projectId, req.user.id);
  if (!progressChangeRoles.has(memberRole)) {
    return error(res, '只有业主、设计师或项目经理可以新增任务', 403);
  }
  if (!stages.some((stage) => stage.id === stageId)) return error(res, '项目阶段不正确');
  if (!taskName) return error(res, '请填写任务名称');
  if (
    !plannedStart ||
    !plannedEnd ||
    Number.isNaN(Date.parse(plannedStart)) ||
    Number.isNaN(Date.parse(plannedEnd)) ||
    Date.parse(plannedEnd) < Date.parse(plannedStart)
  ) {
    return error(res, '计划日期不正确');
  }
  if (![0, 1, 2, 3].includes(status)) return error(res, '任务状态不正确');
  if (memberRole !== 'owner') {
    const requestId = await queueProjectProgressChange({
      projectId,
      entityType: 'task',
      action: 'create',
      proposedPayload: {
        stage_id: stageId,
        task_name: taskName,
        planned_start: plannedStart,
        planned_end: plannedEnd,
        is_key: Boolean(isKey),
      },
      userId: req.user.id,
      role: memberRole,
    });
    return progressChangeResponse(res, requestId);
  }
  const [result] = await db.query(
    `INSERT INTO renovation_tasks
       (project_id, stage_id, task_name, is_key, planned_start, planned_end, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, stageId, taskName, isKey, plannedStart, plannedEnd, status]
  );
  const progress = await refreshProjectStageByTaskCompletion(projectId);
  return success(res, { id: result.insertId, progress }, '任务已新增');
}

async function findProjectInspectionStepRecordForTask(executor, projectId, taskId) {
  try {
    const [rows] = await executor.query(
      'SELECT id FROM project_inspection_step_records WHERE project_id = ? AND task_id = ? LIMIT 1',
      [projectId, taskId]
    );
    return rows[0] || null;
  } catch (queryError) {
    if (queryError?.code === 'ER_NO_SUCH_TABLE') {
      console.error('inspection step record table unavailable during task delete', {
        projectId,
        taskId,
        code: queryError.code,
        message: queryError.message,
      });
      return null;
    }
    const missingTaskLink =
      queryError?.code === 'ER_BAD_FIELD_ERROR' &&
      String(queryError.message || '').includes('task_id');
    if (!missingTaskLink) throw queryError;

    console.error('inspection step record task link fell back', {
      projectId,
      taskId,
      code: queryError.code,
      message: queryError.message,
    });
    const [rows] = await executor.query(
      `SELECT record.id
       FROM project_inspection_step_records record
       JOIN project_progress_items item
         ON item.id = record.progress_item_id
        AND item.project_id = record.project_id
       WHERE record.project_id = ? AND item.task_id = ?
       LIMIT 1`,
      [projectId, taskId]
    );
    return rows[0] || null;
  }
}

async function deleteProjectTask(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const taskId = Number(req.params.taskId);
  const memberRole = await getProjectMemberRole(projectId, req.user.id);
  if (!progressChangeRoles.has(memberRole)) {
    return error(res, '只有业主、设计师或项目经理可以删除事项', 403);
  }
  // Some early production databases were created before renovation_tasks
  // received its timestamp columns. Deleting an owner task does not require a
  // specific timestamp column, so read the row without naming optional fields.
  const [existingRows] = await db.query(
    'SELECT * FROM renovation_tasks WHERE id = ? AND project_id = ?',
    [taskId, projectId]
  );
  if (!existingRows[0]) return error(res, '事项不存在', 404);
  const [children] = await db.query(
    'SELECT COUNT(*) AS total FROM project_progress_items WHERE project_id = ? AND task_id = ?',
    [projectId, taskId]
  );
  if (Number(children[0].total) > 0) {
    return error(res, '该事项下已有子事项，请先删除子事项后再删除事项', 409);
  }
  const [inspections] = await db.query(
    'SELECT id FROM project_inspections WHERE project_id = ? AND task_id = ? LIMIT 1',
    [projectId, taskId]
  );
  if (inspections[0]) {
    return error(res, '该事项已有验收记录，不能删除，可调整名称或状态', 409);
  }
  const stepRecord = await findProjectInspectionStepRecordForTask(db, projectId, taskId);
  if (stepRecord) {
    return error(res, '该事项已有现场记录，不能删除，可调整名称或状态', 409);
  }
  if (memberRole !== 'owner') {
    const requestId = await queueProjectProgressChange({
      projectId,
      entityType: 'task',
      targetId: taskId,
      action: 'delete',
      beforeSnapshot: existingRows[0],
      userId: req.user.id,
      role: memberRole,
    });
    return progressChangeResponse(res, requestId);
  }
  let result;
  try {
    [result] = await db.query(
      'DELETE FROM renovation_tasks WHERE id = ? AND project_id = ?',
      [taskId, projectId]
    );
  } catch (deleteError) {
    if (
      ['ER_ROW_IS_REFERENCED', 'ER_ROW_IS_REFERENCED_2'].includes(deleteError?.code) ||
      Number(deleteError?.errno) === 1451
    ) {
      return error(res, '该事项仍有关联内容，不能删除，请先处理关联内容', 409);
    }
    throw deleteError;
  }
  if (!result.affectedRows) return error(res, '事项不存在', 404);
  let progress = null;
  try {
    progress = await refreshProjectStageByTaskCompletion(projectId);
  } catch (progressError) {
    // The delete has already succeeded. A derived-progress refresh failure must
    // not turn a completed mutation into a misleading HTTP 500 response.
    console.error('project task deleted but progress refresh failed', {
      projectId,
      taskId,
      code: progressError?.code,
      message: progressError?.message,
    });
  }
  return success(res, { deleted: true, progress }, '事项已删除');
}

async function completeProjectStage(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const stageId = Number(req.params.stageId);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以确认阶段', 403);
  }
  const [projects] = await db.query(
    'SELECT current_stage FROM renovation_projects WHERE id = ?',
    [projectId]
  );
  if (!projects[0]) return error(res, '项目不存在', 404);
  if (Number(projects[0].current_stage) !== stageId) {
    return error(res, '只能确认当前阶段');
  }
  const [unfinished] = await db.query(
    `SELECT COUNT(*) AS total FROM renovation_tasks
     WHERE project_id = ? AND stage_id = ? AND status != 2`,
    [projectId, stageId]
  );
  if (Number(unfinished[0].total) > 0) {
    return error(res, '当前阶段还有未完成任务');
  }
  const nextStage = Math.min(stageId + 1, stages.length);
  const status = stageId === stages.length ? 2 : 1;
  const progress = await refreshProjectStageByTaskCompletion(projectId);
  return success(res, progress || { current_stage: nextStage, status }, '阶段已确认');
}

async function getProjectProgressItems(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  await recomputeProjectProgressDerivedStatuses(projectId);
  const [rows] = await db.query(
    `SELECT item.id, item.project_id, item.stage_id, item.parent_id,
            item.template_key,
            item.title, item.task_id, item.planned_start, item.planned_end,
            item.actual_finish, item.status, item.remark,
            item.is_key_node, item.requires_inspection,
            item.inspection_template_key, item.sort_order, item.created_by,
            item.created_at, item.updated_at,
            creator.nickname AS creator_name
     FROM project_progress_items item
     JOIN users creator ON creator.id = item.created_by
     WHERE item.project_id = ?
     ORDER BY item.stage_id, item.sort_order, item.id`,
    [projectId]
  );
  return success(res, rows);
}

async function getProjectProgressItemAdjustments(req, res) {
  const projectId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '无权查看该项目', 403);
  }
  const [items] = await db.query(
    'SELECT id FROM project_progress_items WHERE id = ? AND project_id = ?',
    [itemId, projectId]
  );
  if (!items[0]) return error(res, '子事项不存在', 404);
  const [rows] = await db.query(
    `SELECT adjustment.id, adjustment.project_id, adjustment.progress_item_id,
            adjustment.action, adjustment.changed_fields,
            adjustment.changed_by, adjustment.changed_role, adjustment.created_at,
            COALESCE(user.nickname, '项目成员') AS changed_by_name
     FROM project_progress_item_adjustments adjustment
     LEFT JOIN users user ON user.id = adjustment.changed_by
     WHERE adjustment.project_id = ? AND adjustment.progress_item_id = ?
     ORDER BY adjustment.created_at DESC, adjustment.id DESC`,
    [projectId, itemId]
  );
  return success(res, rows);
}

async function getProgressItemDepth(projectId, parentId) {
  if (!parentId) return 0;
  let depth = 1;
  let cursor = parentId;
  while (cursor) {
    const [rows] = await db.query(
      `SELECT id, parent_id FROM project_progress_items
       WHERE id = ? AND project_id = ?`,
      [cursor, projectId]
    );
    if (!rows[0]) return -1;
    cursor = rows[0].parent_id;
    if (cursor) depth += 1;
    if (depth >= 3) break;
  }
  return depth;
}

function sanitizeProgressItemBody(body) {
  const title = String(body.title || '').trim().slice(0, 100);
  const stageId = Number(body.stage_id);
  const taskId = body.task_id ? Number(body.task_id) : null;
  const parentId = body.parent_id ? Number(body.parent_id) : null;
  const templateKey = String(body.template_key || '').trim().slice(0, 80) || null;
  const plannedStart = body.planned_start || null;
  const plannedEnd = body.planned_end || null;
  const actualFinish = body.actual_finish || null;
  const remark = String(body.remark || '').trim().slice(0, 1000) || null;
  const isKeyNode = body.is_key_node ? 1 : 0;
  const requiresInspection = body.requires_inspection ? 1 : 0;
  const inspectionTemplateKey =
    String(body.inspection_template_key || '').trim().slice(0, 64) || null;
  const sortOrder = Number(body.sort_order) || 0;
  return {
    title,
    stageId,
    taskId,
    parentId,
    templateKey,
    plannedStart,
    plannedEnd,
    actualFinish,
    status: 'pending',
    remark,
    isKeyNode,
    requiresInspection,
    inspectionTemplateKey,
    sortOrder,
  };
}

function validateProgressItem(item) {
  if (!item.title) return '请填写子事项名称';
  if (!stages.some((stage) => stage.id === item.stageId)) return '项目阶段不正确';
  if (
    item.plannedStart &&
    item.plannedEnd &&
    Date.parse(item.plannedEnd) < Date.parse(item.plannedStart)
  ) {
    return '计划结束时间不能早于开始时间';
  }
  for (const value of [item.plannedStart, item.plannedEnd, item.actualFinish]) {
    if (value && Number.isNaN(Date.parse(value))) return '日期格式不正确';
  }
  return null;
}

const progressItemAdjustmentFields = [
  { key: 'title', label: '子事项名称', column: 'title' },
  { key: 'stageId', label: '所属阶段', column: 'stage_id' },
  { key: 'taskId', label: '所属事项', column: 'task_id' },
  { key: 'parentId', label: '父级子事项', column: 'parent_id' },
  { key: 'plannedStart', label: '计划开始', column: 'planned_start' },
  { key: 'plannedEnd', label: '计划结束', column: 'planned_end' },
  { key: 'actualFinish', label: '实际完成', column: 'actual_finish' },
  { key: 'remark', label: '事项备注', column: 'remark' },
  { key: 'isKeyNode', label: '关键节点', column: 'is_key_node' },
  { key: 'requiresInspection', label: '需要验收', column: 'requires_inspection' },
  { key: 'inspectionTemplateKey', label: '验收模板', column: 'inspection_template_key' },
  { key: 'sortOrder', label: '排序', column: 'sort_order' },
];

const progressItemNotificationFields = new Set([
  'planned_start',
  'planned_end',
  'actual_finish',
  'requires_inspection',
  'remark',
]);

function normalizeProgressItemValue(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  return text;
}

function progressItemSnapshot(item) {
  return {
    title: item.title,
    stageId: item.stageId ?? item.stage_id,
    taskId: item.taskId ?? item.task_id,
    parentId: item.parentId ?? item.parent_id,
    plannedStart: item.plannedStart ?? item.planned_start,
    plannedEnd: item.plannedEnd ?? item.planned_end,
    actualFinish: item.actualFinish ?? item.actual_finish,
    status: item.status,
    remark: item.remark,
    isKeyNode: item.isKeyNode ?? item.is_key_node,
    requiresInspection: item.requiresInspection ?? item.requires_inspection,
    inspectionTemplateKey:
      item.inspectionTemplateKey ?? item.inspection_template_key,
    sortOrder: item.sortOrder ?? item.sort_order,
  };
}

function buildProgressItemChanges(before, after, { includeAll = false } = {}) {
  const beforeSnapshot = before ? progressItemSnapshot(before) : {};
  const afterSnapshot = progressItemSnapshot(after);
  return progressItemAdjustmentFields.reduce((changes, field) => {
    const oldValue = normalizeProgressItemValue(beforeSnapshot[field.key]);
    const newValue = normalizeProgressItemValue(afterSnapshot[field.key]);
    if (includeAll || oldValue !== newValue) {
      changes.push({
        field: field.column,
        label: field.label,
        old_value: oldValue,
        new_value: newValue,
      });
    }
    return changes;
  }, []);
}

async function recordProjectProgressItemAdjustment(
  executor,
  { projectId, itemId, action, changes, userId, role }
) {
  await executor.query(
    `INSERT INTO project_progress_item_adjustments
       (project_id, progress_item_id, action, changed_fields, changed_by, changed_role)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      itemId,
      action,
      JSON.stringify(changes || []),
      userId,
      role || null,
    ]
  );
}

async function createProjectProgressItem(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const memberRole = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(memberRole)) {
    return error(res, '只有业主、设计师、项目经理或项目监理可以维护子事项', 403);
  }
  const item = sanitizeProgressItemBody(req.body);
  const parentDepth = await getProgressItemDepth(projectId, item.parentId);
  if (parentDepth < 0) return error(res, '父级子事项不存在', 404);
  if (parentDepth >= 3) return error(res, '进度计划最多支持三级');
  if (item.parentId) {
    const [parents] = await db.query(
      `SELECT stage_id, task_id FROM project_progress_items
       WHERE id = ? AND project_id = ?`,
      [item.parentId, projectId]
    );
    if (!parents[0]) return error(res, '父级子事项不存在', 404);
    item.stageId = parents[0].stage_id;
    item.taskId = parents[0].task_id;
  } else if (item.taskId) {
    const [tasks] = await db.query(
      'SELECT id, stage_id FROM renovation_tasks WHERE id = ? AND project_id = ?',
      [item.taskId, projectId]
    );
    if (!tasks[0]) return error(res, '所属事项不存在', 404);
    item.stageId = tasks[0].stage_id;
  }
  const validationError = validateProgressItem(item);
  if (validationError) return error(res, validationError);
  if (item.templateKey) {
    const [duplicates] = await db.query(
      `SELECT id FROM project_progress_items
       WHERE project_id = ? AND template_key = ? LIMIT 1`,
      [projectId, item.templateKey]
    );
    if (duplicates[0]) return error(res, '该事项已加入项目进度', 409);
  }

  if (memberRole !== 'owner') {
    const requestId = await queueProjectProgressChange({
      projectId,
      entityType: 'progress_item',
      action: 'create',
      proposedPayload: {
        stage_id: item.stageId,
        task_id: item.taskId,
        parent_id: item.parentId,
        template_key: item.templateKey,
        title: item.title,
        planned_start: item.plannedStart,
        planned_end: item.plannedEnd,
        remark: item.remark,
        is_key_node: Boolean(item.isKeyNode),
        requires_inspection: Boolean(item.requiresInspection),
        inspection_template_key: item.inspectionTemplateKey,
        sort_order: item.sortOrder,
      },
      userId: req.user.id,
      role: memberRole,
    });
    return progressChangeResponse(res, requestId);
  }

  const [result] = await db.query(
    `INSERT INTO project_progress_items
       (project_id, stage_id, task_id, parent_id, template_key, title,
        planned_start, planned_end, actual_finish, status, remark, is_key_node,
        requires_inspection, inspection_template_key, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      projectId,
      item.stageId,
      item.taskId,
      item.parentId,
      item.templateKey,
      item.title,
      item.plannedStart,
      item.plannedEnd,
      item.actualFinish,
      item.status,
      item.remark,
      item.isKeyNode,
      item.requiresInspection,
      item.inspectionTemplateKey,
      item.sortOrder,
      req.user.id,
    ]
  );
  if (item.templateKey) {
    await db.query(
      'DELETE FROM project_work_item_template_status WHERE project_id = ? AND template_key = ?',
      [projectId, item.templateKey]
    );
  }
  await recordProjectProgressItemAdjustment(db, {
    projectId,
    itemId: result.insertId,
    action: 'created',
    changes: buildProgressItemChanges(null, item, { includeAll: true }),
    userId: req.user.id,
    role: memberRole,
  });
  await recomputeProjectProgressDerivedStatuses(projectId);
  return success(res, { id: result.insertId }, '子事项已创建');
}

async function updateProjectProgressItem(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const memberRole = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(memberRole)) {
    return error(res, '只有业主、设计师、项目经理或项目监理可以维护子事项', 403);
  }
  const [existingRows] = await db.query(
    `SELECT id, stage_id, task_id, parent_id, template_key, title,
            planned_start, planned_end, actual_finish, status, remark,
            is_key_node, requires_inspection, inspection_template_key, sort_order,
            updated_at
     FROM project_progress_items
     WHERE id = ? AND project_id = ?`,
    [itemId, projectId]
  );
  if (!existingRows[0]) return error(res, '子事项不存在', 404);
  const item = sanitizeProgressItemBody({
    ...req.body,
    stage_id: req.body.stage_id ?? existingRows[0].stage_id,
    task_id: req.body.task_id ?? existingRows[0].task_id,
    parent_id: req.body.parent_id ?? existingRows[0].parent_id,
    template_key: req.body.template_key ?? existingRows[0].template_key,
    status: existingRows[0].status,
    actual_finish:
      req.body.actual_finish === undefined
        ? existingRows[0].actual_finish
        : req.body.actual_finish,
    requires_inspection:
      req.body.requires_inspection ?? existingRows[0].requires_inspection,
    inspection_template_key:
      req.body.inspection_template_key ?? existingRows[0].inspection_template_key,
  });
  if (item.parentId === itemId) return error(res, '不能把自己设为父级子事项');
  const parentDepth = await getProgressItemDepth(projectId, item.parentId);
  if (parentDepth < 0) return error(res, '父级子事项不存在', 404);
  if (parentDepth >= 3) return error(res, '进度计划最多支持三级');
  if (item.parentId) {
    const [parents] = await db.query(
      `SELECT stage_id, task_id FROM project_progress_items
       WHERE id = ? AND project_id = ?`,
      [item.parentId, projectId]
    );
    item.stageId = parents[0].stage_id;
    item.taskId = parents[0].task_id;
  } else if (item.taskId) {
    const [tasks] = await db.query(
      'SELECT id, stage_id FROM renovation_tasks WHERE id = ? AND project_id = ?',
      [item.taskId, projectId]
    );
    if (!tasks[0]) return error(res, '所属事项不存在', 404);
    item.stageId = tasks[0].stage_id;
  }
  const validationError = validateProgressItem(item);
  if (validationError) return error(res, validationError);
  const changes = buildProgressItemChanges(existingRows[0], item);
  if (memberRole !== 'owner') {
    const requestId = await queueProjectProgressChange({
      projectId,
      entityType: 'progress_item',
      targetId: itemId,
      action: 'update',
      beforeSnapshot: existingRows[0],
      proposedPayload: {
        stage_id: item.stageId,
        task_id: item.taskId,
        parent_id: item.parentId,
        template_key: item.templateKey,
        title: item.title,
        planned_start: item.plannedStart,
        planned_end: item.plannedEnd,
        remark: item.remark,
        is_key_node: Boolean(item.isKeyNode),
        requires_inspection: Boolean(item.requiresInspection),
        inspection_template_key: item.inspectionTemplateKey,
        sort_order: item.sortOrder,
      },
      userId: req.user.id,
      role: memberRole,
    });
    return progressChangeResponse(res, requestId);
  }
  const [result] = await db.query(
    `UPDATE project_progress_items
     SET stage_id = ?, task_id = ?, parent_id = ?, title = ?, planned_start = ?,
         planned_end = ?, actual_finish = ?, remark = ?,
         is_key_node = ?, template_key = ?, requires_inspection = ?,
         inspection_template_key = ?, sort_order = ?
     WHERE id = ? AND project_id = ?`,
    [
      item.stageId,
      item.taskId,
      item.parentId,
      item.title,
      item.plannedStart,
      item.plannedEnd,
      item.actualFinish,
      item.remark,
      item.isKeyNode,
      item.templateKey,
      item.requiresInspection,
      item.inspectionTemplateKey,
      item.sortOrder,
      itemId,
      projectId,
    ]
  );
  if (!result.affectedRows) return error(res, '子事项不存在', 404);
  if (changes.length) {
    await recordProjectProgressItemAdjustment(db, {
      projectId,
      itemId,
      action: 'updated',
      changes,
      userId: req.user.id,
      role: memberRole,
    });
    if (changes.some((change) => progressItemNotificationFields.has(change.field))) {
      await emitProjectEvent(ProjectEventType.PROGRESS_ITEM_UPDATED, {
        projectId,
        actorId: req.user.id,
        targetUserIds: uniqueUserIds(
          await getActiveProjectMemberUserIds(projectId, [
            'designer',
            'project_manager',
          ]),
          await getOwnerSideMemberUserIds(projectId)
        ),
        entityType: 'progress_item',
        entityId: itemId,
        title: '项目进度已调整',
        content: item.title,
        route: 'project_progress',
        deepLink: { projectId, progressItemId: itemId },
        detailData: { changes },
      });
    }
  }
  await recomputeProjectProgressDerivedStatuses(projectId);
  return success(res, { updated: true }, '子事项已更新');
}

async function deleteProjectProgressItem(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  const memberRole = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(memberRole)) {
    return error(res, '只有业主、设计师、项目经理或项目监理可以维护子事项', 403);
  }
  if (memberRole !== 'owner') {
    const [existingRows] = await db.query(
      `SELECT id, stage_id, task_id, parent_id, template_key, title,
              planned_start, planned_end, actual_finish, status, remark,
              is_key_node, requires_inspection, inspection_template_key,
              sort_order, updated_at
       FROM project_progress_items WHERE id = ? AND project_id = ?`,
      [itemId, projectId]
    );
    if (!existingRows[0]) return error(res, '子事项不存在', 404);
    const ids = await collectProgressItemIds(db, projectId, itemId);
    const [[inspectionRows], [stepRecordRows]] = await Promise.all([
      db.query(
        'SELECT id FROM project_inspections WHERE project_id = ? AND progress_item_id IN (?) LIMIT 1',
        [projectId, ids]
      ),
      db.query(
        'SELECT id FROM project_inspection_step_records WHERE project_id = ? AND progress_item_id IN (?) LIMIT 1',
        [projectId, ids]
      ),
    ]);
    if (inspectionRows[0] || stepRecordRows[0]) {
      return error(res, '该子事项已有验收记录，不能删除，可调整名称或状态', 409);
    }
    const requestId = await queueProjectProgressChange({
      projectId,
      entityType: 'progress_item',
      targetId: itemId,
      action: 'delete',
      beforeSnapshot: existingRows[0],
      userId: req.user.id,
      role: memberRole,
    });
    return progressChangeResponse(res, requestId);
  }
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existingRows] = await connection.query(
      'SELECT id FROM project_progress_items WHERE id = ? AND project_id = ?',
      [itemId, projectId]
    );
    if (!existingRows[0]) {
      await connection.rollback();
      return error(res, '子事项不存在', 404);
    }

    const ids = [itemId];
    for (let index = 0; index < ids.length; index += 1) {
      const [children] = await connection.query(
        'SELECT id FROM project_progress_items WHERE project_id = ? AND parent_id = ?',
        [projectId, ids[index]]
      );
      for (const child of children) ids.push(child.id);
    }

    const [inspectionRows] = await connection.query(
      'SELECT id FROM project_inspections WHERE project_id = ? AND progress_item_id IN (?) LIMIT 1',
      [projectId, ids]
    );
    if (inspectionRows[0]) {
      await connection.rollback();
      return error(res, '该子事项已有验收记录，不能删除，可调整名称或状态', 409);
    }
    const [stepRecordRows] = await connection.query(
      'SELECT id FROM project_inspection_step_records WHERE project_id = ? AND progress_item_id IN (?) LIMIT 1',
      [projectId, ids]
    );
    if (stepRecordRows[0]) {
      await connection.rollback();
      return error(res, '该子事项已有验收记录，不能删除，可调整名称或状态', 409);
    }

    await recordProjectProgressItemAdjustment(connection, {
      projectId,
      itemId,
      action: 'deleted',
      changes: [],
      userId: req.user.id,
      role: memberRole,
    });
    await connection.query(
      'DELETE FROM project_progress_items WHERE project_id = ? AND id IN (?)',
      [projectId, ids]
    );
    await connection.commit();

    const progress = await refreshProjectStageByTaskCompletion(projectId);
    return success(
      res,
      { deleted: true, deleted_count: ids.length, progress },
      '子事项已删除'
    );
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

let projectInspectionMemberRoleReady = null;

async function ensureProjectInspectionMemberRoleColumn() {
  if (!projectInspectionMemberRoleReady) {
    projectInspectionMemberRoleReady = (async () => {
      const [columns] = await db.query(`
        SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'project_inspections'
          AND COLUMN_NAME = 'member_role'
      `);
      if (columns.length) return true;
      try {
        await db.query(`
          ALTER TABLE project_inspections
          ADD COLUMN member_role VARCHAR(32) NOT NULL DEFAULT 'owner' AFTER submitted_by
        `);
        return true;
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME') return true;
        console.warn('project_inspections.member_role unavailable:', err.message);
        return false;
      }
    })().catch((err) => {
      projectInspectionMemberRoleReady = null;
      throw err;
    });
  }
  return projectInspectionMemberRoleReady;
}

async function getProjectInspections(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const hasMemberRole = await ensureProjectInspectionMemberRoleColumn();
  const memberRoleExpression = hasMemberRole ? 'i.`member_role`' : "'owner'";
  const ownerRoleSql = "'owner', 'owner_member'";
  const visibleStatusExpression = `
            CASE
              WHEN i.status = 'pending'
                   AND ${memberRoleExpression} IN (${ownerRoleSql})
                   AND i.submission_round = 1
                   AND i.responsible_user_id IS NOT NULL THEN 'rework'
              WHEN i.status = 'pending'
                   AND ${memberRoleExpression} IN (${ownerRoleSql})
                   AND i.responsible_user_id IS NULL THEN 'passed'
              ELSE i.status
            END`;
  const requesterRole = await getProjectMemberRole(projectId, req.user.id);
  const requesterOwnerSide = isOwnerSideRole(requesterRole);
  const requesterCompanyAdminReadOnly = requesterRole === companyAdminViewerRole;
  const filters = ['i.project_id = ?'];
  const params = [projectId];
  if (!requesterOwnerSide && !requesterCompanyAdminReadOnly) {
    filters.push(`
      (
        (i.status = 'pending'
          AND ${memberRoleExpression} NOT IN (${ownerRoleSql})
          AND i.submitted_by = ?)
        OR (i.status = 'rework'
          AND (i.responsible_user_id = ? OR i.submitted_by = ?))
        OR (i.status = 'passed'
          AND (i.responsible_user_id = ? OR i.submitted_by = ?))
        OR (i.status = 'pending'
          AND ${memberRoleExpression} IN (${ownerRoleSql})
          AND i.responsible_user_id = ?)
      )
    `);
    params.push(
      req.user.id,
      req.user.id,
      req.user.id,
      req.user.id,
      req.user.id,
      req.user.id
    );
  }
  const [rows] = await db.query(
    `SELECT i.id, i.project_id, i.task_id, i.progress_item_id,
            i.stage_id, i.responsible_user_id,
            ${visibleStatusExpression} AS status,
            ${memberRoleExpression} AS member_role,
            i.description, i.review_remark, i.submission_round,
            i.created_at, i.updated_at, i.reviewed_at,
            COALESCE(i.title, progress_item.title, t.task_name, '阶段验收') AS task_name,
            submitter.nickname AS submitter_name,
            responsible.nickname AS responsible_name,
            (SELECT pm.role
             FROM project_members pm
             WHERE pm.project_id = i.project_id
               AND pm.user_id = i.responsible_user_id
               AND pm.status = 1
             ORDER BY FIELD(pm.role, 'owner', 'owner_member',
                            'project_manager', 'project_supervisor',
                            'designer', 'merchant'), pm.id
             LIMIT 1) AS responsible_role,
            reviewer.nickname AS reviewer_name
     FROM project_inspections i
     LEFT JOIN renovation_tasks t ON t.id = i.task_id
     LEFT JOIN project_progress_items progress_item
            ON progress_item.id = i.progress_item_id
     JOIN users submitter ON submitter.id = i.submitted_by
     LEFT JOIN users responsible ON responsible.id = i.responsible_user_id
     LEFT JOIN users reviewer ON reviewer.id = i.reviewed_by
     WHERE ${filters.join(' AND ')}
     ORDER BY CASE i.status WHEN 'pending' THEN 0 WHEN 'rework' THEN 1 ELSE 2 END,
              i.updated_at DESC`,
    params
  );
  const [images] = await db.query(
    `SELECT image.id, image.inspection_id, image.image_url,
            image.submission_round, image.created_at
     FROM project_inspection_images image
     JOIN project_inspections inspection ON inspection.id = image.inspection_id
     WHERE inspection.project_id = ?
     ORDER BY image.submission_round, image.id`,
    [projectId]
  );
  const imageMap = new Map();
  for (const image of images) {
    if (!imageMap.has(image.inspection_id)) imageMap.set(image.inspection_id, []);
    imageMap.get(image.inspection_id).push(image);
  }
  const [designChecks] = await db.query(
    `SELECT id, inspection_id, design_handover_id, design_handover_item_id,
            snapshot_source_title, snapshot_version_no, snapshot_summary,
            check_result, checked_by, checked_at, created_at, updated_at
     FROM project_inspection_design_checks
     WHERE project_id = ?
     ORDER BY id`,
    [projectId]
  );
  const designCheckMap = new Map();
  for (const item of designChecks) {
    if (!designCheckMap.has(item.inspection_id)) {
      designCheckMap.set(item.inspection_id, []);
    }
    designCheckMap.get(item.inspection_id).push(item);
  }
  return success(
    res,
    rows.map((item) => ({
      ...item,
      images: imageMap.get(item.id) || [],
      design_checks: designCheckMap.get(item.id) || [],
    }))
  );
}

async function getProjectInspectionTemplates(req, res) {
  const projectId = Number(req.params.id);
  const requestedStageId = req.query.stage_id ? Number(req.query.stage_id) : null;
  const includeAll = req.query.all === '1' || req.query.all === 'true';
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [projects] = await db.query(
    'SELECT current_stage FROM renovation_projects WHERE id = ?',
    [projectId]
  );
  if (!projects[0]) return error(res, '项目不存在', 404);
  const stageId = requestedStageId || Number(projects[0].current_stage);
  const stageFilter = includeAll
    ? ''
    : 'AND (stage_id = ? OR (? = 8 AND node_type = "final"))';
  const stageParams = includeAll ? [] : [stageId, stageId];
  const [templates] = await db.query(
    `SELECT id, code, title, stage_id, node_type, description,
            standard_basis, applicable_project_types, applicable_methods,
            recommended_tools, sort_order
     FROM inspection_templates
     WHERE is_active = 1
       ${stageFilter}
     ORDER BY sort_order, id`,
    stageParams
  );
  if (!templates.length) return success(res, []);
  const templateIds = templates.map((item) => item.id);
  const [itemCounts] = await db.query(
    `SELECT template_id, COUNT(*) AS total,
            SUM(CASE WHEN risk_level = 'must' THEN 1 ELSE 0 END) AS must_count,
            SUM(CASE WHEN risk_level = 'important' THEN 1 ELSE 0 END) AS important_count
     FROM inspection_template_items
     WHERE is_active = 1 AND template_id IN (${templateIds.map(() => '?').join(', ')})
     GROUP BY template_id`,
    templateIds
  );
  const countMap = new Map(itemCounts.map((row) => [row.template_id, row]));
  return success(
    res,
    templates.map((template) => {
      const counts = countMap.get(template.id) || {};
      return {
        ...template,
        stage_name: stages.find((stage) => stage.id === Number(template.stage_id))?.name || null,
        recommended_tools: parseJsonField(template.recommended_tools, []),
        applicable_project_types: parseJsonField(template.applicable_project_types, []),
        applicable_methods: parseJsonField(template.applicable_methods, []),
        item_count: Number(counts.total) || 0,
        must_count: Number(counts.must_count) || 0,
        important_count: Number(counts.important_count) || 0,
      };
    })
  );
}

async function getProjectInspectionTemplateDetail(req, res) {
  const projectId = Number(req.params.id);
  const templateId = Number(req.params.templateId);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [templates] = await db.query(
    `SELECT id, code, title, stage_id, node_type, description,
            standard_basis, applicable_project_types, applicable_methods,
            recommended_tools, sort_order
     FROM inspection_templates
     WHERE id = ? AND is_active = 1`,
    [templateId]
  );
  const template = templates[0];
  if (!template) return error(res, '验收模板不存在', 404);
  const [items] = await db.query(
    `SELECT id, code, title, standard_text, check_method, required_tools,
            risk_level, failure_action, require_photo, sort_order
     FROM inspection_template_items
     WHERE template_id = ? AND is_active = 1
     ORDER BY sort_order, id`,
    [templateId]
  );
  return success(res, {
    ...template,
    stage_name: stages.find((stage) => stage.id === Number(template.stage_id))?.name || null,
    recommended_tools: parseJsonField(template.recommended_tools, []),
    applicable_project_types: parseJsonField(template.applicable_project_types, []),
    applicable_methods: parseJsonField(template.applicable_methods, []),
    items: items.map((item) => ({
      ...item,
      required_tools: parseJsonField(item.required_tools, []),
      require_photo: Boolean(item.require_photo),
    })),
  });
}

async function getProjectWorkItemTemplates(req, res) {
  const projectId = Number(req.params.id);
  const requestedStageId = req.query.stage_id ? Number(req.query.stage_id) : null;
  const includeAll = req.query.all === '1' || req.query.all === 'true';
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [projects] = await db.query(
    'SELECT current_stage FROM renovation_projects WHERE id = ?',
    [projectId]
  );
  if (!projects[0]) return error(res, '项目不存在', 404);
  const stageId = requestedStageId || Number(projects[0].current_stage);
  const params = [];
  let stageFilter = '';
  if (!includeAll) {
    stageFilter = 'AND template.stage_id = ?';
    params.push(stageId);
  }
  const [items] = await db.query(
    `SELECT template.id, template.template_key, template.stage_id, template.title,
            template.required_level, template.requires_inspection,
            template.inspection_template_key, template.default_responsible_role,
            template.suggested_timing, template.description, template.sort_order,
            template.parent_template_key, template.source, template.default_join,
            template.is_key_node, template.applicable_project_types,
            template.not_applicable_note,
            CASE
              WHEN progress.id IS NOT NULL OR task.id IS NOT NULL THEN 'added'
              WHEN state.status IS NOT NULL THEN state.status
              ELSE 'not_added'
            END AS selection_status
     FROM renovation_work_item_templates
     template
     LEFT JOIN project_progress_items progress
            ON progress.project_id = ? AND progress.template_key = template.template_key
     LEFT JOIN renovation_tasks task
            ON task.project_id = ?
           AND task.stage_id = template.stage_id
           AND task.task_name COLLATE utf8mb4_unicode_ci = template.title
           AND template.default_join = 1
     LEFT JOIN project_work_item_template_status state
            ON state.project_id = ? AND state.template_key = template.template_key
     WHERE template.is_active = 1
       ${stageFilter}
     ORDER BY template.stage_id, template.sort_order, template.id`,
    [projectId, projectId, projectId, ...params]
  );
  return success(
    res,
    items.map((item) => ({
      ...item,
      stage_name:
        stages.find((stage) => stage.id === Number(item.stage_id))?.name || null,
      requires_inspection: Boolean(item.requires_inspection),
      default_join: Boolean(item.default_join),
      is_key_node: Boolean(item.is_key_node),
    }))
  );
}

async function updateProjectWorkItemTemplateStatus(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const templateKey = String(req.params.templateKey || '').trim();
  const status = String(req.body.status || '').trim();
  const note = String(req.body.note || '').trim().slice(0, 300) || null;
  if (!(await canManageProjectProgress(projectId, req.user.id))) {
    return error(res, '只有业主、设计师或项目经理可以确认事项状态', 403);
  }
  if (!['not_applicable', 'later', 'not_added'].includes(status)) {
    return error(res, '事项状态不正确');
  }
  const [templates] = await db.query(
    'SELECT id FROM renovation_work_item_templates WHERE template_key = ? AND is_active = 1',
    [templateKey]
  );
  if (!templates[0]) return error(res, '事项模板不存在', 404);
  if (status === 'not_added') {
    await db.query(
      'DELETE FROM project_work_item_template_status WHERE project_id = ? AND template_key = ?',
      [projectId, templateKey]
    );
    return success(res, { status: 'not_added' }, '事项已恢复为待确认');
  }
  await db.query(
    `INSERT INTO project_work_item_template_status
       (project_id, template_key, status, note, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status = VALUES(status),
       note = VALUES(note),
       updated_by = VALUES(updated_by)`,
    [projectId, templateKey, status, note, req.user.id]
  );
  return success(res, { status }, status === 'not_applicable' ? '已标记不适用' : '已稍后确认');
}

function parseJsonField(value, fallback) {
  if (!value) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

const unifiedInspectionItemResults = new Set([
  'pending',
  'passed',
  'failed',
  'not_applicable',
]);
const unifiedInspectionDraftStatuses = new Set(['draft', 'in_progress']);

function normalizeUnifiedInspectionItems(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) return null;
  const seen = new Set();
  const items = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index] || {};
    const itemKey = String(raw.item_key || '').trim().slice(0, 160);
    const title = String(raw.title || '').trim().slice(0, 160);
    const result = String(raw.result || 'pending').trim();
    if (!itemKey || !title || seen.has(itemKey) || !unifiedInspectionItemResults.has(result)) {
      return null;
    }
    seen.add(itemKey);
    items.push({
      templateItemId: raw.template_item_id ? Number(raw.template_item_id) : null,
      itemKey,
      title,
      standardText: String(raw.standard_text || '').trim().slice(0, 4000) || null,
      checkMethod: String(raw.check_method || '').trim().slice(0, 4000) || null,
      failureAction: String(raw.failure_action || '').trim().slice(0, 4000) || null,
      riskLevel: String(raw.risk_level || 'normal').trim().slice(0, 16),
      requirePhoto: raw.require_photo ? 1 : 0,
      result,
      description: String(raw.description || '').trim().slice(0, 500) || null,
      responsibleUserId: raw.responsible_user_id
        ? Number(raw.responsible_user_id)
        : null,
      sortOrder: Number.isFinite(Number(raw.sort_order))
        ? Number(raw.sort_order)
        : index * 10,
      sourceStepRecordId: raw.source_step_record_id
        ? Number(raw.source_step_record_id)
        : null,
    });
  }
  return items;
}

async function validateUnifiedInspectionTemplate(
  templateCode,
  stageId,
  items,
  executor = db
) {
  if (!templateCode) return { template: null };
  const [templates] = await executor.query(
    `SELECT id, code, title, stage_id
     FROM inspection_templates
     WHERE code = ? AND is_active = 1
     LIMIT 1`,
    [templateCode]
  );
  const template = templates[0];
  if (!template) return { error: '现场查看模板不存在或已停用' };
  if (template.stage_id && Number(template.stage_id) !== Number(stageId)) {
    return { error: '现场查看模板与项目阶段不匹配' };
  }
  const [templateItems] = await executor.query(
    `SELECT id, code, title
     FROM inspection_template_items
     WHERE template_id = ? AND is_active = 1
     ORDER BY sort_order, id`,
    [template.id]
  );
  const submittedKeys = new Set(items.map((item) => item.itemKey));
  const missing = templateItems.filter((item) => !submittedKeys.has(item.code));
  if (missing.length) {
    return {
      error: `现场查看项不完整，缺少：${missing
        .slice(0, 5)
        .map((item) => item.title)
        .join('、')}`,
    };
  }
  return { template };
}

async function getProjectInspectionWorkspace(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [projects] = await db.query(
    `SELECT id, project_name, current_stage, project_type,
            renovation_method, updated_at
     FROM renovation_projects WHERE id = ?`,
    [projectId]
  );
  if (!projects[0]) return error(res, '项目不存在', 404);
  const [progressItems] = await db.query(
    `SELECT id, task_id, parent_id, stage_id, template_key, title,
            status, actual_finish, requires_inspection, inspection_template_key,
            sort_order, updated_at
     FROM project_progress_items
     WHERE project_id = ?
     ORDER BY stage_id, sort_order, id`,
    [projectId]
  );
  const [templateRows] = await db.query(
    `SELECT template.id, template.code, template.title, template.stage_id,
            template.node_type, template.description, template.standard_basis,
            template.recommended_tools, template.sort_order,
            item.id AS item_id, item.code AS item_code, item.title AS item_title,
            item.standard_text, item.check_method, item.required_tools,
            item.risk_level, item.failure_action, item.require_photo,
            item.sort_order AS item_sort_order
     FROM inspection_templates template
     LEFT JOIN inspection_template_items item
       ON item.template_id = template.id AND item.is_active = 1
     WHERE template.is_active = 1
     ORDER BY template.sort_order, template.id, item.sort_order, item.id`
  );
  const templateMap = new Map();
  for (const row of templateRows) {
    if (!templateMap.has(row.id)) {
      templateMap.set(row.id, {
        id: row.id,
        code: row.code,
        title: row.title,
        stage_id: row.stage_id,
        node_type: row.node_type,
        description: row.description,
        standard_basis: row.standard_basis,
        recommended_tools: parseJsonField(row.recommended_tools, []),
        sort_order: row.sort_order,
        items: [],
      });
    }
    if (row.item_id) {
      templateMap.get(row.id).items.push({
        id: row.item_id,
        code: row.item_code,
        title: row.item_title,
        standard_text: row.standard_text,
        check_method: row.check_method,
        required_tools: parseJsonField(row.required_tools, []),
        risk_level: row.risk_level,
        failure_action: row.failure_action,
        require_photo: Boolean(row.require_photo),
        sort_order: row.item_sort_order,
      });
    }
  }
  const requesterRole = await getProjectMemberRole(projectId, req.user.id);
  const inspectionFilters = ['project_id = ?'];
  const inspectionParams = [projectId];
  if (!isOwnerSideRole(requesterRole) && requesterRole !== companyAdminViewerRole) {
    inspectionFilters.push(
      '(submitted_by = ? OR responsible_user_id = ? OR status = \'passed\')'
    );
    inspectionParams.push(req.user.id, req.user.id);
  }
  const [inspections] = await db.query(
    `SELECT id, task_id, progress_item_id, stage_id, title, template_id,
            template_code, status, description, algorithm_version,
            calculation_summary, row_version, calculated_at,
            submitted_by, responsible_user_id, created_at, updated_at
     FROM project_inspections
     WHERE ${inspectionFilters.join(' AND ')}
     ORDER BY updated_at DESC`,
    inspectionParams
  );
  const inspectionIds = inspections.map((item) => item.id);
  let inspectionItems = [];
  if (inspectionIds.length) {
    [inspectionItems] = await db.query(
      `SELECT id, inspection_id, template_item_id, item_key, title,
              standard_text, check_method, failure_action, risk_level,
              require_photo, result, description, responsible_user_id,
              checked_by, checked_at, sort_order, source_step_record_id,
              created_at, updated_at
       FROM project_inspection_items
       WHERE inspection_id IN (?)
       ORDER BY inspection_id, sort_order, id`,
      [inspectionIds]
    );
  }
  const itemMap = new Map();
  for (const item of inspectionItems) {
    if (!itemMap.has(item.inspection_id)) itemMap.set(item.inspection_id, []);
    itemMap.get(item.inspection_id).push({
      ...item,
      require_photo: Boolean(item.require_photo),
    });
  }
  return success(res, {
    project: projects[0],
    progress_items: progressItems.map((item) => ({
      ...item,
      requires_inspection: Boolean(item.requires_inspection),
    })),
    templates: [...templateMap.values()],
    inspections: inspections.map((inspection) => ({
      ...inspection,
      calculation_summary: parseJsonField(inspection.calculation_summary, null),
      items: itemMap.get(inspection.id) || [],
    })),
    workspace_version: projects[0].updated_at,
  });
}

async function insertUnifiedInspectionItems(connection, inspectionId, projectId, items) {
  await connection.query(
    `INSERT INTO project_inspection_items
       (inspection_id, project_id, template_item_id, item_key, title,
        standard_text, check_method, failure_action, risk_level, require_photo,
        result, description, responsible_user_id, sort_order, source_step_record_id)
     VALUES ${items.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
    items.flatMap((item) => [
      inspectionId,
      projectId,
      item.templateItemId,
      item.itemKey,
      item.title,
      item.standardText,
      item.checkMethod,
      item.failureAction,
      item.riskLevel,
      item.requirePhoto,
      item.result,
      item.description,
      item.responsibleUserId,
      item.sortOrder,
      item.sourceStepRecordId,
    ])
  );
}

async function createProjectInspectionDraft(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role || role === companyAdminViewerRole) {
    return error(res, '当前身份只能查看现场记录', 403);
  }
  const items = normalizeUnifiedInspectionItems(req.body.items);
  if (!items) return error(res, '请提交1至100个有效现场查看项');
  const progressItemId = req.body.progress_item_id
    ? Number(req.body.progress_item_id)
    : null;
  const taskIdInput = req.body.task_id ? Number(req.body.task_id) : null;
  const clientRequestId = String(req.body.client_request_id || '').trim().slice(0, 64);
  if (!clientRequestId) return error(res, '缺少客户端请求编号');
  let progressItem = null;
  if (progressItemId) {
    const [rows] = await db.query(
      `SELECT id, task_id, stage_id, title, inspection_template_key
       FROM project_progress_items
       WHERE id = ? AND project_id = ?`,
      [progressItemId, projectId]
    );
    progressItem = rows[0];
    if (!progressItem) return error(res, '进度事项不存在', 404);
  }
  const stageId = Number(req.body.stage_id || progressItem?.stage_id);
  const taskId = taskIdInput || (progressItem?.task_id ? Number(progressItem.task_id) : null);
  if (!stageId) return error(res, '缺少记录阶段');
  if (taskId) {
    const [tasks] = await db.query(
      'SELECT id FROM renovation_tasks WHERE id = ? AND project_id = ?',
      [taskId, projectId]
    );
    if (!tasks[0]) return error(res, '关联任务不存在', 404);
  }
  const templateCode = String(
    req.body.template_code || progressItem?.inspection_template_key || ''
  ).trim().slice(0, 64) || null;
  const validation = await validateUnifiedInspectionTemplate(templateCode, stageId, items);
  if (validation.error) return error(res, validation.error);
  const status = String(req.body.status || 'draft');
  if (!unifiedInspectionDraftStatuses.has(status)) return error(res, '现场记录草稿状态不正确');

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.query(
      `SELECT id, row_version, status FROM project_inspections
       WHERE project_id = ? AND client_request_id = ?
       LIMIT 1 FOR UPDATE`,
      [projectId, clientRequestId]
    );
    if (existing[0]) {
      await connection.commit();
      return success(res, existing[0], '现场记录草稿已存在');
    }
    const [result] = await connection.query(
      `INSERT INTO project_inspections
       (project_id, task_id, progress_item_id, stage_id, title,
        template_id, template_code, client_request_id, submitted_by,
        member_role, responsible_user_id, status, description,
        algorithm_version, calculation_summary, row_version, calculated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        projectId,
        taskId,
        progressItemId,
        stageId,
        String(req.body.title || progressItem?.title || validation.template?.title || '阶段验收')
          .trim()
          .slice(0, 160),
        validation.template?.id || null,
        templateCode,
        clientRequestId,
        req.user.id,
        role,
        req.body.responsible_user_id ? Number(req.body.responsible_user_id) : null,
        status,
        String(req.body.description || '').trim().slice(0, 500),
        String(req.body.algorithm_version || '').trim().slice(0, 40) || null,
        req.body.calculation_summary ? JSON.stringify(req.body.calculation_summary) : null,
        req.body.calculated_at ? new Date(req.body.calculated_at) : null,
      ]
    );
    await insertUnifiedInspectionItems(connection, result.insertId, projectId, items);
    await connection.commit();
    return success(res, { id: result.insertId, row_version: 1, status }, '现场记录草稿已保存');
  } catch (draftError) {
    await connection.rollback();
    if (draftError.code === 'ER_DUP_ENTRY') {
      const [existing] = await db.query(
        `SELECT id, row_version, status FROM project_inspections
         WHERE project_id = ? AND client_request_id = ? LIMIT 1`,
        [projectId, clientRequestId]
      );
      if (existing[0]) return success(res, existing[0], '现场记录草稿已存在');
    }
    throw draftError;
  } finally {
    connection.release();
  }
}

async function updateProjectInspectionBatch(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const projectId = Number(req.params.id);
  const inspectionId = Number(req.params.inspectionId);
  const baseVersion = Number(req.body.base_version);
  const items = normalizeUnifiedInspectionItems(req.body.items);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) return error(res, '缺少有效的数据版本');
  if (!items) return error(res, '请提交1至100个有效现场查看项');
  const status = String(req.body.status || 'in_progress');
  if (!unifiedInspectionDraftStatuses.has(status)) return error(res, '现场记录状态不正确');
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, stage_id, template_code, submitted_by, row_version, status
       FROM project_inspections
       WHERE id = ? AND project_id = ?
       LIMIT 1 FOR UPDATE`,
      [inspectionId, projectId]
    );
    const inspection = rows[0];
    if (!inspection) {
      await connection.rollback();
      return error(res, '现场记录不存在', 404);
    }
    const role = await getProjectMemberRole(projectId, req.user.id);
    if (
      Number(inspection.submitted_by) !== Number(req.user.id) &&
      !isOwnerSideRole(role) &&
      !['project_manager', 'project_supervisor'].includes(role)
    ) {
      await connection.rollback();
      return error(res, '无权修改该现场记录', 403);
    }
    if (Number(inspection.row_version) !== baseVersion) {
      await connection.rollback();
      return error(res, '现场记录已被其他成员更新，请刷新后重试', 409);
    }
    if (inspection.status === 'passed') {
      await connection.rollback();
      return error(res, '已确认完成的现场记录不能直接覆盖', 409);
    }
    const validation = await validateUnifiedInspectionTemplate(
      inspection.template_code,
      inspection.stage_id,
      items,
      connection
    );
    if (validation.error) {
      await connection.rollback();
      return error(res, validation.error);
    }
    await connection.query('DELETE FROM project_inspection_items WHERE inspection_id = ?', [
      inspectionId,
    ]);
    await insertUnifiedInspectionItems(connection, inspectionId, projectId, items);
    await connection.query(
      `UPDATE project_inspections
       SET status = ?, description = ?, algorithm_version = ?,
           calculation_summary = ?, calculated_at = ?, row_version = row_version + 1
       WHERE id = ?`,
      [
        status,
        String(req.body.description || '').trim().slice(0, 500),
        String(req.body.algorithm_version || '').trim().slice(0, 40) || null,
        req.body.calculation_summary ? JSON.stringify(req.body.calculation_summary) : null,
        req.body.calculated_at ? new Date(req.body.calculated_at) : null,
        inspectionId,
      ]
    );
    await connection.commit();
    return success(
      res,
      { id: inspectionId, row_version: baseVersion + 1, status },
      '现场记录已保存'
    );
  } catch (batchError) {
    await connection.rollback();
    throw batchError;
  } finally {
    connection.release();
  }
}

async function confirmProjectInspection(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;
  const projectId = Number(req.params.id);
  const inspectionId = Number(req.params.inspectionId);
  const baseVersion = Number(req.body.base_version);
  if (!Number.isInteger(baseVersion) || baseVersion < 1) return error(res, '缺少有效的数据版本');
  const memberRole = await getProjectMemberRole(projectId, req.user.id);
  const confirmsCompletion = isOwnerSideRole(memberRole);
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, task_id, progress_item_id, submitted_by,
              responsible_user_id, status, row_version
       FROM project_inspections
       WHERE id = ? AND project_id = ?
       LIMIT 1 FOR UPDATE`,
      [inspectionId, projectId]
    );
    const inspection = rows[0];
    if (!inspection) {
      await connection.rollback();
      return error(res, '现场记录不存在', 404);
    }
    if (
      Number(inspection.submitted_by) !== Number(req.user.id) &&
      Number(inspection.responsible_user_id) !== Number(req.user.id)
    ) {
      await connection.rollback();
      return error(res, '只有记录提交人或问题处理人可以确认完成', 403);
    }
    if (Number(inspection.row_version) !== baseVersion) {
      await connection.rollback();
      return error(res, '现场记录已更新，请刷新后重试', 409);
    }
    if (!['draft', 'in_progress'].includes(inspection.status)) {
      await connection.rollback();
      return error(res, '当前记录状态不能确认完成', 409);
    }
    const [[counts]] = await connection.query(
      `SELECT COUNT(*) AS total,
              SUM(result = 'pending') AS pending_total,
              SUM(result = 'failed') AS failed_total
       FROM project_inspection_items
       WHERE inspection_id = ?`,
      [inspectionId]
    );
    if (!Number(counts.total)) {
      await connection.rollback();
      return error(res, '现场记录没有检查项');
    }
    if (Number(counts.pending_total)) {
      await connection.rollback();
      return error(res, '仍有未查看项目，不能确认完成');
    }
    await connection.query(
      `UPDATE project_inspections
       SET status = ?, reviewed_by = ?,
           reviewed_at = CASE WHEN ? = 'passed' THEN NOW() ELSE reviewed_at END,
           row_version = row_version + 1
       WHERE id = ?`,
      [
        confirmsCompletion ? 'passed' : 'pending',
        confirmsCompletion ? req.user.id : null,
        confirmsCompletion ? 'passed' : 'pending',
        inspectionId,
      ]
    );
    if (confirmsCompletion && inspection.progress_item_id) {
      await connection.query(
        `UPDATE project_progress_items
         SET status = 'completed',
             actual_finish = COALESCE(actual_finish, CURDATE())
         WHERE id = ? AND project_id = ?`,
        [inspection.progress_item_id, projectId]
      );
    } else if (confirmsCompletion && inspection.task_id) {
      await connection.query(
        `UPDATE renovation_tasks
         SET status = 2,
             actual_end = COALESCE(actual_end, CURDATE())
         WHERE id = ? AND project_id = ?`,
        [inspection.task_id, projectId]
      );
    }
    await connection.commit();
    let progress = null;
    if (confirmsCompletion) {
      try {
        progress = await refreshProjectStageByTaskCompletion(projectId);
      } catch (progressError) {
        console.warn('refresh project stage after completion confirmation failed', {
          projectId,
          inspectionId,
          message: progressError.message,
        });
      }
    }
    return success(
      res,
      {
        id: inspectionId,
        status: confirmsCompletion ? 'passed' : 'pending',
        row_version: baseVersion + 1,
        issue_item_count: Number(counts.failed_total || 0),
        progress,
      },
      confirmsCompletion ? '事项已确认完成' : '完成记录已提交，等待业主确认'
    );
  } catch (confirmError) {
    await connection.rollback();
    throw confirmError;
  } finally {
    connection.release();
  }
}

async function createProjectInspection(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  let taskId = Number(req.body.task_id);
  const progressItemId = req.body.progress_item_id
    ? Number(req.body.progress_item_id)
    : null;
  const responsibleUserId = req.body.responsible_user_id
    ? Number(req.body.responsible_user_id)
    : null;
  const description = String(req.body.description || '').trim().slice(0, 500);
  const files = req.files || [];
  if (!(await canAccessProject(projectId, req.user.id))) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '项目不存在或无权限', 404);
  }
  if ((!taskId && !progressItemId) || !description) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '请选择任务并填写验收说明');
  }
  if (!files.length) return error(res, '请至少上传一张现场照片');
  if (files.length > PROJECT_UPLOAD_QUOTAS.inspectionImageLimit) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, `验收图片最多上传 ${PROJECT_UPLOAD_QUOTAS.inspectionImageLimit} 张`);
  }
  let responsibleMember = null;
  if (responsibleUserId) {
    responsibleMember = await requireActiveProjectMember(projectId, responsibleUserId);
    if (!responsibleMember) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '整改成员不是项目成员');
    }
  }
  let progressItem = null;
  if (progressItemId) {
    const [items] = await db.query(
      `SELECT id, task_id, stage_id FROM project_progress_items
       WHERE id = ? AND project_id = ?`,
      [progressItemId, projectId]
    );
    if (!items[0]) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '验收事项不存在', 404);
    }
    progressItem = items[0];
    taskId = Number(progressItem.task_id);
  }
  const [tasks] = await db.query(
    'SELECT id, stage_id FROM renovation_tasks WHERE id = ? AND project_id = ?',
    [taskId, projectId]
  );
  if (!tasks[0]) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '验收任务不存在', 404);
  }
  const [pending] = await db.query(
    `SELECT id FROM project_inspections
     WHERE ${progressItemId ? 'progress_item_id = ?' : 'task_id = ?'}
       AND status IN ('pending', 'rework')
     LIMIT 1`,
    [progressItemId || taskId]
  );
  if (pending[0]) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '该任务已有待处理验收', 409);
  }

  const memberRole =
    (await getProjectMemberRole(projectId, req.user.id)) || req.user.role || 'owner';
  const ownerSideSubmission = memberRole === 'owner';
  const initialStatus = ownerSideSubmission
    ? (responsibleUserId ? 'rework' : 'passed')
    : 'pending';
  const initialReviewRemark =
    ownerSideSubmission && responsibleUserId ? description : null;
  const hasMemberRole = await ensureProjectInspectionMemberRoleColumn();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      hasMemberRole
        ? `INSERT INTO project_inspections
           (project_id, task_id, progress_item_id, stage_id, submitted_by,
            member_role, responsible_user_id, status, description, review_remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        : `INSERT INTO project_inspections
           (project_id, task_id, progress_item_id, stage_id, submitted_by,
            responsible_user_id, status, description, review_remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      hasMemberRole
        ? [
            projectId,
            taskId,
            progressItemId,
            progressItem?.stage_id || tasks[0].stage_id,
            req.user.id,
            memberRole,
            responsibleUserId,
            initialStatus,
            description,
            initialReviewRemark,
          ]
        : [
            projectId,
            taskId,
            progressItemId,
            progressItem?.stage_id || tasks[0].stage_id,
            req.user.id,
            responsibleUserId,
            initialStatus,
            description,
            initialReviewRemark,
          ]
    );
    const host = `${req.protocol}://${req.get('host')}`;
    await connection.query(
      `INSERT INTO project_inspection_images
       (inspection_id, image_url, submission_round, uploaded_by)
       VALUES ${files.map(() => '(?, ?, 1, ?)').join(', ')}`,
      files.flatMap((file) => [
        result.insertId,
        file.storageUrl || `${host}/uploads/inspections/${file.filename}`,
        req.user.id,
      ])
    );
    if (initialStatus === 'passed') {
      if (progressItemId) {
        await connection.query(
          `UPDATE project_progress_items
           SET status = 'completed',
               actual_finish = COALESCE(actual_finish, CURDATE())
           WHERE id = ? AND project_id = ?`,
          [progressItemId, projectId]
        );
      } else {
        await connection.query(
          `UPDATE renovation_tasks
           SET status = 2,
               actual_end = COALESCE(actual_end, CURDATE())
           WHERE id = ? AND project_id = ?`,
          [taskId, projectId]
        );
      }
    }
    await connection.commit();
    let progress = null;
    if (initialStatus === 'passed') {
      try {
        progress = await refreshProjectStageByTaskCompletion(projectId);
      } catch (progressError) {
        console.warn('refresh project stage after owner inspection failed', {
          projectId,
          taskId,
          message: progressError.message,
        });
      }
    }
    return success(res, { id: result.insertId, progress }, '验收已提交');
  } catch (inspectionError) {
    await connection.rollback();
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    throw inspectionError;
  } finally {
    connection.release();
  }
}

async function reviewProjectInspection(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const inspectionId = Number(req.params.inspectionId);
  const result = String(req.body.result || '');
  const remark = String(req.body.remark || '').trim().slice(0, 500);
  const responsibleUserId = req.body.responsible_user_id
    ? Number(req.body.responsible_user_id)
    : null;
  if (!['passed', 'rework'].includes(result)) {
    return error(res, '验收结果不正确');
  }
  if (!(await isOwnerSide(projectId, req.user.id))) {
    return error(res, '只有业主方可以确认验收', 403);
  }
  if (result === 'rework' && !remark) return error(res, '请填写整改要求');
  if (result === 'rework' && !responsibleUserId) {
    return error(res, '请选择整改成员');
  }
  if (result === 'rework' && responsibleUserId) {
    const responsibleMember = await requireActiveProjectMember(
      projectId,
      responsibleUserId
    );
    if (!responsibleMember) return error(res, '整改成员不是项目成员');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT i.id, i.task_id, i.progress_item_id,
              COALESCE(i.title, progress_item.title, task.task_name, '阶段验收') AS task_name
       FROM project_inspections i
       LEFT JOIN renovation_tasks task ON task.id = i.task_id
       LEFT JOIN project_progress_items progress_item
              ON progress_item.id = i.progress_item_id
       WHERE i.id = ? AND i.project_id = ? AND i.status = 'pending'
       FOR UPDATE`,
      [inspectionId, projectId]
    );
    if (!rows[0]) {
      await connection.rollback();
      return error(res, '验收不存在或已处理', 404);
    }
    if (result === 'passed') {
      const [[itemCounts]] = await connection.query(
        `SELECT COUNT(*) AS total,
                SUM(result = 'pending') AS pending_total,
                SUM(result = 'failed') AS failed_total
         FROM project_inspection_items
         WHERE inspection_id = ?`,
        [inspectionId]
      );
      if (
        Number(itemCounts.total || 0) > 0 &&
        (Number(itemCounts.pending_total || 0) > 0 ||
          Number(itemCounts.failed_total || 0) > 0)
      ) {
        await connection.rollback();
        return error(res, '仍有未通过的检查项，不能确认验收通过', 409);
      }
    }
    await connection.query(
      `UPDATE project_inspections
       SET status = ?, review_remark = ?, reviewed_by = ?,
           responsible_user_id = CASE WHEN ? IS NULL THEN responsible_user_id ELSE ? END,
           reviewed_at = NOW()
       WHERE id = ?`,
      [
        result,
        remark || null,
        req.user.id,
        responsibleUserId || null,
        responsibleUserId || null,
        inspectionId,
      ]
    );
    if (result === 'passed') {
      if (rows[0].progress_item_id) {
        await connection.query(
          `UPDATE project_progress_items
           SET status = 'completed', actual_finish = COALESCE(actual_finish, CURDATE())
           WHERE id = ? AND project_id = ?`,
          [rows[0].progress_item_id, projectId]
        );
      } else {
        await connection.query(
          `UPDATE renovation_tasks
           SET status = 2, actual_end = COALESCE(actual_end, CURDATE())
           WHERE id = ?`,
          [rows[0].task_id]
        );
      }
    } else {
      if (rows[0].progress_item_id) {
        await connection.query(
          `UPDATE project_progress_items
           SET status = 'in_progress'
           WHERE id = ? AND project_id = ?`,
          [rows[0].progress_item_id, projectId]
        );
      } else {
        await connection.query(
          'UPDATE renovation_tasks SET status = 1 WHERE id = ?',
          [rows[0].task_id]
        );
      }
      const dueDate = localDateOnly(new Date());
      const [actionItem] = await connection.query(
        `INSERT INTO project_action_items
         (project_id, created_by, content, due_date, status)
         VALUES (?, ?, ?, ?, 'pending')`,
        [
          projectId,
          req.user.id,
          `整改：${rows[0].task_name}\n${remark}`,
          dueDate,
        ]
      );
      await connection.query(
        `INSERT INTO project_action_item_assignees (item_id, user_id)
         VALUES (?, ?)`,
        [actionItem.insertId, responsibleUserId]
      );
      await connection.query(
        `INSERT INTO project_action_notifications
         (item_id, recipient_id, event_type, delivery_status, payload)
         VALUES (?, ?, 'assigned', 'pending', ?)`,
        [
          actionItem.insertId,
          responsibleUserId,
          JSON.stringify({
            project_id: projectId,
            inspection_id: inspectionId,
            progress_item_id: rows[0].progress_item_id,
            source: 'inspection_rework',
          }),
        ]
      );
    }
    const projectEventTargetUserIds = uniqueUserIds(
      await getActiveProjectMemberUserIds(
        projectId,
        ['designer', 'project_manager', 'project_supervisor'],
        connection
      ),
      await getOwnerSideMemberUserIds(projectId, connection)
    );
    await emitProjectEvent(
      result === 'passed'
        ? ProjectEventType.INSPECTION_PASSED
        : ProjectEventType.INSPECTION_REWORK_REQUIRED,
      {
        projectId,
        actorId: req.user.id,
        targetUserIds: result === 'rework'
          ? projectEventTargetUserIds.filter(
            (userId) => Number(userId) !== Number(responsibleUserId)
          )
          : projectEventTargetUserIds,
        entityType: 'inspection',
        entityId: inspectionId,
        title: result === 'passed' ? '验收已通过' : '验收需要整改',
        content: rows[0].task_name || '验收事项',
        route: 'project_inspection',
        deepLink: {
          projectId,
          inspectionId,
          progressItemId: rows[0].progress_item_id,
        },
      },
      connection
    );
    await connection.commit();
    const progress = await refreshProjectStageByTaskCompletion(projectId);
    return success(
      res,
      { status: result, progress },
      result === 'passed' ? '验收已通过，任务已完成' : '已通知整改'
    );
  } catch (reviewError) {
    await connection.rollback();
    throw reviewError;
  } finally {
    connection.release();
  }
}

async function updateProjectInspectionDesignCheck(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const inspectionId = Number(req.params.inspectionId);
  const checkId = Number(req.params.checkId);
  const checkResult = String(req.body.check_result || '');
  if (!['conforms', 'issue', 'not_applicable', 'pending'].includes(checkResult)) {
    return error(res, '设计检查结果不正确');
  }
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!isOwnerSideRole(role) && !['project_manager', 'project_supervisor'].includes(role)) {
    return error(res, '只有业主、项目经理或监理可以记录验收检查结果', 403);
  }
  const [result] = await db.query(
    `UPDATE project_inspection_design_checks check_item
     JOIN project_inspections inspection ON inspection.id = check_item.inspection_id
     SET check_item.check_result = ?,
         check_item.checked_by = CASE WHEN ? = 'pending' THEN NULL ELSE ? END,
         check_item.checked_at = CASE WHEN ? = 'pending' THEN NULL ELSE NOW() END
     WHERE check_item.id = ?
       AND check_item.inspection_id = ?
       AND check_item.project_id = ?
       AND inspection.project_id = ?`,
    [
      checkResult,
      checkResult,
      req.user.id,
      checkResult,
      checkId,
      inspectionId,
      projectId,
      projectId,
    ]
  );
  if (result.affectedRows === 0) return error(res, '设计检查项不存在', 404);
  return success(res, null, '设计检查结果已记录');
}

async function getProjectInspectionStepRecords(req, res) {
  const projectId = Number(req.params.id);
  const stageId = req.query.stage_id ? Number(req.query.stage_id) : null;
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const params = [projectId];
  const filters = ['record.project_id = ?'];
  if (req.query.include_migrated !== '1' && req.query.include_migrated !== 'true') {
    filters.push('record.inspection_id IS NULL');
  }
  const requesterRole = await getProjectMemberRole(projectId, req.user.id);
  const requesterCompanyAdminReadOnly = requesterRole === companyAdminViewerRole;
  if (!isOwnerSideRole(requesterRole) && !requesterCompanyAdminReadOnly) {
    filters.push(
      '(record.created_by = ? OR record.target_user_id = ? OR record.response_by = ?)'
    );
    params.push(req.user.id, req.user.id, req.user.id);
  }
  if (stageId) {
    filters.push('record.stage_id = ?');
    params.push(stageId);
  }
  const [rows] = await db.query(
    `SELECT record.id, record.project_id, record.stage_id,
            record.task_id, record.progress_item_id,
            record.step_key, record.step_title,
            record.step_action, record.record_type, record.status,
            record.description, record.review_remark,
            record.response_description, record.response_by, record.response_at,
            record.created_by, record.member_role,
            record.target_user_id, record.reviewed_by, record.reviewed_at,
            record.created_at, record.updated_at,
            creator.nickname AS creator_name,
            target.nickname AS target_name,
            (SELECT pm.role
             FROM project_members pm
             WHERE pm.project_id = record.project_id
               AND pm.user_id = record.target_user_id
               AND pm.status = 1
             ORDER BY FIELD(pm.role, 'owner', 'owner_member',
                            'project_manager', 'project_supervisor',
                            'designer', 'merchant'), pm.id
             LIMIT 1) AS target_role,
            reviewer.nickname AS reviewer_name,
            responder.nickname AS responder_name
     FROM project_inspection_step_records record
     JOIN users creator ON creator.id = record.created_by
     LEFT JOIN users target ON target.id = record.target_user_id
     LEFT JOIN users reviewer ON reviewer.id = record.reviewed_by
     LEFT JOIN users responder ON responder.id = record.response_by
     WHERE ${filters.join(' AND ')}
     ORDER BY record.updated_at DESC, record.id DESC`,
    params
  );
  if (!rows.length) return success(res, []);
  const recordIds = rows.map((item) => item.id);
  const [images] = await db.query(
    `SELECT id, record_id, image_url, uploaded_by, created_at
     FROM project_inspection_step_record_images
     WHERE record_id IN (${recordIds.map(() => '?').join(', ')})
     ORDER BY id`,
    recordIds
  );
  const imageMap = new Map();
  for (const image of images) {
    if (!imageMap.has(image.record_id)) imageMap.set(image.record_id, []);
    imageMap.get(image.record_id).push(image);
  }
  return success(
    res,
    rows.map((item) => ({
      ...item,
      images: imageMap.get(item.id) || [],
    }))
  );
}

async function createProjectInspectionStepRecord(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const stageId = Number(req.body.stage_id);
  let taskId = req.body.task_id ? Number(req.body.task_id) : null;
  const progressItemId = req.body.progress_item_id
    ? Number(req.body.progress_item_id)
    : null;
  const stepKey = String(req.body.step_key || '').trim().slice(0, 160);
  const stepTitle = String(req.body.step_title || '').trim().slice(0, 160);
  const stepAction = String(req.body.step_action || '').trim().slice(0, 500) || null;
  const description = String(req.body.description || '').trim().slice(0, 500) || null;
  const targetUserId = req.body.target_user_id ? Number(req.body.target_user_id) : null;
  const requestedType = String(req.body.record_type || '').trim();
  const files = req.files || [];

  if (!(await canAccessProject(projectId, req.user.id))) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '项目不存在或无权限', 404);
  }
  if (!stageId || !stepKey || !stepTitle) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '记录事项信息不完整');
  }
  if (taskId) {
    const [tasks] = await db.query(
      'SELECT id, stage_id FROM renovation_tasks WHERE id = ? AND project_id = ?',
      [taskId, projectId]
    );
    if (!tasks[0]) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '事项不存在', 404);
    }
    if (Number(tasks[0].stage_id) !== stageId) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '事项与当前阶段不匹配');
    }
  }
  if (progressItemId) {
    const [items] = await db.query(
      'SELECT id, task_id, stage_id FROM project_progress_items WHERE id = ? AND project_id = ?',
      [progressItemId, projectId]
    );
    if (!items[0]) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '进度事项不存在', 404);
    }
    if (Number(items[0].stage_id) !== stageId) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '子事项与当前阶段不匹配');
    }
    const linkedTaskId = items[0].task_id ? Number(items[0].task_id) : null;
    if (taskId && linkedTaskId && taskId !== linkedTaskId) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '事项与子事项关联不匹配');
    }
    taskId = taskId || linkedTaskId;
  }
  if (targetUserId) {
    const targetMember = await requireActiveProjectMember(projectId, targetUserId);
    if (!targetMember) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '指定成员不是项目成员');
    }
  }

  const memberRole =
    (await getProjectMemberRole(projectId, req.user.id)) || req.user.role || 'owner';
  const ownerSide = isOwnerSideRole(memberRole);
  const isReworkRequest = requestedType === 'rework_request';
  const isMemberCheckRequest = requestedType === 'member_requested';
  const isMemberCheckResponse = requestedType === 'member_checked' && !ownerSide;
  if (isReworkRequest && !ownerSide) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '只有业主方可以发起整改', 403);
  }
  if (isReworkRequest && (!targetUserId || !description)) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '请填写整改说明并选择整改成员');
  }
  const recordType = requestedType || (ownerSide ? 'self_checked' : 'member_checked');
  const status = isReworkRequest
    ? 'rework'
    : ownerSide
    ? (targetUserId ? 'pending_member_check' : 'recorded')
    : 'pending_owner_view';
  if (!ownerSide && !description) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '请填写核对说明');
  }
  if (files.length > PROJECT_UPLOAD_QUOTAS.inspectionImageLimit) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, `现场照片最多上传 ${PROJECT_UPLOAD_QUOTAS.inspectionImageLimit} 张`);
  }

  let existingRows = [];
  if (isMemberCheckResponse) {
    [existingRows] = await db.query(
      `SELECT id FROM project_inspection_step_records
       WHERE project_id = ?
         AND stage_id = ?
         AND ((task_id IS NULL AND ? IS NULL) OR task_id = ?)
         AND ((progress_item_id IS NULL AND ? IS NULL) OR progress_item_id = ?)
         AND step_key = ?
         AND target_user_id = ?
         AND status = 'pending_member_check'
       ORDER BY id DESC
       LIMIT 1`,
      [
        projectId,
        stageId,
        taskId,
        taskId,
        progressItemId,
        progressItemId,
        stepKey,
        req.user.id,
      ]
    );
  } else if (isReworkRequest || isMemberCheckRequest) {
    [existingRows] = await db.query(
      `SELECT id FROM project_inspection_step_records
       WHERE project_id = ?
         AND stage_id = ?
         AND ((task_id IS NULL AND ? IS NULL) OR task_id = ?)
         AND ((progress_item_id IS NULL AND ? IS NULL) OR progress_item_id = ?)
         AND step_key = ?
         AND created_by = ?
         AND target_user_id = ?
         AND status = ?
       ORDER BY id DESC
       LIMIT 1`,
      [
        projectId,
        stageId,
        taskId,
        taskId,
        progressItemId,
        progressItemId,
        stepKey,
        req.user.id,
        targetUserId,
        isReworkRequest ? 'rework' : 'pending_member_check',
      ]
    );
  }

  if (existingRows[0]) {
    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();
      if (isMemberCheckResponse) {
        await connection.query(
          `UPDATE project_inspection_step_records
           SET record_type = 'member_check_response',
               status = 'pending_owner_view',
               response_description = ?, response_by = ?, response_at = NOW()
           WHERE id = ?`,
          [description, req.user.id, existingRows[0].id]
        );
      } else {
        await connection.query(
          `UPDATE project_inspection_step_records
           SET step_title = ?, step_action = ?, record_type = ?, status = ?,
               description = ?, review_remark = ?, reviewed_by = ?,
               reviewed_at = CASE WHEN ? THEN NOW() ELSE reviewed_at END,
               response_description = NULL, response_by = NULL, response_at = NULL,
               member_role = ?, target_user_id = ?
           WHERE id = ?`,
          [
            stepTitle,
            stepAction,
            recordType,
            status,
            description,
            isReworkRequest ? description : null,
            isReworkRequest ? req.user.id : null,
            isReworkRequest ? 1 : 0,
            memberRole,
            targetUserId,
            existingRows[0].id,
          ]
        );
      }
      if (files.length) {
        const host = `${req.protocol}://${req.get('host')}`;
        await connection.query(
          `INSERT INTO project_inspection_step_record_images
           (record_id, image_url, uploaded_by)
           VALUES ${files.map(() => '(?, ?, ?)').join(', ')}`,
          files.flatMap((file) => [
            existingRows[0].id,
            file.storageUrl || `${host}/uploads/inspections/${file.filename}`,
            req.user.id,
          ])
        );
      }
      await connection.commit();
    } catch (updateError) {
      await connection.rollback();
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      throw updateError;
    } finally {
      connection.release();
    }
    if (isReworkRequest) {
      await emitProjectEvent(ProjectEventType.INSPECTION_REWORK_REQUIRED, {
        projectId,
        actorId: req.user.id,
        targetUserIds: [targetUserId],
        entityType: 'inspection_step',
        entityId: existingRows[0].id,
        title: '现场记录需要整改',
        content: description || stepTitle,
        route: 'project_inspection',
        deepLink: { projectId, stepRecordId: existingRows[0].id },
      });
    }
    if (targetUserId && status === 'pending_member_check') {
      await emitProjectEvent(ProjectEventType.INSPECTION_STEP_CHECK_REQUESTED, {
        projectId,
        actorId: req.user.id,
        targetUserIds: [targetUserId],
        entityType: 'inspection_step',
        entityId: existingRows[0].id,
        title: '请核对现场事项',
        content: description || stepTitle,
        route: 'project_inspection',
        deepLink: { projectId, stepKey, stepTitle },
      });
    }
    if (!ownerSide && status === 'pending_owner_view') {
      const ownerIds = await getOwnerSideMemberUserIds(projectId);
      await emitProjectEvent(ProjectEventType.INSPECTION_STEP_SUBMITTED, {
        projectId,
        actorId: req.user.id,
        targetUserIds: ownerIds,
        entityType: 'inspection_step',
        entityId: existingRows[0].id,
        title: '成员已提交核对记录',
        content: stepTitle,
        route: 'project_inspection',
        deepLink: { projectId, stepKey, stepTitle },
      });
    }
    return success(res, { id: existingRows[0].id, status }, '记录已更新');
  }

  const connection = await db.getConnection();
  let recordId;
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_inspection_step_records
         (project_id, stage_id, task_id, progress_item_id, step_key, step_title,
          step_action, record_type, status, description, review_remark,
          created_by, member_role, target_user_id, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${
         isReworkRequest ? 'NOW()' : 'NULL'
       })`,
      [
        projectId,
        stageId,
        taskId,
        progressItemId,
        stepKey,
        stepTitle,
        stepAction,
        recordType,
        status,
        description,
        isReworkRequest ? description : null,
        req.user.id,
        memberRole,
        targetUserId,
        isReworkRequest ? req.user.id : null,
      ]
    );
    recordId = result.insertId;
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_inspection_step_record_images
         (record_id, image_url, uploaded_by)
         VALUES ${files.map(() => '(?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          recordId,
          file.storageUrl || `${host}/uploads/inspections/${file.filename}`,
          req.user.id,
        ])
      );
    }
    await connection.commit();
  } catch (insertError) {
    await connection.rollback();
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    throw insertError;
  } finally {
    connection.release();
  }
  if (isReworkRequest) {
    await emitProjectEvent(ProjectEventType.INSPECTION_REWORK_REQUIRED, {
      projectId,
      actorId: req.user.id,
      targetUserIds: [targetUserId],
      entityType: 'inspection_step',
      entityId: recordId,
      title: '现场记录需要整改',
      content: description || stepTitle,
      route: 'project_inspection',
      deepLink: { projectId, stepRecordId: recordId },
    });
  }
  if (targetUserId && status === 'pending_member_check') {
    await emitProjectEvent(ProjectEventType.INSPECTION_STEP_CHECK_REQUESTED, {
      projectId,
      actorId: req.user.id,
      targetUserIds: [targetUserId],
      entityType: 'inspection_step',
      entityId: recordId,
      title: '请核对现场事项',
      content: description || stepTitle,
      route: 'project_inspection',
      deepLink: { projectId, stepKey, stepTitle },
    });
  }
  if (!ownerSide && status === 'pending_owner_view') {
    const ownerIds = await getOwnerSideMemberUserIds(projectId);
    await emitProjectEvent(ProjectEventType.INSPECTION_STEP_SUBMITTED, {
      projectId,
      actorId: req.user.id,
      targetUserIds: ownerIds,
      entityType: 'inspection_step',
      entityId: recordId,
      title: '成员已提交核对记录',
      content: stepTitle,
      route: 'project_inspection',
      deepLink: { projectId, stepKey, stepTitle },
    });
  }
  return success(res, { id: recordId, status }, '记录已保存');
}

async function reviewProjectInspectionStepRecord(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const recordId = Number(req.params.recordId);
  const result = String(req.body.result || '').trim();
  const remark = String(req.body.remark || '').trim().slice(0, 500);
  const responsibleUserId = req.body.responsible_user_id
    ? Number(req.body.responsible_user_id)
    : null;
  if (!['recorded', 'rework'].includes(result)) {
    return error(res, '处理结果不正确');
  }
  if (!(await isOwnerSide(projectId, req.user.id))) {
    return error(res, '只有业主方可以处理成员提交的记录', 403);
  }
  if (result === 'rework' && !remark) return error(res, '请填写整改要求');
  if (result === 'rework' && !responsibleUserId) {
    return error(res, '请选择整改成员');
  }
  if (responsibleUserId) {
    const responsibleMember = await requireActiveProjectMember(
      projectId,
      responsibleUserId
    );
    if (!responsibleMember) return error(res, '整改成员不是项目成员');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, step_title
       FROM project_inspection_step_records
       WHERE id = ? AND project_id = ? AND status = 'pending_owner_view'
       FOR UPDATE`,
      [recordId, projectId]
    );
    if (!rows[0]) {
      await connection.rollback();
      return error(res, '记录不存在或已处理', 404);
    }
    await connection.query(
      `UPDATE project_inspection_step_records
       SET status = ?, review_remark = ?, reviewed_by = ?, reviewed_at = NOW(),
           target_user_id = CASE WHEN ? IS NULL THEN target_user_id ELSE ? END
       WHERE id = ?`,
      [
        result,
        remark || null,
        req.user.id,
        responsibleUserId || null,
        responsibleUserId || null,
        recordId,
      ]
    );
    if (result === 'rework') {
      await emitProjectEvent(ProjectEventType.INSPECTION_REWORK_REQUIRED, {
        projectId,
        actorId: req.user.id,
        targetUserIds: [responsibleUserId],
        entityType: 'inspection_step',
        entityId: recordId,
        title: '现场记录需要整改',
        content: rows[0].step_title,
        route: 'project_inspection',
        deepLink: { projectId, stepRecordId: recordId },
      }, connection);
    }
    await connection.commit();
    return success(
      res,
      { id: recordId, status: result },
      result === 'recorded' ? '已确认归档' : '已通知继续整改'
    );
  } catch (reviewError) {
    await connection.rollback();
    throw reviewError;
  } finally {
    connection.release();
  }
}

async function submitProjectInspectionStepRework(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const recordId = Number(req.params.recordId);
  const description = String(req.body.description || '').trim().slice(0, 500);
  const files = req.files || [];

  if (!description) return error(res, '请填写整改处理说明');
  if (!(await canAccessProject(projectId, req.user.id))) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '项目不存在或无权限', 404);
  }
  if (files.length > PROJECT_UPLOAD_QUOTAS.inspectionImageLimit) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, `整改图片最多上传 ${PROJECT_UPLOAD_QUOTAS.inspectionImageLimit} 张`);
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, step_title, target_user_id
       FROM project_inspection_step_records
       WHERE id = ? AND project_id = ? AND status = 'rework'
       FOR UPDATE`,
      [recordId, projectId]
    );
    if (!rows[0]) {
      await connection.rollback();
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '整改记录不存在或已处理', 404);
    }
    if (Number(rows[0].target_user_id) !== Number(req.user.id)) {
      await connection.rollback();
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '只有整改成员可以提交处理记录', 403);
    }
    await connection.query(
      `UPDATE project_inspection_step_records
       SET status = 'pending_owner_view',
           record_type = 'rework_response',
           response_description = ?,
           response_by = ?,
           response_at = NOW()
       WHERE id = ?`,
      [description, req.user.id, recordId]
    );
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_inspection_step_record_images
         (record_id, image_url, uploaded_by)
         VALUES ${files.map(() => '(?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          recordId,
          file.storageUrl || `${host}/uploads/inspections/${file.filename}`,
          req.user.id,
        ])
      );
    }
    const ownerIds = await getOwnerSideMemberUserIds(projectId);
    await emitProjectEvent(ProjectEventType.INSPECTION_STEP_REWORK_SUBMITTED, {
      projectId,
      actorId: req.user.id,
      targetUserIds: ownerIds,
      entityType: 'inspection_step',
      entityId: recordId,
      title: '整改处理记录已提交',
      content: rows[0].step_title,
      route: 'project_inspection',
      deepLink: { projectId, stepRecordId: recordId },
    }, connection);
    await connection.commit();
    return success(res, { id: recordId, status: 'pending_owner_view' }, '整改记录已提交');
  } catch (submitError) {
    await connection.rollback();
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    throw submitError;
  } finally {
    connection.release();
  }
}

async function resubmitProjectInspection(req, res) {
  const projectContext = await requireProjectContext(req, res);
  if (!projectContext.ok) return projectContext.response;

  const projectId = Number(req.params.id);
  const inspectionId = Number(req.params.inspectionId);
  const description = String(req.body.description || '').trim().slice(0, 500);
  const files = req.files || [];
  if (!(await canAccessProject(projectId, req.user.id))) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '项目不存在或无权限', 404);
  }
  if (!description || !files.length) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, '请填写整改说明并上传整改照片');
  }
  if (files.length > PROJECT_UPLOAD_QUOTAS.inspectionImageLimit) {
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    return error(res, `整改验收图片最多上传 ${PROJECT_UPLOAD_QUOTAS.inspectionImageLimit} 张`);
  }
  const hasMemberRole = await ensureProjectInspectionMemberRoleColumn();
  const legacyAssignedReworkFilter = hasMemberRole
    ? `OR (status = 'pending'
           AND member_role IN ('owner', 'owner_member')
           AND responsible_user_id = ?
           AND submission_round = 1)`
    : `OR (status = 'pending'
           AND responsible_user_id = ?
           AND submission_round = 1)`;
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, submission_round FROM project_inspections
       WHERE id = ? AND project_id = ?
         AND (status = 'rework' ${legacyAssignedReworkFilter})
       FOR UPDATE`,
      [inspectionId, projectId, req.user.id]
    );
    if (!rows[0]) {
      await connection.rollback();
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '整改验收不存在或已提交', 404);
    }
    const round = Number(rows[0].submission_round) + 1;
    await connection.query(
      `UPDATE project_inspections
       SET status = 'pending', description = ?, submission_round = ?,
           reviewed_by = NULL, reviewed_at = NULL
       WHERE id = ?`,
      [description, round, inspectionId]
    );
    const host = `${req.protocol}://${req.get('host')}`;
    await connection.query(
      `INSERT INTO project_inspection_images
       (inspection_id, image_url, submission_round, uploaded_by)
       VALUES ${files.map(() => '(?, ?, ?, ?)').join(', ')}`,
      files.flatMap((file) => [
        inspectionId,
        file.storageUrl || `${host}/uploads/inspections/${file.filename}`,
        round,
        req.user.id,
      ])
    );
    await connection.commit();
    return success(res, { submission_round: round }, '整改验收已重新提交');
  } catch (resubmitError) {
    await connection.rollback();
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    throw resubmitError;
  } finally {
    connection.release();
  }
}

// GET /api/renovation/stages/:id/tasks - 获取某阶段下的任务
async function getStageTasks(req, res) {
  const project = await findProject(req.user.id);
  if (!project) return error(res, '装修档案不存在', 404);
  const stageId = Number(req.params.id);

  const [tasks] = await db.query(
    `SELECT id, stage_id, task_name, is_key, planned_start, planned_end,
            actual_start, actual_end, status, remark
     FROM renovation_tasks
     WHERE project_id = ? AND stage_id = ?
     ORDER BY planned_start, id`,
    [project.id, stageId]
  );
  return success(res, { tasks });
}

// GET /api/renovation/checklist - 装修检查清单
async function getChecklist(req, res) {
  const project = await findProject(req.user.id);
  if (!project) return error(res, '装修档案不存在', 404);

  const stageId = req.query.stage_id ? Number(req.query.stage_id) : null;
  const where = stageId ? 'project_id = ? AND stage_id = ?' : 'project_id = ?';
  const params = stageId ? [project.id, stageId] : [project.id];

  const [tasks] = await db.query(
    `SELECT id, stage_id, task_name, is_key, status, remark,
            planned_start, planned_end, actual_start, actual_end
     FROM renovation_tasks
     WHERE ${where}
     ORDER BY stage_id, planned_start, id`,
    params
  );

  // 按阶段分组
  const grouped = {};
  for (const stage of stages) {
    grouped[stage.id] = {
      stage_id: stage.id,
      stage_name: stage.name,
      stage_emoji: stage.emoji,
      tasks: [],
    };
  }
  for (const task of tasks) {
    if (grouped[task.stage_id]) {
      grouped[task.stage_id].tasks.push(task);
    }
  }

  return success(res, {
    project_id: project.id,
    current_stage: project.current_stage,
    stages: Object.values(grouped).filter(s => s.tasks.length > 0 || !stageId),
  });
}

module.exports = {
  getStages,
  setup,
  uploadFloorPlan,
  getCalendar,
  getStageDetail,
  updateTask,
  completeStage,
  updateInfo,
  updateProjectInfo,
  getProjectShowcase,
  updateProjectShowcase,
  publishProjectShowcase,
  hideProjectShowcase,
  getProjectShowcaseImageCandidates,
  getPublishedProjectShowcase,
  getProjectInfoChangeRequests,
  createProjectInfoChangeRequest,
  handleProjectInfoChangeRequest,
  resetProject,
  archiveProject,
  restoreProject,
  deleteProject,
  requireProjectActiveRoute,
  listUsers,
  requestDesigner,
  getReceivedRequests,
  handleRequest,
  getDesigners,
  bindDesigner,
  unbindDesigner,
  getMyProjects,
  getProjectMembers,
  getProjectSpaces,
  createProjectSpace,
  updateProjectSpace,
  deleteProjectSpace,
  uploadProjectSpaceImages,
  setDefaultProjectSpaceImage,
  deleteProjectSpaceImage,
  getProjectSpaceChangeRequests,
  handleProjectSpaceChangeRequest,
  getProjectCaseShares,
  createProjectCaseShare,
  handleProjectCaseShare,
  removeProjectMember,
  getProjectOwnerSideMembers,
  inviteProjectOwnerMember,
  removeProjectOwnerMember,
  getMemberCandidates,
  requestProjectMember,
  getSentMemberRequests,
  cancelMemberRequest,
  getReceivedMemberRequests,
  handleMemberRequest,
  searchProjectOwners,
  inviteProjectOwner,
  getProjectInvitations,
  handleProjectInvitation,
  planTask,
  addTask,
  getTips,
  // App 兼容
  getProjects,
  getAccessibleProjects,
  getProjectDetail,
  getProjectTasks,
  getProjectCheckIns,
  createProjectCheckIn,
  updateProjectCheckInShares,
  getReceivedProjectCheckInShare,
  createProjectCheckInWechatShare,
  getProjectCheckInWechatShare,
  shareProjectCheckInToCircle,
  deleteProjectCheckIn,
  getProjectExpenses,
  createProjectExpense,
  updateProjectExpense,
  deleteProjectExpense,
  getProjectDesignDocuments,
  uploadProjectDesignDocument,
  createProjectDesignDocument,
  canDeleteDesignDocument,
  updateProjectDesignDocument,
  updateProjectDesignDocumentStatus,
  getProjectHandovers,
  getProjectDesignHandoverItems,
  createProjectHandover,
  createProjectHandoverNote,
  updateProjectHandoverStatus,
  getProjectMaterials,
  createProjectMaterial,
  createProjectMaterialNote,
  createProjectMaterialSupplement,
  confirmProjectMaterial,
  getProjectTodos,
  createProjectActionItem,
  submitProjectActionItemFeedback,
  getProjectProgress,
  getProgressProposal,
  submitProgressProposal,
  reviewProgressProposal,
  updateProjectPace,
  planProjectTask,
  createProjectTask,
  deleteProjectTask,
  completeProjectStage,
  getProjectProgressChangeRequests,
  reviewProjectProgressChangeRequest,
  cancelProjectProgressChangeRequest,
  getProjectProgressItems,
  getProjectProgressItemAdjustments,
  createProjectProgressItem,
  updateProjectProgressItem,
  deleteProjectProgressItem,
  getProjectInspections,
  getProjectInspectionWorkspace,
  createProjectInspectionDraft,
  updateProjectInspectionBatch,
  confirmProjectInspection,
  getProjectWorkItemTemplates,
  updateProjectWorkItemTemplateStatus,
  getProjectInspectionTemplates,
  getProjectInspectionTemplateDetail,
  createProjectInspection,
  reviewProjectInspection,
  updateProjectInspectionDesignCheck,
  getProjectInspectionStepRecords,
  createProjectInspectionStepRecord,
  reviewProjectInspectionStepRecord,
  submitProjectInspectionStepRework,
  resubmitProjectInspection,
  getStageTasks,
  getChecklist,
};
