#!/usr/bin/env node

const db = require('../config/db');

const apply = process.argv.includes('--apply');

function mainStatus(records) {
  if (records.some((record) => record.status === 'rework')) return 'rework';
  if (
    records.some((record) =>
      ['pending_owner_view', 'pending_member_check'].includes(record.status)
    )
  ) {
    return 'pending';
  }
  return 'passed';
}

function itemResult(status) {
  if (status === 'rework') return 'failed';
  if (status === 'recorded') return 'passed';
  return 'pending';
}

async function migrateGroup(connection, group) {
  const clientRequestId = `legacy-step-group-${group.project_id}-${group.stage_id}-${group.progress_item_id || 0}`;
  const [existing] = await connection.query(
    `SELECT id FROM project_inspections
     WHERE project_id = ? AND client_request_id = ?
     LIMIT 1 FOR UPDATE`,
    [group.project_id, clientRequestId]
  );
  let inspectionId = existing[0]?.id;
  if (!inspectionId) {
    const [progressRows] = group.progress_item_id
      ? await connection.query(
          `SELECT task_id, title FROM project_progress_items
           WHERE id = ? AND project_id = ? LIMIT 1`,
          [group.progress_item_id, group.project_id]
        )
      : [[]];
    const progress = progressRows[0];
    const [result] = await connection.query(
      `INSERT INTO project_inspections
       (project_id, task_id, progress_item_id, stage_id, title,
        template_code, client_request_id, submitted_by, member_role,
        status, description, algorithm_version, calculation_summary,
        row_version, calculated_at)
       VALUES (?, ?, ?, ?, ?, 'legacy_step_records', ?, ?, ?, ?, ?,
               'legacy-step-migration-v1', ?, 1, NOW())`,
      [
        group.project_id,
        progress?.task_id || null,
        group.progress_item_id || null,
        group.stage_id,
        progress?.title || `阶段 ${group.stage_id} 验收`,
        clientRequestId,
        group.records[0].created_by,
        group.records[0].member_role || 'owner',
        mainStatus(group.records),
        '由历史验收步骤安全迁移生成',
        JSON.stringify({
          source: 'project_inspection_step_records',
          migrated_record_count: group.records.length,
        }),
      ]
    );
    inspectionId = result.insertId;
  }

  const latestByStep = new Map();
  for (const record of group.records) {
    const current = latestByStep.get(record.step_key);
    if (
      !current ||
      new Date(record.updated_at || record.created_at) >
        new Date(current.updated_at || current.created_at)
    ) {
      latestByStep.set(record.step_key, record);
    }
  }
  for (const record of latestByStep.values()) {
    const itemKey = `legacy:${record.step_key}`;
    await connection.query(
      `INSERT INTO project_inspection_items
       (inspection_id, project_id, item_key, title, check_method, result,
        description, responsible_user_id, sort_order, source_step_record_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         check_method = VALUES(check_method),
         result = VALUES(result),
         description = VALUES(description),
         responsible_user_id = VALUES(responsible_user_id),
         source_step_record_id = VALUES(source_step_record_id)`,
      [
        inspectionId,
        group.project_id,
        itemKey,
        record.step_title,
        record.step_action,
        itemResult(record.status),
        record.response_description || record.review_remark || record.description,
        record.target_user_id,
        Number(record.id),
        record.id,
      ]
    );
    const [[item]] = await connection.query(
      `SELECT id FROM project_inspection_items
       WHERE inspection_id = ? AND item_key = ?`,
      [inspectionId, itemKey]
    );
    await connection.query(
      `INSERT INTO project_inspection_item_images
       (inspection_item_id, source_step_image_id, image_url, uploaded_by, created_at)
       SELECT ?, image.id, image.image_url, image.uploaded_by, image.created_at
       FROM project_inspection_step_record_images image
       WHERE image.record_id = ?
       ON DUPLICATE KEY UPDATE image_url = VALUES(image_url)`,
      [item.id, record.id]
    );
  }
  await connection.query(
    `UPDATE project_inspection_step_records
     SET inspection_id = ?
     WHERE project_id = ? AND stage_id = ?
       AND progress_item_id <=> ? AND inspection_id IS NULL`,
    [
      inspectionId,
      group.project_id,
      group.stage_id,
      group.progress_item_id || null,
    ]
  );
  return inspectionId;
}

async function run() {
  const [records] = await db.query(
    `SELECT id, project_id, stage_id, progress_item_id, step_key, step_title,
            step_action, status, description, review_remark,
            response_description, created_by, member_role, target_user_id,
            created_at, updated_at
     FROM project_inspection_step_records
     WHERE inspection_id IS NULL
     ORDER BY project_id, stage_id, progress_item_id, id`
  );
  const groups = new Map();
  for (const record of records) {
    const key = `${record.project_id}:${record.stage_id}:${record.progress_item_id || 0}`;
    if (!groups.has(key)) {
      groups.set(key, {
        project_id: record.project_id,
        stage_id: record.stage_id,
        progress_item_id: record.progress_item_id,
        records: [],
      });
    }
    groups.get(key).records.push(record);
  }
  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    unlinked_records: records.length,
    main_records_to_create_or_reuse: groups.size,
    groups: [...groups.values()].map((group) => ({
      project_id: group.project_id,
      stage_id: group.stage_id,
      progress_item_id: group.progress_item_id,
      record_count: group.records.length,
      latest_check_item_count: new Set(
        group.records.map((record) => record.step_key)
      ).size,
      derived_status: mainStatus(group.records),
    })),
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!apply || records.length === 0) return;

  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    for (const group of groups.values()) {
      await migrateGroup(connection, group);
    }
    await connection.commit();
    console.log(`迁移完成：${records.length} 条历史步骤已关联到 ${groups.size} 条主验收。`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
