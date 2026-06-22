const db = require('../config/db');
const { success, error } = require('../utils/response');
const fs = require('fs/promises');
const path = require('path');

const stages = [
  { id: 1, name: '梦想落地期', traditional: '设计准备', emoji: '📐', days: 14, taskCount: 3, keyTaskCount: 1 },
  { id: 2, name: '破旧立新区', traditional: '主体拆改', emoji: '🔨', days: 5, taskCount: 2, keyTaskCount: 1 },
  { id: 3, name: '隐蔽保卫战', traditional: '水电改造', emoji: '⚡', days: 10, taskCount: 3, keyTaskCount: 1 },
  { id: 4, name: '防漏攻坚战', traditional: '泥瓦防水', emoji: '🧱', days: 14, taskCount: 3, keyTaskCount: 1 },
  { id: 5, name: '面子工程局', traditional: '木工施工', emoji: '🪵', days: 10, taskCount: 2, keyTaskCount: 1 },
  { id: 6, name: '美颜焕新颜', traditional: '油漆施工', emoji: '🎨', days: 12, taskCount: 3, keyTaskCount: 1 },
  { id: 7, name: '大件进场战', traditional: '安装阶段', emoji: '🏠', days: 10, taskCount: 3, keyTaskCount: 1 },
  { id: 8, name: '通关大吉日', traditional: '竣工验收', emoji: '🎉', days: 7, taskCount: 2, keyTaskCount: 1 },
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
  designer: { manage_tasks: true, view_project: true },
  project_manager: { manage_tasks: true, view_project: true },
  project_supervisor: { manage_tasks: true, view_project: true },
  merchant: { view_project: true },
};

const defaultProjectSpaces = ['客厅', '主卧', '次卧', '厨房', '卫生间', '阳台'];
const defaultProjectName = '装修项目';
const legacyInvalidProjectNames = new Set([
  'è£…ä¿®é¡¹ç›®',
]);
const ownerSearchAttempts = new Map();
const ownerInviteAttempts = new Map();

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
  return Boolean(rows[0]);
}

async function getProjectMemberRole(projectId, userId) {
  const [rows] = await db.query(
    `SELECT role FROM project_members
     WHERE project_id = ? AND user_id = ? AND status = 1
     LIMIT 1`,
    [projectId, userId]
  );
  return rows[0]?.role || null;
}

async function ensureDefaultProjectSpaces(projectId, userId) {
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
  if (projectType && !['refined', 'rough', 'office', 'commercial'].includes(projectType)) {
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
  if (!req.file) return error(res, '请选择户型图片');
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/floor-plans/${req.file.filename}`;
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
  const { status, remark } = req.body;
  const updates = [];
  const params = [];
  if (status !== undefined) {
    updates.push('t.status = ?');
    params.push(Number(status));
    if (Number(status) === 1) updates.push('t.actual_start = COALESCE(t.actual_start, CURDATE())');
    if (Number(status) === 2) updates.push('t.actual_end = CURDATE()');
  }
  if (remark !== undefined) {
    updates.push('t.remark = ?');
    params.push(String(remark));
  }
  if (updates.length === 0) return error(res, '没有可更新的内容');
  params.push(Number(req.params.taskId), req.user.id);
  const [result] = await db.query(
    `UPDATE renovation_tasks t
     JOIN renovation_projects p ON t.project_id = p.id
     SET ${updates.join(', ')}
     WHERE t.id = ?
       AND EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id
           AND pm.user_id = ?
           AND pm.status = 1
           AND (
             pm.role IN ('owner', 'designer', 'project_manager', 'project_supervisor')
             OR JSON_UNQUOTE(
               JSON_EXTRACT(pm.permissions, '$.manage_tasks')
             ) = 'true'
           )
       )`,
    params
  );
  if (result.affectedRows === 0) return error(res, '任务不存在', 404);
  const [tasks] = await db.query(
    'SELECT project_id FROM renovation_tasks WHERE id = ?',
    [Number(req.params.taskId)]
  );
  if (tasks[0]) await refreshProjectStageByTaskCompletion(tasks[0].project_id);
  return success(res, { updated: true });
}

async function completeStage(req, res) {
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

async function getProjectInfoChangeRequests(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  if (role !== 'designer') {
    return error(res, '只有项目设计师可以提交设计师案例分享申请', 403);
  }
  const params = [projectId];
  let visibilitySql = '';
  if (role !== 'owner') {
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
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  if (role === 'owner') return error(res, '业主可以直接修改项目档案');
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
  await db.query('DELETE FROM renovation_projects WHERE user_id = ?', [req.user.id]);
  return success(res, null, '装修档案已删除');
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
    'SELECT id, designer_id FROM renovation_projects WHERE id = ? AND user_id = ?',
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
         WHERE id = ? AND user_id = ? AND designer_id IS NULL`,
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
  return success(res, rows);
}

async function bindDesigner(req, res) {
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
       WHERE p.user_id = ? AND pm.role = 'designer' AND pm.status = 1`,
      [req.user.id]
    );
    await connection.query(
      'UPDATE renovation_projects SET designer_id = NULL WHERE user_id = ?',
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
    `SELECT p.id, p.project_code, p.house_area, p.start_date, p.total_days,
            p.current_stage, p.status, u.nickname AS owner_nickname, u.phone AS owner_phone,
            u.city AS owner_city, pm.role AS member_role
     FROM project_members pm
     JOIN renovation_projects p ON p.id = pm.project_id
     JOIN users u ON p.user_id = u.id
     WHERE pm.user_id = ? AND pm.role = ? AND pm.status = 1
     ORDER BY p.updated_at DESC`,
    [req.user.id, memberRole]
  );
  return success(res, rows);
}

async function getProjectMembers(req, res) {
  const projectId = Number(req.params.id);
  const [access] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND status = 1`,
    [projectId, req.user.id]
  );
  if (!access[0]) return error(res, '项目不存在或无权限', 404);

  const [rows] = await db.query(
    `SELECT pm.id, pm.project_id, pm.user_id, pm.role, pm.status,
            pm.permissions, pm.joined_at,
            u.nickname, u.phone, u.avatar, u.city
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ? AND pm.status = 1
     ORDER BY FIELD(pm.role, 'owner', 'project_manager', 'project_supervisor', 'designer', 'merchant'),
              pm.joined_at`,
    [projectId]
  );
  return success(res, rows);
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
  return success(res, await applyCreateProjectSpace(projectId, req.user.id, name));
}

async function applyCreateProjectSpace(projectId, userId, name, connection = db) {
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

async function deleteProjectSpace(req, res) {
  const projectId = Number(req.params.id);
  const spaceId = Number(req.params.spaceId);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
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
  const [spaces] = await db.query(
    `SELECT id, is_default FROM project_spaces
     WHERE id = ? AND project_id = ?`,
    [spaceId, projectId]
  );
  if (!spaces[0]) return error(res, '空间不存在', 404);
  if (spaces[0].is_default) return error(res, '默认空间不能删除');
  const [images] = await db.query(
    'SELECT id FROM project_space_images WHERE space_id = ? LIMIT 1',
    [spaceId]
  );
  if (images[0]) return error(res, '请先删除该空间内的图片');
  await connection.query('DELETE FROM project_spaces WHERE id = ?', [spaceId]);
  return success(res, null, '空间已删除');
}

async function uploadProjectSpaceImages(req, res) {
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

  const host = `${req.protocol}://${req.get('host')}`;
  const imageUrls = req.files.map(
    (file) => `${host}/uploads/project-spaces/${file.filename}`
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

async function applyUploadProjectSpaceImages(
  projectId,
  spaceId,
  imageType,
  imageUrls,
  userId,
  connection = db
) {
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
        `SELECT id, is_default FROM project_spaces
         WHERE id = ? AND project_id = ?`,
        [spaceId, projectId]
      );
      if (!spaces[0]) throw new Error('空间不存在');
      if (spaces[0].is_default) throw new Error('默认空间不能删除');
      const [images] = await connection.query(
        'SELECT id FROM project_space_images WHERE space_id = ? LIMIT 1',
        [spaceId]
      );
      if (images[0]) throw new Error('请先删除该空间内的图片');
      await connection.query('DELETE FROM project_spaces WHERE id = ?', [spaceId]);
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

  await db.query(
    `INSERT INTO project_action_notifications
       (item_id, recipient_id, event_type, delivery_status, payload)
     VALUES (?, ?, 'case_share_request', 'pending', ?)`,
    [
      result.insertId,
      project.owner_id,
      JSON.stringify({
        source: 'case_share_request',
        project_id: projectId,
        case_share_id: result.insertId,
        title,
      }),
    ]
  );

  return success(
    res,
    { id: result.insertId, status: 0 },
    '设计师案例分享申请已提交，等待业主确认'
  );
}

async function handleProjectCaseShare(req, res) {
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
  if (!['designer', 'project_manager', 'project_supervisor', 'merchant'].includes(role)) {
    return error(res, '成员身份不正确');
  }
  const projectId = Number(req.query.project_id);
  if (!projectId) return error(res, '项目ID不能为空');
  const keyword = String(req.query.keyword || '').trim();
  if (!keyword) return success(res, []);
  const [owners] = await db.query(
    `SELECT id FROM project_members
     WHERE project_id = ? AND user_id = ? AND role = 'owner' AND status = 1`,
    [projectId, req.user.id]
  );
  if (!owners[0]) return error(res, '只有业主可以添加成员', 403);

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
       AND (u.nickname LIKE ? OR u.phone LIKE ? OR u.city LIKE ?)
     ORDER BY u.id DESC
     LIMIT 30`,
    [
      projectId,
      projectId,
      role,
      req.user.id,
      `%${keyword}%`,
      `%${keyword}%`,
      `%${keyword}%`,
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
           WHERE id = ? AND designer_id IS NULL`,
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
    'SELECT id, designer_id FROM renovation_projects WHERE user_id = ?',
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
          'UPDATE renovation_projects SET designer_id = COALESCE(designer_id, ?) WHERE user_id = ?',
          [rows[0].designer_id, req.user.id]
        );
        if (result.affectedRows === 0) {
          await connection.rollback();
          return error(res, '装修档案不存在', 404);
        }
      }
      const [projects] = await connection.query(
        'SELECT id FROM renovation_projects WHERE user_id = ?',
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
  const { planned_start: plannedStart, planned_end: plannedEnd, task_name: taskName } = req.body;
  const fields = [];
  const params = [];
  if (plannedStart !== undefined) {
    fields.push('t.planned_start = ?');
    params.push(plannedStart);
  }
  if (plannedEnd !== undefined) {
    fields.push('t.planned_end = ?');
    params.push(plannedEnd);
  }
  if (taskName !== undefined) {
    fields.push('t.task_name = ?');
    params.push(taskName);
  }
  if (fields.length === 0) return error(res, '没有可更新的内容');
  params.push(Number(req.params.taskId), req.user.id, req.user.role);
  const [result] = await db.query(
    `UPDATE renovation_tasks t
     JOIN renovation_projects p ON t.project_id = p.id
     SET ${fields.join(', ')}
     WHERE t.id = ?
       AND EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id
           AND pm.user_id = ?
           AND pm.role = ?
           AND pm.status = 1
           AND pm.role IN ('designer', 'project_manager', 'project_supervisor')
       )`,
    params
  );
  if (result.affectedRows === 0) return error(res, '任务不存在或无权限', 404);
  const [tasks] = await db.query(
    'SELECT project_id FROM renovation_tasks WHERE id = ?',
    [Number(req.params.taskId)]
  );
  if (tasks[0]) await refreshProjectStageByTaskCompletion(tasks[0].project_id);
  return success(res, { updated: true });
}

async function addTask(req, res) {
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
  if (!taskName || !plannedStart || !plannedEnd) return error(res, '任务信息不完整');
  const [result] = await db.query(
    `INSERT INTO renovation_tasks
     (project_id, stage_id, task_name, is_key, planned_start, planned_end, status)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
    [projects[0].id, Number(stageId), taskName, isKey ? 1 : 0, plannedStart, plannedEnd]
  );
  const progress = await refreshProjectStageByTaskCompletion(projects[0].id);
  return success(res, { id: result.insertId, progress });
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
  const [rows] = await db.query(
    `SELECT p.id, p.project_code, p.project_name, p.house_area, p.start_date, p.total_days, p.current_stage,
            p.status, p.project_type, p.house_layout, p.floor_plan_image,
            p.renovation_method, p.budget_range, p.expected_move_in_date,
            p.resident_info, p.lifestyle_notes, p.style_preference,
            p.key_spaces, p.special_needs, p.created_at, pm.role AS member_role,
            owner.nickname AS owner_nickname, owner.phone AS owner_phone,
            owner.city AS owner_city
     FROM project_members pm
     JOIN renovation_projects p ON p.id = pm.project_id
     JOIN users owner ON owner.id = p.user_id
     WHERE pm.user_id = ? AND pm.status = 1
     ORDER BY FIELD(pm.role, 'owner', 'project_manager', 'project_supervisor', 'designer', 'merchant'),
              p.updated_at DESC, p.id DESC`,
    [req.user.id]
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
  const [rows] = await db.query(
    `SELECT p.*, u.nickname AS designer_name
     FROM renovation_projects p
     LEFT JOIN users u ON p.designer_id = u.id
     WHERE p.id = ?
       AND EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
       )`,
    [projectId, req.user.id]
  );
  if (!rows[0]) return error(res, '项目不存在', 404);
  return success(res, await calendarForProject(rows[0]));
}

async function getProjectCheckIns(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);

  const where =
    role === 'owner'
      ? 'checkin.project_id = ?'
      : `checkin.project_id = ?
         AND (
           checkin.user_id = ?
           OR EXISTS (
             SELECT 1 FROM project_checkin_shares share
             WHERE share.checkin_id = checkin.id
               AND share.shared_with_user_id = ?
           )
         )`;
  const params =
    role === 'owner' ? [projectId] : [projectId, req.user.id, req.user.id];
  const [rows] = await db.query(
    `SELECT checkin.id, checkin.project_id, checkin.user_id, checkin.role,
            checkin.description, checkin.checkin_date,
            checkin.shared_with_members, checkin.created_at, checkin.updated_at,
            user.nickname AS user_nickname, user.avatar AS user_avatar
     FROM project_checkins checkin
     JOIN users user ON user.id = checkin.user_id
     WHERE ${where}
     ORDER BY checkin.checkin_date DESC, checkin.created_at DESC, checkin.id DESC`,
    params
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
  const mediaMap = new Map();
  for (const item of media) {
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
  return success(
    res,
    rows.map((item) => ({
      ...item,
      media: mediaMap.get(item.id) || [],
      shared_members: shareMap.get(item.id) || [],
    }))
  );
}

async function createProjectCheckIn(req, res) {
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
         (checkin_id, shared_with_user_id)
         VALUES ${sharedMemberIds.map(() => '(?, ?)').join(', ')}`,
        sharedMemberIds.flatMap((userId) => [result.insertId, userId])
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
          `${host}/uploads/check-ins/${file.filename}`,
        ])
      );
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
  'pending',
  'confirmed',
  'revision_requested',
]);
const handoverStatuses = new Set(['pending', 'confirmed', 'needs_supplement']);
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

async function getProjectExpenses(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
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
  const projectId = Number(req.params.id);
  const expenseDate = String(req.body.expense_date || '');
  const category = String(req.body.category || 'other');
  const title = String(req.body.title || '').trim().slice(0, 120);
  const amount = Number(req.body.amount);
  const paymentMethod = String(req.body.payment_method || 'other');
  const payee = String(req.body.payee || '').trim().slice(0, 120);
  const note = String(req.body.note || '').trim().slice(0, 1000);
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
          `${host}/uploads/expenses/${file.filename}`,
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
    `SELECT doc.id, doc.project_id, doc.category, doc.title, doc.file_url,
            doc.file_type, doc.version_note, doc.status, doc.uploaded_by,
            doc.reviewed_by, doc.reviewed_at, doc.created_at, doc.updated_at,
            uploader.nickname AS uploader_name, uploader.avatar AS uploader_avatar,
            reviewer.nickname AS reviewer_name
     FROM project_design_documents doc
     JOIN users uploader ON uploader.id = doc.uploaded_by
     LEFT JOIN users reviewer ON reviewer.id = doc.reviewed_by
     WHERE doc.project_id = ?
     ORDER BY FIELD(doc.status, 'pending', 'revision_requested', 'confirmed'),
              doc.created_at DESC, doc.id DESC`,
    [projectId]
  );
  return success(res, rows);
}

async function uploadProjectDesignDocument(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role)) {
    await removeUploadedFiles(req.file ? [req.file] : []);
    return error(res, '项目不存在或无上传权限', 404);
  }
  if (!req.file) return error(res, '请选择要上传的设计资料');
  const imageUrl = `${req.protocol}://${req.get('host')}/uploads/design-documents/${req.file.filename}`;
  return success(res, {
    url: imageUrl,
    file_type: req.file.mimetype.startsWith('image/') ? 'image' : 'file',
  });
}

async function createProjectDesignDocument(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role)) {
    return error(res, '项目不存在或无上传权限', 404);
  }
  const category = String(req.body.category || 'other');
  const title = String(req.body.title || '').trim().slice(0, 120);
  const fileUrl = String(req.body.file_url || '').trim();
  const fileType = String(req.body.file_type || 'image').trim().slice(0, 32);
  const versionNote = String(req.body.version_note || '').trim().slice(0, 500);
  if (!designDocumentCategories.has(category)) {
    return error(res, '设计资料分类不正确');
  }
  if (!title) return error(res, '请填写资料标题');
  if (!fileUrl) return error(res, '请上传设计资料图片');
  const [result] = await db.query(
    `INSERT INTO project_design_documents
     (project_id, category, title, file_url, file_type, version_note, status, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      projectId,
      category,
      title,
      fileUrl,
      fileType || 'image',
      versionNote || null,
      req.user.id,
    ]
  );
  return success(res, { id: result.insertId }, '设计资料已上传');
}

async function updateProjectDesignDocumentStatus(req, res) {
  const projectId = Number(req.params.id);
  const documentId = Number(req.params.documentId);
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以确认设计资料', 403);
  }
  const status = String(req.body.status || '');
  if (!designDocumentStatuses.has(status) || status === 'pending') {
    return error(res, '设计资料状态不正确');
  }
  const [result] = await db.query(
    `UPDATE project_design_documents
     SET status = ?, reviewed_by = ?, reviewed_at = NOW()
     WHERE id = ? AND project_id = ?`,
    [status, req.user.id, documentId, projectId]
  );
  if (result.affectedRows === 0) return error(res, '设计资料不存在', 404);
  return success(res, null, '设计资料状态已更新');
}

async function getProjectHandovers(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT handover.id, handover.project_id, handover.stage_id, handover.title,
            handover.content, handover.target_user_id, handover.status,
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
     ORDER BY FIELD(handover.status, 'pending', 'needs_supplement', 'confirmed'),
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
  return success(
    res,
    rows.map((item) => ({
      ...item,
      stage_name: stages.find((stage) => stage.id === Number(item.stage_id))?.name || null,
      media: mediaMap.get(item.id) || [],
    }))
  );
}

async function createProjectHandover(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  const files = req.files || [];
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role)) {
    await removeUploadedFiles(files);
    return error(res, '项目不存在或无新建权限', 404);
  }
  const title = String(req.body.title || '').trim().slice(0, 120);
  const content = String(req.body.content || '').trim().slice(0, 3000);
  const stageId = req.body.stage_id ? Number(req.body.stage_id) : null;
  const targetUserId = req.body.target_user_id
    ? Number(req.body.target_user_id)
    : null;
  if (!title) {
    await removeUploadedFiles(files);
    return error(res, '请填写交底标题');
  }
  if (!content) {
    await removeUploadedFiles(files);
    return error(res, '请填写交底内容');
  }
  if (stageId !== null && !stages.some((stage) => stage.id === stageId)) {
    await removeUploadedFiles(files);
    return error(res, '装修阶段不正确');
  }
  if (targetUserId !== null) {
    const member = await requireActiveProjectMember(projectId, targetUserId);
    if (!member) {
      await removeUploadedFiles(files);
      return error(res, '交底对象不是项目成员');
    }
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      `INSERT INTO project_handovers
       (project_id, stage_id, title, content, target_user_id, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [projectId, stageId, title, content, targetUserId, req.user.id]
    );
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_handover_media
         (handover_id, media_type, media_url, uploaded_by)
         VALUES ${files.map(() => '(?, ?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          result.insertId,
          'image',
          `${host}/uploads/handovers/${file.filename}`,
          req.user.id,
        ])
      );
    }
    await connection.commit();
    return success(res, { id: result.insertId }, '施工交底资料已创建');
  } catch (handoverError) {
    await connection.rollback();
    await removeUploadedFiles(files);
    throw handoverError;
  } finally {
    connection.release();
  }
}

async function updateProjectHandoverStatus(req, res) {
  const projectId = Number(req.params.id);
  const handoverId = Number(req.params.handoverId);
  const status = String(req.body.status || '');
  if (!handoverStatuses.has(status) || status === 'pending') {
    return error(res, '交底状态不正确');
  }
  const role = await getProjectMemberRole(projectId, req.user.id);
  if (!role) return error(res, '项目不存在或无权限', 404);
  const [rows] = await db.query(
    `SELECT id, target_user_id FROM project_handovers
     WHERE id = ? AND project_id = ?`,
    [handoverId, projectId]
  );
  const handover = rows[0];
  if (!handover) return error(res, '交底资料不存在', 404);
  const canReview =
    role === 'owner' ||
    !handover.target_user_id ||
    Number(handover.target_user_id) === Number(req.user.id);
  if (!canReview) return error(res, '只有业主或交底对象可以确认', 403);
  await db.query(
    `UPDATE project_handovers
     SET status = ?, confirmed_by = ?, confirmed_at = NOW()
     WHERE id = ? AND project_id = ?`,
    [status, req.user.id, handoverId, projectId]
  );
  return success(res, null, '交底状态已更新');
}

async function getProjectMaterials(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canAccessProject(projectId, req.user.id))) {
    return error(res, '项目不存在或无权限', 404);
  }
  const [rows] = await db.query(
    `SELECT material.id, material.project_id, material.name, material.category,
            material.location, material.brand_model, material.quantity,
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
  return success(
    res,
    rows.map((item) => ({
      ...item,
      budget_total: multiplyMoney(item.quantity, item.budget_unit_price),
      actual_total: multiplyMoney(item.quantity, item.actual_unit_price),
      media: mediaMap.get(item.id) || [],
    }))
  );
}

async function createProjectMaterial(req, res) {
  const projectId = Number(req.params.id);
  const role = await getProjectMemberRole(projectId, req.user.id);
  const files = req.files || [];
  if (!['owner', 'designer', 'project_manager', 'project_supervisor'].includes(role)) {
    await removeUploadedFiles(files);
    return error(res, '项目不存在或无新建权限', 404);
  }
  const name = String(req.body.name || '').trim().slice(0, 120);
  const category = String(req.body.category || 'other');
  const location = String(req.body.location || '').trim().slice(0, 80);
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
       (project_id, name, category, location, brand_model, quantity, unit,
        budget_unit_price, actual_unit_price, supplier_type, arrival_status,
        confirm_status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        projectId,
        name,
        category,
        location || null,
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
    if (files.length) {
      const host = `${req.protocol}://${req.get('host')}`;
      await connection.query(
        `INSERT INTO project_material_media
         (material_id, media_type, media_url, uploaded_by)
         VALUES ${files.map(() => '(?, ?, ?, ?)').join(', ')}`,
        files.flatMap((file) => [
          result.insertId,
          'image',
          `${host}/uploads/materials/${file.filename}`,
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
     ORDER BY CASE item.status WHEN 'pending' THEN 0 ELSE 1 END,
              item.due_date, item.updated_at DESC`,
    [projectId]
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
          `${host}/uploads/action-items/${file.filename}`,
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
          `${host}/uploads/action-items/${file.filename}`,
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
  await recomputeProjectProgressDerivedStatuses(projectId);
  const [projectRows] = await db.query(
    `SELECT p.id, p.current_stage, p.status, p.start_date, p.total_days,
            p.pace_mode, p.pace_updated_at
     FROM renovation_projects p
     WHERE p.id = ?
       AND EXISTS (
         SELECT 1 FROM project_members pm
         WHERE pm.project_id = p.id AND pm.user_id = ? AND pm.status = 1
       )`,
    [projectId, req.user.id]
  );
  if (!projectRows[0]) return error(res, '项目不存在', 404);

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

async function requireActiveProjectMember(projectId, userId) {
  if (!userId) return null;
  const [rows] = await db.query(
    `SELECT pm.user_id, u.nickname
     FROM project_members pm
     JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ? AND pm.user_id = ? AND pm.status = 1`,
    [projectId, userId]
  );
  return rows[0] || null;
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
  if (!rows.length) return null;
  let currentStage = stages[stages.length - 1].id;
  let allCompleted = true;
  for (const stage of stages) {
    const row = rows.find((item) => Number(item.stage_id) === stage.id);
    if (!row) continue;
    if (Number(row.completed) < Number(row.total)) {
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
  if (inspection?.status === 'pending' || inspection?.status === 'rework') {
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
            planned_end, status
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
    const children = childrenByParent.get(itemId) || [];
    const childStatus = aggregateProgressStatuses(children.map(computeItem));
    const status =
      childStatus || derivedLeafProgressStatus(item, inspectionByItem.get(itemId));
    statusByItem.set(itemId, status);
    return status;
  };
  for (const item of items) computeItem(item);

  await Promise.all(
    items.map((item) => {
      const status = statusByItem.get(Number(item.id));
      const passed = inspectionByItem.get(Number(item.id))?.status === 'passed';
      return db.query(
        `UPDATE project_progress_items
         SET status = ?, actual_finish = CASE
           WHEN ? = 1 THEN COALESCE(actual_finish, CURDATE())
           WHEN ? = 0 AND status != 'completed' THEN NULL
           ELSE actual_finish
         END
         WHERE id = ? AND project_id = ?`,
        [status, passed ? 1 : 0, passed ? 1 : 0, item.id, projectId]
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
  const projectId = Number(req.params.id);
  const taskId = Number(req.params.taskId);
  const plannedStart = req.body.planned_start;
  const plannedEnd = req.body.planned_end;
  const taskName = req.body.task_name === undefined
    ? undefined
    : String(req.body.task_name || '').trim().slice(0, 100);
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
  if (!(await canManageProjectProgress(projectId, req.user.id))) {
    return error(res, '只有业主、设计师或项目经理可以调整任务', 403);
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
  const projectId = Number(req.params.id);
  const stageId = Number(req.body.stage_id);
  const taskName = String(req.body.task_name || '').trim().slice(0, 100);
  const plannedStart = req.body.planned_start;
  const plannedEnd = req.body.planned_end;
  const status = req.body.status === undefined ? 0 : Number(req.body.status);
  const isKey = req.body.is_key ? 1 : 0;
  if (!(await canManageProjectProgress(projectId, req.user.id))) {
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
  const [result] = await db.query(
    `INSERT INTO renovation_tasks
       (project_id, stage_id, task_name, is_key, planned_start, planned_end, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [projectId, stageId, taskName, isKey, plannedStart, plannedEnd, status]
  );
  const progress = await refreshProjectStageByTaskCompletion(projectId);
  return success(res, { id: result.insertId, progress }, '任务已新增');
}

async function deleteProjectTask(req, res) {
  const projectId = Number(req.params.id);
  const taskId = Number(req.params.taskId);
  if (!(await canManageProjectProgress(projectId, req.user.id))) {
    return error(res, '只有业主、设计师或项目经理可以删除事项', 403);
  }
  const [children] = await db.query(
    'SELECT COUNT(*) AS total FROM project_progress_items WHERE project_id = ? AND task_id = ?',
    [projectId, taskId]
  );
  if (Number(children[0].total) > 0) {
    return error(res, '该事项下已有子事项，请先删除子事项后再删除事项', 409);
  }
  const [result] = await db.query(
    'DELETE FROM renovation_tasks WHERE id = ? AND project_id = ?',
    [taskId, projectId]
  );
  if (!result.affectedRows) return error(res, '事项不存在', 404);
  const progress = await refreshProjectStageByTaskCompletion(projectId);
  return success(res, { deleted: true, progress }, '事项已删除');
}

async function completeProjectStage(req, res) {
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
  const status = String(body.status || 'pending');
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
    status,
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
  if (!['pending', 'in_progress', 'completed', 'delayed'].includes(item.status)) {
    return '子事项状态不正确';
  }
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

async function createProjectProgressItem(req, res) {
  const projectId = Number(req.params.id);
  if (!(await canManageProjectProgress(projectId, req.user.id))) {
    return error(res, '只有业主、设计师或项目经理可以维护子事项', 403);
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
  return success(res, { id: result.insertId }, '子事项已创建');
}

async function updateProjectProgressItem(req, res) {
  const projectId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  if (!(await canManageProjectProgress(projectId, req.user.id))) {
    return error(res, '只有业主、设计师或项目经理可以维护子事项', 403);
  }
  const [existingRows] = await db.query(
    `SELECT id, stage_id, task_id, parent_id, template_key,
            requires_inspection, inspection_template_key
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
  const [result] = await db.query(
    `UPDATE project_progress_items
     SET stage_id = ?, task_id = ?, parent_id = ?, title = ?, planned_start = ?,
         planned_end = ?, actual_finish = ?, status = ?, remark = ?,
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
      item.status,
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
  return success(res, { updated: true }, '子事项已更新');
}

async function deleteProjectProgressItem(req, res) {
  const projectId = Number(req.params.id);
  const itemId = Number(req.params.itemId);
  if (!(await canManageProjectProgress(projectId, req.user.id))) {
    return error(res, '只有业主、设计师或项目经理可以维护子事项', 403);
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

    await connection.query(
      'UPDATE project_inspections SET progress_item_id = NULL WHERE project_id = ? AND progress_item_id IN (?)',
      [projectId, ids]
    );
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
  const memberRoleSelect = hasMemberRole
    ? 'i.`member_role` AS member_role'
    : "'owner' AS member_role";
  const [rows] = await db.query(
    `SELECT i.id, i.project_id, i.task_id, i.progress_item_id,
            i.stage_id, i.responsible_user_id, i.status,
            ${memberRoleSelect},
            i.description, i.review_remark, i.submission_round,
            i.created_at, i.updated_at, i.reviewed_at,
            COALESCE(progress_item.title, t.task_name) AS task_name,
            submitter.nickname AS submitter_name,
            responsible.nickname AS responsible_name,
            reviewer.nickname AS reviewer_name
     FROM project_inspections i
     JOIN renovation_tasks t ON t.id = i.task_id
     LEFT JOIN project_progress_items progress_item
            ON progress_item.id = i.progress_item_id
     JOIN users submitter ON submitter.id = i.submitted_by
     LEFT JOIN users responsible ON responsible.id = i.responsible_user_id
     LEFT JOIN users reviewer ON reviewer.id = i.reviewed_by
     WHERE i.project_id = ?
     ORDER BY CASE i.status WHEN 'pending' THEN 0 WHEN 'rework' THEN 1 ELSE 2 END,
              i.updated_at DESC`,
    [projectId]
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
  return success(
    res,
    rows.map((item) => ({
      ...item,
      images: imageMap.get(item.id) || [],
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

async function createProjectInspection(req, res) {
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
  let responsibleMember = null;
  if (responsibleUserId) {
    responsibleMember = await requireActiveProjectMember(projectId, responsibleUserId);
    if (!responsibleMember) {
      await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
      return error(res, '整改责任人不是项目成员');
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
  const hasMemberRole = await ensureProjectInspectionMemberRoleColumn();
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.query(
      hasMemberRole
        ? `INSERT INTO project_inspections
           (project_id, task_id, progress_item_id, stage_id, submitted_by,
            member_role, responsible_user_id, status, description)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        : `INSERT INTO project_inspections
           (project_id, task_id, progress_item_id, stage_id, submitted_by,
            responsible_user_id, status, description)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      hasMemberRole
        ? [
            projectId,
            taskId,
            progressItemId,
            progressItem?.stage_id || tasks[0].stage_id,
            req.user.id,
            memberRole,
            responsibleUserId,
            description,
          ]
        : [
            projectId,
            taskId,
            progressItemId,
            progressItem?.stage_id || tasks[0].stage_id,
            req.user.id,
            responsibleUserId,
            description,
          ]
    );
    const host = `${req.protocol}://${req.get('host')}`;
    await connection.query(
      `INSERT INTO project_inspection_images
       (inspection_id, image_url, submission_round, uploaded_by)
       VALUES ${files.map(() => '(?, ?, 1, ?)').join(', ')}`,
      files.flatMap((file) => [
        result.insertId,
        `${host}/uploads/inspections/${file.filename}`,
        req.user.id,
      ])
    );
    await connection.commit();
    return success(res, { id: result.insertId }, '验收已提交');
  } catch (inspectionError) {
    await connection.rollback();
    await Promise.all(files.map((file) => fs.unlink(file.path).catch(() => {})));
    throw inspectionError;
  } finally {
    connection.release();
  }
}

async function reviewProjectInspection(req, res) {
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
  if (!(await requireProjectOwner(projectId, req.user.id))) {
    return error(res, '只有业主可以确认验收', 403);
  }
  if (result === 'rework' && !remark) return error(res, '请填写整改要求');
  if (result === 'rework' && !responsibleUserId) {
    return error(res, '请选择整改责任人');
  }
  if (result === 'rework' && responsibleUserId) {
    const responsibleMember = await requireActiveProjectMember(
      projectId,
      responsibleUserId
    );
    if (!responsibleMember) return error(res, '整改责任人不是项目成员');
  }

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT i.id, i.task_id, i.progress_item_id,
              COALESCE(progress_item.title, task.task_name) AS task_name
       FROM project_inspections i
       JOIN renovation_tasks task ON task.id = i.task_id
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
    await connection.commit();
    const progress = await refreshProjectStageByTaskCompletion(projectId);
    return success(
      res,
      { status: result, progress },
      result === 'passed' ? '验收已通过，任务已完成' : '已要求整改'
    );
  } catch (reviewError) {
    await connection.rollback();
    throw reviewError;
  } finally {
    connection.release();
  }
}

async function resubmitProjectInspection(req, res) {
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
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      `SELECT id, submission_round FROM project_inspections
       WHERE id = ? AND project_id = ? AND status = 'rework'
       FOR UPDATE`,
      [inspectionId, projectId]
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
        `${host}/uploads/inspections/${file.filename}`,
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
  getProjectInfoChangeRequests,
  createProjectInfoChangeRequest,
  handleProjectInfoChangeRequest,
  resetProject,
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
  getProjectExpenses,
  createProjectExpense,
  updateProjectExpense,
  deleteProjectExpense,
  getProjectDesignDocuments,
  uploadProjectDesignDocument,
  createProjectDesignDocument,
  updateProjectDesignDocumentStatus,
  getProjectHandovers,
  createProjectHandover,
  updateProjectHandoverStatus,
  getProjectMaterials,
  createProjectMaterial,
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
  getProjectProgressItems,
  createProjectProgressItem,
  updateProjectProgressItem,
  deleteProjectProgressItem,
  getProjectInspections,
  getProjectWorkItemTemplates,
  updateProjectWorkItemTemplateStatus,
  getProjectInspectionTemplates,
  getProjectInspectionTemplateDetail,
  createProjectInspection,
  reviewProjectInspection,
  resubmitProjectInspection,
  getStageTasks,
  getChecklist,
};
