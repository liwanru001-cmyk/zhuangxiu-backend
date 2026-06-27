const mysql = require('mysql2/promise');
require('dotenv').config();
const { workItemTemplates } = require('./workItemTemplates');

const progressStageNames = {
  1: '设计准备',
  2: '主体拆改',
  3: '水电改造',
  4: '泥瓦防水',
  5: '木工施工',
  6: '油漆施工',
  7: '安装阶段',
  8: '竣工验收',
};

const defaultProgressTaskNames = {
  1: ['确认装修需求', '确定设计方案', '核对装修预算'],
  2: ['现场成品保护', '拆除与清运'],
  3: ['水电定位', '水电施工', '水电验收'],
  4: ['墙地面找平', '防水施工', '闭水试验'],
  5: ['吊顶施工', '柜体基层施工'],
  6: ['墙面基层处理', '乳胶漆施工', '墙面验收'],
  7: ['主材安装', '灯具洁具安装', '软装进场'],
  8: ['全屋验收', '开荒保洁'],
};

function defaultProgressTemplates() {
  return Object.entries(defaultProgressTaskNames).flatMap(([stageIdText, names]) => {
    const stageId = Number(stageIdText);
    return names.map((title, index) => [
      `default_stage_${stageId}_${String(index + 1).padStart(2, '0')}`,
      stageId,
      title,
      '',
      0,
      null,
      null,
      null,
      '',
      stageId * 1000 + (index + 1) * 10,
      'default',
      1,
      null,
      index === 0 ? 1 : 0,
    ]);
  });
}

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: 'utf8mb4',
  dateStrings: ['DATE'],
  waitForConnections: true,
  connectionLimit: 20,
  queueLimit: 0,
});

pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL connected:', process.env.DB_NAME);
    conn.release();
    ensureAppTables().catch(err => {
      console.error('❌ App table init failed:', err.message);
    });
  })
  .catch(err => {
    console.error('❌ MySQL connection failed:', err.message);
  });

async function ensureAppTables() {
  await ensureUserAdminStatusColumn();
  await ensureRenovationProjectNameColumn();
  await ensureRenovationProjectCodeColumn();
  await ensureRenovationProjectArchiveColumns();
  await ensureProjectDesignDocumentTables();
  await ensureProjectDesignDocumentRevisionRequestTables();
  await ensureProjectHandoverTables();
  await ensureProjectDesignHandoverReferenceTables();
  await ensureConstructionDisclosureDocumentTables();
  await ensureProjectMaterialTables();
  await ensureProjectTipsTable();
  await ensureWorkItemTemplateTables();
  await ensureHelpFeedbackTables();
  await ensureDesignerProjectInvitationRoleColumn();
  if (process.env.FEATURE_INSPECTION_KB === 'true') {
    await ensureProjectInspectionTemplateTables();
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_checkins (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      role VARCHAR(32) NOT NULL,
      description TEXT NOT NULL,
      checkin_date DATE NOT NULL,
      shared_with_members TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_project_date (project_id, checkin_date),
      KEY idx_user_project (user_id, project_id),
      KEY idx_visibility (project_id, shared_with_members)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_checkin_media (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      checkin_id BIGINT UNSIGNED NOT NULL,
      media_type VARCHAR(16) NOT NULL,
      media_url VARCHAR(500) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_checkin_id (checkin_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_checkin_shares (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      checkin_id BIGINT UNSIGNED NOT NULL,
      shared_with_user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_checkin_user (checkin_id, shared_with_user_id),
      KEY idx_shared_user (shared_with_user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_expenses (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      expense_date DATE NOT NULL,
      category VARCHAR(32) NOT NULL,
      title VARCHAR(120) NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      payment_method VARCHAR(32) NOT NULL DEFAULT 'other',
      payee VARCHAR(120) DEFAULT NULL,
      note TEXT DEFAULT NULL,
      include_in_total TINYINT(1) NOT NULL DEFAULT 1,
      status VARCHAR(32) NOT NULL DEFAULT 'paid',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_project_date (project_id, expense_date),
      KEY idx_project_category (project_id, category),
      KEY idx_created_by (created_by)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_expense_media (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      expense_id BIGINT UNSIGNED NOT NULL,
      media_type VARCHAR(16) NOT NULL DEFAULT 'image',
      media_url VARCHAR(500) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_expense_id (expense_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS designer_profiles (
      user_id BIGINT UNSIGNED NOT NULL,
      service_city VARCHAR(80) DEFAULT NULL,
      styles JSON DEFAULT NULL,
      experience_years INT UNSIGNED NOT NULL DEFAULT 0,
      case_count INT UNSIGNED NOT NULL DEFAULT 0,
      design_philosophy TEXT DEFAULT NULL,
      verified_status TINYINT(1) NOT NULL DEFAULT 0,
      consultation_enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_manager_profiles (
      user_id BIGINT UNSIGNED NOT NULL,
      service_area VARCHAR(80) DEFAULT NULL,
      project_types JSON DEFAULT NULL,
      management_skills JSON DEFAULT NULL,
      experience_years INT UNSIGNED NOT NULL DEFAULT 0,
      managed_project_count INT UNSIGNED NOT NULL DEFAULT 0,
      management_philosophy TEXT DEFAULT NULL,
      consultation_enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS merchant_profiles (
      user_id BIGINT UNSIGNED NOT NULL,
      service_area VARCHAR(80) DEFAULT NULL,
      categories JSON DEFAULT NULL,
      service_types JSON DEFAULT NULL,
      case_count INT UNSIGNED NOT NULL DEFAULT 0,
      brand_intro TEXT DEFAULT NULL,
      consultation_enabled TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_members (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      role VARCHAR(32) NOT NULL,
      status TINYINT(1) NOT NULL DEFAULT 1,
      permissions JSON DEFAULT NULL,
      joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_project_user_role (project_id, user_id, role),
      KEY idx_user_role_status (user_id, role, status),
      KEY idx_project_status (project_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_member_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      target_user_id BIGINT UNSIGNED NOT NULL,
      member_role VARCHAR(32) NOT NULL,
      status TINYINT(1) NOT NULL DEFAULT 0,
      message VARCHAR(300) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_project_target_role (project_id, target_user_id, member_role),
      KEY idx_target_role_status (target_user_id, member_role, status),
      KEY idx_owner_project (owner_id, project_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_progress_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      stage_id TINYINT UNSIGNED NOT NULL,
      task_id BIGINT UNSIGNED DEFAULT NULL,
      parent_id BIGINT UNSIGNED DEFAULT NULL,
      template_key VARCHAR(80) DEFAULT NULL,
      title VARCHAR(100) NOT NULL,
      planned_start DATE DEFAULT NULL,
      planned_end DATE DEFAULT NULL,
      actual_finish DATE DEFAULT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      remark VARCHAR(1000) DEFAULT NULL,
      is_key_node TINYINT(1) NOT NULL DEFAULT 0,
      requires_inspection TINYINT(1) NOT NULL DEFAULT 0,
      inspection_template_key VARCHAR(64) DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_by BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_progress_item_project_stage (project_id, stage_id, sort_order, id),
      KEY idx_progress_item_task (task_id, sort_order, id),
      KEY idx_progress_item_parent (parent_id, sort_order, id),
      KEY idx_progress_item_template (project_id, template_key),
      KEY idx_progress_item_creator (created_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [progressItemColumns] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_progress_items'
      AND COLUMN_NAME = 'task_id'
  `);
  if (!progressItemColumns.length) {
    await pool.query(`
      ALTER TABLE project_progress_items
      ADD COLUMN task_id BIGINT UNSIGNED DEFAULT NULL AFTER stage_id
    `);
  }
  const [progressItemIndexes] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_progress_items'
      AND INDEX_NAME = 'idx_progress_item_task'
  `);
  if (!progressItemIndexes.length) {
    await pool.query(`
      CREATE INDEX idx_progress_item_task
      ON project_progress_items (task_id, sort_order, id)
    `);
  }
  await ensureProjectProgressTemplateColumns();
  await ensureProjectWorkItemSelectionTables();
  await ensureProjectActionTables();
  await ensureProjectInfoChangeRequestTables();
  await ensureProjectSpaceChangeRequestTables();
  await ensureProjectCaseShareTables();
  const [inspectionTables] = await pool.query(`
    SELECT TABLE_NAME FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_inspections'
  `);
  if (inspectionTables.length) {
    const [inspectionProgressItemColumns] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'project_inspections'
        AND COLUMN_NAME = 'progress_item_id'
    `);
    if (!inspectionProgressItemColumns.length) {
      await pool.query(`
        ALTER TABLE project_inspections
        ADD COLUMN progress_item_id BIGINT UNSIGNED DEFAULT NULL AFTER task_id
      `);
    }
    const [inspectionProgressItemIndexes] = await pool.query(`
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'project_inspections'
        AND INDEX_NAME = 'idx_inspection_progress_item'
    `);
    if (!inspectionProgressItemIndexes.length) {
      await pool.query(`
        CREATE INDEX idx_inspection_progress_item
        ON project_inspections (progress_item_id, updated_at)
      `);
    }
    const [inspectionResponsibleColumns] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'project_inspections'
        AND COLUMN_NAME = 'responsible_user_id'
    `);
    if (!inspectionResponsibleColumns.length) {
      await pool.query(`
        ALTER TABLE project_inspections
        ADD COLUMN responsible_user_id BIGINT UNSIGNED DEFAULT NULL AFTER submitted_by
      `);
    }
    const [inspectionMemberRoleColumns] = await pool.query(`
      SELECT COLUMN_NAME FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'project_inspections'
        AND COLUMN_NAME = 'member_role'
    `);
    if (!inspectionMemberRoleColumns.length) {
      await pool.query(`
        ALTER TABLE project_inspections
        ADD COLUMN member_role VARCHAR(32) NOT NULL DEFAULT 'owner' AFTER submitted_by
      `);
    }
    const [inspectionResponsibleIndexes] = await pool.query(`
      SELECT INDEX_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'project_inspections'
        AND INDEX_NAME = 'idx_inspection_responsible'
    `);
    if (!inspectionResponsibleIndexes.length) {
      await pool.query(`
        CREATE INDEX idx_inspection_responsible
        ON project_inspections (responsible_user_id, status, updated_at)
      `);
    }
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS designer_consultations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      designer_id BIGINT UNSIGNED NOT NULL,
      target_role ENUM('designer', 'project_manager', 'project_supervisor', 'merchant') NOT NULL DEFAULT 'designer',
      user_id BIGINT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      project_city VARCHAR(80) DEFAULT NULL,
      renovation_stage VARCHAR(80) DEFAULT NULL,
      has_project TINYINT(1) NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'pending_confirm',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_designer_status (designer_id, status, created_at),
      KEY idx_consultation_target_role (designer_id, target_role, status, created_at),
      KEY idx_user_created (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consultation_messages (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      consultation_id BIGINT UNSIGNED NOT NULL,
      sender_id BIGINT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_consultation_created (consultation_id, created_at),
      KEY idx_sender_created (sender_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS consultation_message_reads (
      message_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (message_id, user_id),
      KEY idx_user_read (user_id, read_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureRenovationProjectNameColumn() {
  const [tables] = await pool.query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_projects'
  `);
  if (!tables.length) return;

  const [columns] = await pool.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_projects'
      AND COLUMN_NAME = 'project_name'
  `);
  if (columns.length > 0) return;
  await pool.query(`
    ALTER TABLE renovation_projects
      ADD COLUMN project_name VARCHAR(80) NOT NULL DEFAULT '装修项目' AFTER user_id
  `);
}

async function ensureDesignerProjectInvitationRoleColumn() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS designer_project_invitations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      designer_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      member_role VARCHAR(32) NOT NULL DEFAULT 'designer',
      status TINYINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '0:待处理 1:同意 2:拒绝',
      message VARCHAR(300) DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_inviter_owner_role (designer_id, owner_id, member_role),
      KEY idx_owner_role_status (owner_id, member_role, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [columns] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND COLUMN_NAME = 'member_role'
  `);
  if (!columns.length) {
    await pool.query(`
      ALTER TABLE designer_project_invitations
      ADD COLUMN member_role VARCHAR(32) NOT NULL DEFAULT 'designer' AFTER owner_id
    `);
  }
  const [roleIndexes] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND INDEX_NAME = 'uk_inviter_owner_role'
  `);
  if (!roleIndexes.length) {
    await pool.query(`
      ALTER TABLE designer_project_invitations
      ADD UNIQUE KEY uk_inviter_owner_role (designer_id, owner_id, member_role)
    `);
  }
  const [oldIndexes] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND INDEX_NAME = 'uk_designer_owner'
  `);
  if (oldIndexes.length) {
    await pool.query('ALTER TABLE designer_project_invitations DROP INDEX uk_designer_owner');
  }
  const [ownerRoleIndexes] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'designer_project_invitations'
      AND INDEX_NAME = 'idx_owner_role_status'
  `);
  if (!ownerRoleIndexes.length) {
    await pool.query(`
      CREATE INDEX idx_owner_role_status
      ON designer_project_invitations (owner_id, member_role, status)
    `);
  }
}

async function ensureRenovationProjectCodeColumn() {
  const [tables] = await pool.query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_projects'
  `);
  if (!tables.length) return;

  const [columns] = await pool.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_projects'
      AND COLUMN_NAME = 'project_code'
  `);
  if (!columns.length) {
    await pool.query(`
      ALTER TABLE renovation_projects
        ADD COLUMN project_code CHAR(10) NULL AFTER user_id
    `);
  }

  await pool.query(`
    UPDATE renovation_projects
    SET project_code = CONCAT(
      CHAR(65 + MOD(id, 26)),
      CHAR(65 + MOD(FLOOR(id / 26), 26)),
      LPAD(id, 8, '0')
    )
    WHERE project_code IS NULL OR project_code = ''
  `);

  const [indexes] = await pool.query(`
    SELECT INDEX_NAME
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_projects'
      AND INDEX_NAME = 'uk_project_code'
  `);
  if (!indexes.length) {
    await pool.query(`
      ALTER TABLE renovation_projects
        MODIFY project_code CHAR(10) NOT NULL,
        ADD UNIQUE KEY uk_project_code (project_code)
    `);
  } else {
    await pool.query(`
      ALTER TABLE renovation_projects
        MODIFY project_code CHAR(10) NOT NULL
    `);
  }
}

async function ensureRenovationProjectArchiveColumns() {
  const [tables] = await pool.query(`
    SELECT TABLE_NAME
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_projects'
  `);
  if (!tables.length) return;

  const columns = [
    ['budget_range', "VARCHAR(80) DEFAULT NULL AFTER renovation_method"],
    ['expected_move_in_date', "DATE DEFAULT NULL AFTER budget_range"],
    ['resident_info', "VARCHAR(255) DEFAULT NULL AFTER expected_move_in_date"],
    ['lifestyle_notes', "TEXT DEFAULT NULL AFTER resident_info"],
    ['style_preference', "VARCHAR(255) DEFAULT NULL AFTER lifestyle_notes"],
    ['key_spaces', "VARCHAR(255) DEFAULT NULL AFTER style_preference"],
    ['special_needs', "TEXT DEFAULT NULL AFTER key_spaces"],
  ];

  for (const [name, definition] of columns) {
    const [existing] = await pool.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'renovation_projects'
         AND COLUMN_NAME = ?`,
      [name]
    );
    if (existing.length === 0) {
      await pool.query(`
        ALTER TABLE renovation_projects
          ADD COLUMN ${name} ${definition}
      `);
    }
  }
}

async function ensureProjectDesignDocumentTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_design_documents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      category VARCHAR(32) NOT NULL DEFAULT 'other',
      space_key VARCHAR(32) NOT NULL DEFAULT 'whole_house',
      title VARCHAR(120) NOT NULL,
      file_url VARCHAR(500) NOT NULL,
      file_type VARCHAR(32) NOT NULL DEFAULT 'image',
      mime_type VARCHAR(120) DEFAULT NULL,
      file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
      original_name VARCHAR(255) DEFAULT NULL,
      version_note VARCHAR(500) DEFAULT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      uploaded_by BIGINT UNSIGNED NOT NULL,
      reviewed_by BIGINT UNSIGNED DEFAULT NULL,
      reviewed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_design_project_category (project_id, category, created_at),
      KEY idx_design_project_space (project_id, space_key, created_at),
      KEY idx_design_project_status (project_id, status, updated_at),
      KEY idx_design_uploader (uploaded_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [columns] = await pool.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_design_documents'
      AND COLUMN_NAME = 'space_key'
  `);
  if (!columns.length) {
    await pool.query(`
      ALTER TABLE project_design_documents
      ADD COLUMN space_key VARCHAR(32) NOT NULL DEFAULT 'whole_house' AFTER category,
      ADD KEY idx_design_project_space (project_id, space_key, created_at)
    `);
  }
  const optionalColumns = [
    ['mime_type', "VARCHAR(120) DEFAULT NULL AFTER file_type"],
    ['file_size', "BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER mime_type"],
    ['original_name', "VARCHAR(255) DEFAULT NULL AFTER file_size"],
    ['version_group_id', "BIGINT UNSIGNED DEFAULT NULL AFTER project_id"],
    ['version_no', "INT UNSIGNED NOT NULL DEFAULT 1 AFTER version_group_id"],
    ['is_current', "TINYINT UNSIGNED NOT NULL DEFAULT 1 AFTER version_no"],
    ['superseded_by', "BIGINT UNSIGNED DEFAULT NULL AFTER is_current"],
    ['confirmed_at', "TIMESTAMP NULL DEFAULT NULL AFTER reviewed_at"],
    ['voided_at', "TIMESTAMP NULL DEFAULT NULL AFTER confirmed_at"],
    ['storage_key', "VARCHAR(500) DEFAULT NULL AFTER file_url"],
    ['preview_url', "VARCHAR(500) DEFAULT NULL AFTER storage_key"],
    ['thumbnail_url', "VARCHAR(500) DEFAULT NULL AFTER preview_url"],
    ['preview_status', "VARCHAR(32) NOT NULL DEFAULT 'none' AFTER thumbnail_url"],
    ['preview_type', "VARCHAR(32) NOT NULL DEFAULT 'none' AFTER preview_status"],
  ];
  for (const [columnName, definition] of optionalColumns) {
    const [existing] = await pool.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'project_design_documents'
         AND COLUMN_NAME = ?`,
      [columnName]
    );
    if (!existing.length) {
      await pool.query(`
        ALTER TABLE project_design_documents
        ADD COLUMN ${columnName} ${definition}
      `);
    }
  }
  await pool.query(`
    UPDATE project_design_documents
    SET version_group_id = id
    WHERE version_group_id IS NULL
  `);
  await pool.query(`
    UPDATE project_design_documents
    SET is_current = 1
    WHERE is_current IS NULL
  `);
}

async function ensureProjectHandoverTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_handovers (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      stage_id TINYINT UNSIGNED DEFAULT NULL,
      title VARCHAR(120) NOT NULL,
      content TEXT NOT NULL,
      target_user_id BIGINT UNSIGNED DEFAULT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      status VARCHAR(32) NOT NULL DEFAULT 'pending_confirm',
      created_by BIGINT UNSIGNED NOT NULL,
      confirmed_by BIGINT UNSIGNED DEFAULT NULL,
      confirmed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_handover_project_stage (project_id, stage_id, created_at),
      KEY idx_handover_target (target_user_id, status, updated_at),
      KEY idx_handover_creator (created_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_handover_media (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      handover_id BIGINT UNSIGNED NOT NULL,
      media_type VARCHAR(16) NOT NULL DEFAULT 'image',
      media_url VARCHAR(500) NOT NULL,
      uploaded_by BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_handover_media (handover_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const optionalColumns = [
    ['version_no', "INT UNSIGNED NOT NULL DEFAULT 1 AFTER target_user_id"],
  ];
  for (const [columnName, definition] of optionalColumns) {
    const [existing] = await pool.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'project_handovers'
         AND COLUMN_NAME = ?`,
      [columnName]
    );
    if (!existing.length) {
      await pool.query(`
        ALTER TABLE project_handovers
        ADD COLUMN ${columnName} ${definition}
      `);
    }
  }
}

async function ensureProjectDesignHandoverReferenceTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_design_handover_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      design_handover_id BIGINT UNSIGNED NOT NULL,
      related_stage_id TINYINT UNSIGNED DEFAULT NULL,
      importance VARCHAR(16) NOT NULL DEFAULT 'normal',
      check_type VARCHAR(24) NOT NULL DEFAULT 'progress_note',
      source_section VARCHAR(80) NOT NULL,
      summary VARCHAR(500) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_design_handover_items_stage (project_id, related_stage_id, check_type, importance),
      KEY idx_design_handover_items_handover (design_handover_id, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_inspection_design_checks (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      inspection_id BIGINT UNSIGNED NOT NULL,
      design_handover_id BIGINT UNSIGNED NOT NULL,
      design_handover_item_id BIGINT UNSIGNED DEFAULT NULL,
      snapshot_source_title VARCHAR(120) NOT NULL,
      snapshot_version_no INT UNSIGNED NOT NULL DEFAULT 1,
      snapshot_summary VARCHAR(500) NOT NULL,
      check_result VARCHAR(24) NOT NULL DEFAULT 'pending',
      checked_by BIGINT UNSIGNED DEFAULT NULL,
      checked_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_inspection_design_checks (inspection_id, created_at),
      KEY idx_project_design_checks (project_id, design_handover_id, created_at),
      KEY idx_design_check_item (design_handover_item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureProjectDesignDocumentRevisionRequestTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_design_document_revision_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      design_document_id BIGINT UNSIGNED NOT NULL,
      design_document_version_id BIGINT UNSIGNED NOT NULL,
      version_no INT UNSIGNED NOT NULL DEFAULT 1,
      requested_by BIGINT UNSIGNED NOT NULL,
      assignee_id BIGINT UNSIGNED DEFAULT NULL,
      reason VARCHAR(500) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'open',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_design_revision_project (project_id, created_at),
      KEY idx_design_revision_group (design_document_id, created_at),
      KEY idx_design_revision_version (design_document_version_id, created_at),
      KEY idx_design_revision_assignee (assignee_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureConstructionDisclosureDocumentTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS construction_disclosure_documents (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      disclosure_id BIGINT UNSIGNED NOT NULL,
      design_document_id BIGINT UNSIGNED NOT NULL,
      design_document_version_id BIGINT UNSIGNED NOT NULL,
      purpose VARCHAR(80) DEFAULT NULL,
      snapshot_title VARCHAR(120) NOT NULL,
      snapshot_version_no INT UNSIGNED NOT NULL DEFAULT 1,
      snapshot_file_url VARCHAR(500) NOT NULL,
      snapshot_category VARCHAR(32) NOT NULL DEFAULT 'other',
      snapshot_space_key VARCHAR(32) NOT NULL DEFAULT 'whole_house',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_disclosure_documents (disclosure_id, created_at),
      KEY idx_design_document_disclosures (design_document_id, created_at),
      KEY idx_design_document_version_disclosures (design_document_version_id, created_at),
      KEY idx_disclosure_project (project_id, disclosure_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const optionalColumns = [
    ['snapshot_category', "VARCHAR(32) NOT NULL DEFAULT 'other' AFTER snapshot_file_url"],
    ['snapshot_space_key', "VARCHAR(32) NOT NULL DEFAULT 'whole_house' AFTER snapshot_category"],
  ];
  for (const [columnName, definition] of optionalColumns) {
    const [existing] = await pool.query(
      `SELECT COLUMN_NAME
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'construction_disclosure_documents'
         AND COLUMN_NAME = ?`,
      [columnName]
    );
    if (!existing.length) {
      await pool.query(`
        ALTER TABLE construction_disclosure_documents
        ADD COLUMN ${columnName} ${definition}
      `);
    }
  }
}

async function ensureProjectMaterialTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_material_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      name VARCHAR(120) NOT NULL,
      category VARCHAR(32) NOT NULL DEFAULT 'other',
      location VARCHAR(80) DEFAULT NULL,
      brand_model VARCHAR(160) DEFAULT NULL,
      quantity DECIMAL(10,2) DEFAULT NULL,
      unit VARCHAR(20) DEFAULT NULL,
      budget_unit_price DECIMAL(12,2) DEFAULT NULL,
      actual_unit_price DECIMAL(12,2) DEFAULT NULL,
      supplier_type VARCHAR(32) NOT NULL DEFAULT 'other',
      arrival_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      confirm_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      note TEXT DEFAULT NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      confirmed_by BIGINT UNSIGNED DEFAULT NULL,
      confirmed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_material_project_category (project_id, category, created_at),
      KEY idx_material_arrival (project_id, arrival_status, updated_at),
      KEY idx_material_confirm (project_id, confirm_status, updated_at),
      KEY idx_material_creator (created_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_material_media (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      material_id BIGINT UNSIGNED NOT NULL,
      media_type VARCHAR(16) NOT NULL DEFAULT 'image',
      media_url VARCHAR(500) NOT NULL,
      uploaded_by BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_material_media (material_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureProjectInspectionTemplateTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inspection_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      code VARCHAR(64) NOT NULL,
      title VARCHAR(120) NOT NULL,
      stage_id TINYINT UNSIGNED DEFAULT NULL,
      node_type VARCHAR(32) NOT NULL DEFAULT 'stage',
      description TEXT DEFAULT NULL,
      standard_basis VARCHAR(500) DEFAULT NULL,
      applicable_project_types JSON DEFAULT NULL,
      applicable_methods JSON DEFAULT NULL,
      recommended_tools JSON DEFAULT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_inspection_template_code (code),
      KEY idx_inspection_template_stage (stage_id, sort_order, is_active),
      KEY idx_inspection_template_active (is_active, sort_order)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS inspection_template_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      template_id BIGINT UNSIGNED NOT NULL,
      code VARCHAR(80) NOT NULL,
      title VARCHAR(160) NOT NULL,
      standard_text TEXT NOT NULL,
      check_method TEXT DEFAULT NULL,
      required_tools JSON DEFAULT NULL,
      risk_level VARCHAR(16) NOT NULL DEFAULT 'normal',
      failure_action TEXT DEFAULT NULL,
      require_photo TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_inspection_item_code (code),
      KEY idx_inspection_item_template (template_id, sort_order, is_active),
      KEY idx_inspection_item_risk (risk_level, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await seedProjectInspectionTemplates();
}

async function ensureProjectProgressTemplateColumns() {
  const [columns] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_progress_items'
      AND COLUMN_NAME IN ('template_key', 'requires_inspection', 'inspection_template_key')
  `);
  const existing = new Set(columns.map((row) => row.COLUMN_NAME));
  if (!existing.has('template_key')) {
    await pool.query(`
      ALTER TABLE project_progress_items
      ADD COLUMN template_key VARCHAR(80) DEFAULT NULL AFTER parent_id
    `);
  }
  if (!existing.has('requires_inspection')) {
    await pool.query(`
      ALTER TABLE project_progress_items
      ADD COLUMN requires_inspection TINYINT(1) NOT NULL DEFAULT 0 AFTER is_key_node
    `);
  }
  if (!existing.has('inspection_template_key')) {
    await pool.query(`
      ALTER TABLE project_progress_items
      ADD COLUMN inspection_template_key VARCHAR(64) DEFAULT NULL AFTER requires_inspection
    `);
  }
  const [indexes] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_progress_items'
      AND INDEX_NAME = 'idx_progress_item_template'
  `);
  if (!indexes.length) {
    await pool.query(`
      CREATE INDEX idx_progress_item_template
      ON project_progress_items (project_id, template_key)
    `);
  }
}

async function ensureProjectWorkItemSelectionTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_work_item_template_status (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      template_key VARCHAR(80) NOT NULL,
      status VARCHAR(24) NOT NULL DEFAULT 'pending',
      note VARCHAR(300) DEFAULT NULL,
      updated_by BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_project_template_status (project_id, template_key),
      KEY idx_project_template_status (project_id, status),
      KEY idx_template_key_status (template_key, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureWorkItemTemplateTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS renovation_work_item_templates (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      template_key VARCHAR(80) NOT NULL,
      stage_id TINYINT UNSIGNED NOT NULL,
      parent_template_key VARCHAR(80) DEFAULT NULL,
      title VARCHAR(120) NOT NULL,
      required_level VARCHAR(16) NOT NULL DEFAULT 'recommended',
      source VARCHAR(24) NOT NULL DEFAULT 'recommendation',
      default_join TINYINT(1) NOT NULL DEFAULT 0,
      requires_inspection TINYINT(1) NOT NULL DEFAULT 0,
      inspection_template_key VARCHAR(64) DEFAULT NULL,
      default_responsible_role VARCHAR(32) DEFAULT NULL,
      suggested_timing VARCHAR(120) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      applicable_project_types VARCHAR(300) DEFAULT NULL,
      not_applicable_note VARCHAR(300) DEFAULT NULL,
      merge_status VARCHAR(32) DEFAULT NULL,
      is_key_node TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_work_item_template_key (template_key),
      KEY idx_work_item_stage (stage_id, sort_order, is_active),
      KEY idx_work_item_required (required_level, is_active),
      KEY idx_work_item_source (source, default_join, is_active),
      KEY idx_work_item_inspection (requires_inspection, inspection_template_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const [columns] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_work_item_templates'
  `);
  const existingColumns = new Set(columns.map(row => row.COLUMN_NAME));
  const columnAdds = [
    ['parent_template_key', 'ADD COLUMN parent_template_key VARCHAR(80) DEFAULT NULL AFTER stage_id'],
    ['source', "ADD COLUMN source VARCHAR(24) NOT NULL DEFAULT 'recommendation' AFTER required_level"],
    ['default_join', 'ADD COLUMN default_join TINYINT(1) NOT NULL DEFAULT 0 AFTER source'],
    ['applicable_project_types', 'ADD COLUMN applicable_project_types VARCHAR(300) DEFAULT NULL AFTER description'],
    ['not_applicable_note', 'ADD COLUMN not_applicable_note VARCHAR(300) DEFAULT NULL AFTER applicable_project_types'],
    ['merge_status', 'ADD COLUMN merge_status VARCHAR(32) DEFAULT NULL AFTER not_applicable_note'],
    ['is_key_node', 'ADD COLUMN is_key_node TINYINT(1) NOT NULL DEFAULT 0 AFTER merge_status'],
  ];
  for (const [name, clause] of columnAdds) {
    if (!existingColumns.has(name)) {
      await pool.query(`ALTER TABLE renovation_work_item_templates ${clause}`);
    }
  }

  const [indexes] = await pool.query(`
    SELECT INDEX_NAME FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'renovation_work_item_templates'
      AND INDEX_NAME = 'idx_work_item_source'
  `);
  if (!indexes.length) {
    await pool.query(`
      CREATE INDEX idx_work_item_source
      ON renovation_work_item_templates (source, default_join, is_active)
    `);
  }

  for (const item of defaultProgressTemplates()) {
    await pool.query(
      `INSERT INTO renovation_work_item_templates
       (template_key, stage_id, title, required_level, requires_inspection,
        inspection_template_key, default_responsible_role, suggested_timing,
        description, sort_order, source, default_join, parent_template_key,
        is_key_node)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source = COALESCE(NULLIF(source, ''), VALUES(source)),
         default_join = IF(source = 'default', VALUES(default_join), default_join),
         is_key_node = IF(source = 'default', VALUES(is_key_node), is_key_node)`,
      item
    );
  }

  for (const item of workItemTemplates) {
    await pool.query(
      `INSERT INTO renovation_work_item_templates
       (template_key, stage_id, title, required_level, requires_inspection,
        inspection_template_key, default_responsible_role, suggested_timing,
        description, sort_order, source, default_join, is_key_node)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'recommendation', 0, ?)
       ON DUPLICATE KEY UPDATE
         source = COALESCE(NULLIF(source, ''), VALUES(source))`,
      [...item, item[3] === 'core' ? 1 : 0]
    );
  }
}

async function seedProjectInspectionTemplates() {
  const templates = [
    {
      code: 'hidden_water_electric',
      title: '水电隐蔽验收',
      stage_id: 3,
      node_type: 'stage',
      description: '封墙、封地前完成，重点确认水路打压、电路安全、强弱电规范和管线留档。',
      standard_basis: 'GB50327-2023、GB50242、GB50303',
      tools: ['试压泵', '相位检测仪', '漏电开关测试仪', '兆欧表', '卷尺', '强光手电'],
      sort_order: 10,
    },
    {
      code: 'waterproof_tile',
      title: '泥瓦防水验收',
      stage_id: 4,
      node_type: 'stage',
      description: '瓷砖完工、油漆进场前完成，重点确认闭水、防水加强、空鼓、平整度和排水坡度。',
      standard_basis: 'GB50327-2023、GB50210-2018',
      tools: ['空鼓锤', '2米靠尺', '塞尺', '水平仪', '水桶', '乒乓球'],
      sort_order: 20,
    },
    {
      code: 'wood_ceiling_cabinet',
      title: '木工吊顶柜体验收',
      stage_id: 5,
      node_type: 'stage',
      description: '油漆前完成，重点确认吊顶龙骨、石膏板工艺、柜体垂直度、封边和五金使用。',
      standard_basis: 'GB50327-2023、GB50210-2018',
      tools: ['靠尺', '水平尺', '塞缝片', '强光手电', '卷尺'],
      sort_order: 30,
    },
    {
      code: 'paint_wall',
      title: '油漆墙面验收',
      stage_id: 6,
      node_type: 'stage',
      description: '墙面涂饰完成后检查基层、阴阳角、色差、刷痕、流坠、透底和裂纹。',
      standard_basis: 'GB50327-2023、GB50210-2018',
      tools: ['强光手电', '靠尺', '阴阳角尺'],
      sort_order: 40,
    },
    {
      code: 'completion_final',
      title: '竣工总验',
      stage_id: 8,
      node_type: 'final',
      description: '全部安装完成、尾款结算前完成，重点确认门窗、安装、地板、空气质量、资料交付和收尾。',
      standard_basis: 'GB50327-2023、GB50210-2018、GB/T18883',
      tools: ['测电插座检测器', '水桶', '强光手电', '卷尺', '空气检测仪'],
      sort_order: 50,
    },
  ];
  for (const template of templates) {
    await pool.query(
      `INSERT INTO inspection_templates
       (code, title, stage_id, node_type, description, standard_basis,
        applicable_project_types, applicable_methods, recommended_tools, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         stage_id = VALUES(stage_id),
         node_type = VALUES(node_type),
         description = VALUES(description),
         standard_basis = VALUES(standard_basis),
         recommended_tools = VALUES(recommended_tools),
         sort_order = VALUES(sort_order),
         is_active = 1`,
      [
        template.code,
        template.title,
        template.stage_id,
        template.node_type,
        template.description,
        template.standard_basis,
        JSON.stringify(['rough', 'finished', 'office', 'commercial']),
        JSON.stringify(['self', 'company', 'designer']),
        JSON.stringify(template.tools),
        template.sort_order,
      ]
    );
  }

  const [templateRows] = await pool.query(
    'SELECT id, code FROM inspection_templates WHERE code IN (?)',
    [templates.map((item) => item.code)]
  );
  const templateIdByCode = new Map(templateRows.map((row) => [row.code, row.id]));
  const items = [
    ['hidden_water_electric', 'hwe_pressure', '水路打压测试', '稳压1.0MPa，保压30分钟，压降≤0.02MPa，无渗水、接头滴水。', '使用试压泵打压并记录压力变化，拍摄压力表和重点接头。', ['试压泵', '强光手电'], 'must', '隐蔽工程不合格必须整改后复验，未通过前不得封墙封地。', 1, 10],
    ['hidden_water_electric', 'hwe_hot_cold', '冷热水管规范', '冷热水管左热右冷，冷热管间距100-150mm。', '现场核对厨房、卫生间、阳台点位，与施工图比对。', ['卷尺'], 'important', '位置错误或间距明显不合格应整改。', 1, 20],
    ['hidden_water_electric', 'hwe_drainage', '排水通水测试', '全部下水同时放水，排水顺畅，无倒灌、无堵塞，防臭配件齐全。', '厨卫、阳台、洗衣机、台盆下水同步放水观察。', ['水桶'], 'important', '堵塞、倒灌、防臭缺失应整改后复测。', 1, 30],
    ['hidden_water_electric', 'hwe_strong_weak', '强弱电分管分槽', '强弱电平行间距≥30cm，交叉处包金属屏蔽锡纸，禁止同槽。', '沿线槽检查强弱电走向，交叉位置拍照留存。', ['卷尺', '强光手电'], 'must', '强弱电同槽或间距不足应整改。', 1, 40],
    ['hidden_water_electric', 'hwe_socket', '插座和漏保测试', '插座左零右火上接地，漏保30mA，通电0.1秒内跳闸。', '用相位检测仪和漏电开关测试仪逐项检测。', ['相位检测仪', '漏电开关测试仪'], 'must', '接线错误、漏保不动作必须整改。', 1, 50],
    ['hidden_water_electric', 'hwe_photo_archive', '管线拍照留存', '点位高度、数量与施工图误差≤10mm，全屋拍照留存管线图。', '按空间拍摄水电管线全景和重点位置。', ['手机', '卷尺'], 'important', '未留档会影响后续维修和打孔，应补拍记录。', 1, 60],

    ['waterproof_tile', 'wpt_closed_water', '闭水试验', '蓄水深度≥30mm，闭水48小时，楼下顶板、墙角、管根无洇湿、水印。', '标记蓄水高度，满48小时后联合楼下检查。', ['水桶', '卷尺'], 'must', '渗漏必须返工，整改后重新闭水。', 1, 10],
    ['waterproof_tile', 'wpt_waterproof_height', '防水高度和加强', '淋浴区墙面防水≥1.8m，干区墙面≥30cm，管根、阴阳角附加防水。', '检查涂膜范围、管根和门槛石位置。', ['卷尺', '强光手电'], 'important', '漏涂、开裂、加强不足应补做。', 1, 20],
    ['waterproof_tile', 'wpt_hollow', '瓷砖空鼓', '墙砖单块空鼓面积≤5%，地砖≤15%；边角严禁空鼓；单墙面空鼓不超3处。', '用空鼓锤逐块敲击并标记问题区域。', ['空鼓锤', '美纹纸'], 'must', '边角空鼓或大面积空鼓应返工。', 1, 30],
    ['waterproof_tile', 'wpt_flatness', '瓷砖平整度', '2米靠尺缝隙≤3mm，砖缝高低差≤0.5mm。', '用靠尺、塞尺抽检墙地面。', ['2米靠尺', '塞尺'], 'important', '超差明显应整改或返工。', 1, 40],
    ['waterproof_tile', 'wpt_slope', '地漏坡度排水', '厨卫地面地漏坡度≥2%，泼水可自动流向地漏，无积水。', '泼水或放乒乓球观察水流方向和积水。', ['水桶', '乒乓球', '坡度尺'], 'important', '排水不畅、积水应整改坡度。', 1, 50],

    ['wood_ceiling_cabinet', 'wcc_ceiling_keel', '吊顶龙骨和石膏板', '轻钢龙骨，主龙骨间距≤800mm，副龙骨≤300mm；转角整板套割，板间预留3-5mm伸缩缝。', '检查龙骨间距、转角拼接和板缝处理。', ['卷尺', '强光手电'], 'important', '小块拼接、间距不合格易开裂，应整改。', 1, 10],
    ['wood_ceiling_cabinet', 'wcc_ceiling_flat', '吊顶平整和承重', '吊顶平整度误差≤2mm，重型灯具单独承重，无开裂、变形、异响。', '靠尺检查平整度，确认重型灯具加固点。', ['靠尺', '水平仪'], 'important', '承重不足或变形应加固整改。', 1, 20],
    ['wood_ceiling_cabinet', 'wcc_cabinet_vertical', '柜体垂直和门缝', '柜体垂直度误差≤2mm，柜门缝隙均匀1-2mm。', '用水平尺、塞缝片检查柜体、柜门。', ['水平尺', '塞缝片'], 'normal', '明显歪斜或门缝不均应调校。', 1, 30],
    ['wood_ceiling_cabinet', 'wcc_hardware', '柜体五金和封边', '铰链、抽屉推拉顺滑无卡顿、无异响；封边完整无开胶、崩边。', '逐个开合抽屉柜门，检查封边和背板。', ['强光手电'], 'normal', '五金异常、封边破损应更换或修补。', 1, 40],

    ['paint_wall', 'pw_base', '墙面基层', '墙面基层无空鼓、掉粉、开裂、沙眼；阴阳角顺直方正。', '手摸、侧光、靠尺和阴阳角尺检查。', ['强光手电', '靠尺', '阴阳角尺'], 'important', '基层问题应修补后复验。', 1, 10],
    ['paint_wall', 'pw_surface', '涂饰观感', '手电筒侧光照射，墙面无波浪凹凸、刷痕、流坠、透底。', '关主灯侧光检查大面墙和修补区域。', ['强光手电'], 'normal', '明显刷痕、流坠、透底应修补。', 1, 20],
    ['paint_wall', 'pw_color', '色差和掉粉', '同墙面无色差，漆膜硬度达标，手摸不掉粉。', '自然光和侧光下观察，手摸检查。', ['强光手电'], 'normal', '色差明显或掉粉应修补重涂。', 1, 30],

    ['completion_final', 'cf_doors_windows', '门窗工程', '开合顺畅，密封胶完整无开裂，关闭后不漏风、不渗水；玻璃五金无划痕锈蚀。', '逐樘开关门窗，检查密封、锁具和玻璃。', ['强光手电'], 'important', '渗水、漏风、锁具松动应整改。', 1, 10],
    ['completion_final', 'cf_installation', '安装工程', '橱柜水平垂直，台面无裂纹；卫浴稳固不晃动；龙头出水顺畅无渗漏；灯具插座通电正常。', '逐项开关、放水、通电测试。', ['测电插座检测器', '水桶', '水平尺'], 'important', '漏水、漏电、安装松动必须整改。', 1, 20],
    ['completion_final', 'cf_floor', '地板验收', '踩踏无空洞异响，缝隙均匀，无起拱、起翘、明显色差。', '全屋行走踩踏，检查边角和收口。', ['强光手电'], 'normal', '起拱、起翘、明显异响应返工或修补。', 1, 30],
    ['completion_final', 'cf_air', '室内空气验收', '密闭12小时检测，甲醛≤0.07mg/m³，TVOC≤0.45mg/m³，苯、甲苯达标。', '按检测要求密闭后采样，保留检测报告。', ['甲醛TVOC检测仪', '温湿度计'], 'important', '超标应治理或更换污染源材料，复测合格后入住。', 1, 40],
    ['completion_final', 'cf_documents', '资料交付和收尾', '水电竣工图、质保卡、材料合格证交付；全屋无垃圾、划痕、破损。', '核对资料清单，现场巡检收尾问题。', ['手机', '验收记录表'], 'important', '资料缺失或收尾问题应列明整改期限。', 1, 50],
  ];

  for (const [templateCode, code, title, standard, method, tools, risk, action, photo, sort] of items) {
    const templateId = templateIdByCode.get(templateCode);
    if (!templateId) continue;
    await pool.query(
      `INSERT INTO inspection_template_items
       (template_id, code, title, standard_text, check_method, required_tools,
        risk_level, failure_action, require_photo, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         template_id = VALUES(template_id),
         title = VALUES(title),
         standard_text = VALUES(standard_text),
         check_method = VALUES(check_method),
         required_tools = VALUES(required_tools),
         risk_level = VALUES(risk_level),
         failure_action = VALUES(failure_action),
         require_photo = VALUES(require_photo),
         sort_order = VALUES(sort_order),
         is_active = 1`,
      [
        templateId,
        code,
        title,
        standard,
        method,
        JSON.stringify(tools),
        risk,
        action,
        photo,
        sort,
      ]
    );
  }
}

async function ensureProjectActionTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_action_items (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      created_by BIGINT UNSIGNED NOT NULL,
      content TEXT NOT NULL,
      due_date DATE NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_action_project_status (project_id, status, due_date),
      KEY idx_action_creator (created_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_action_item_assignees (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      item_id BIGINT UNSIGNED NOT NULL,
      user_id BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_action_item_user (item_id, user_id),
      KEY idx_action_assignee_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_action_item_feedback (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      item_id BIGINT UNSIGNED NOT NULL,
      submitted_by BIGINT UNSIGNED NOT NULL,
      result VARCHAR(32) NOT NULL,
      content TEXT DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_action_feedback_item (item_id, created_at),
      KEY idx_action_feedback_submitter (submitted_by, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_action_item_media (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      item_id BIGINT UNSIGNED NOT NULL,
      feedback_id BIGINT UNSIGNED DEFAULT NULL,
      media_type VARCHAR(16) NOT NULL DEFAULT 'image',
      media_url VARCHAR(500) NOT NULL,
      uploaded_by BIGINT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_action_media_item (item_id),
      KEY idx_action_media_feedback (feedback_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_action_notifications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      item_id BIGINT UNSIGNED NOT NULL,
      recipient_id BIGINT UNSIGNED NOT NULL,
      event_type VARCHAR(32) NOT NULL,
      delivery_status VARCHAR(32) NOT NULL DEFAULT 'pending',
      payload JSON DEFAULT NULL,
      read_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_action_notification_recipient (recipient_id, read_at, created_at),
      KEY idx_action_notification_item (item_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [readColumns] = await pool.query(`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_action_notifications'
      AND COLUMN_NAME = 'read_at'
  `);
  if (!readColumns.length) {
    await pool.query(`
      ALTER TABLE project_action_notifications
      ADD COLUMN read_at TIMESTAMP NULL DEFAULT NULL AFTER payload
    `);
  }
}

async function ensureProjectInfoChangeRequestTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_info_change_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      requester_id BIGINT UNSIGNED NOT NULL,
      status TINYINT UNSIGNED NOT NULL DEFAULT 0,
      proposed_changes JSON NOT NULL,
      reviewer_id BIGINT UNSIGNED DEFAULT NULL,
      review_message VARCHAR(300) DEFAULT NULL,
      reviewed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_project_info_change_project (project_id, status, updated_at),
      KEY idx_project_info_change_requester (requester_id, status, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureProjectSpaceChangeRequestTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_space_change_requests (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      requester_id BIGINT UNSIGNED NOT NULL,
      action_type VARCHAR(32) NOT NULL,
      payload JSON NOT NULL,
      status TINYINT UNSIGNED NOT NULL DEFAULT 0,
      reviewer_id BIGINT UNSIGNED DEFAULT NULL,
      review_message VARCHAR(300) DEFAULT NULL,
      reviewed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_space_change_project (project_id, status, updated_at),
      KEY idx_space_change_requester (requester_id, status, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureProjectCaseShareTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_case_shares (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      project_id BIGINT UNSIGNED NOT NULL,
      designer_id BIGINT UNSIGNED NOT NULL,
      owner_id BIGINT UNSIGNED NOT NULL,
      title VARCHAR(80) NOT NULL,
      style VARCHAR(40) DEFAULT NULL,
      summary VARCHAR(500) DEFAULT NULL,
      highlights VARCHAR(500) DEFAULT NULL,
      image_urls JSON NOT NULL,
      visible_fields JSON NOT NULL,
      status TINYINT UNSIGNED NOT NULL DEFAULT 0,
      reviewer_id BIGINT UNSIGNED DEFAULT NULL,
      review_message VARCHAR(300) DEFAULT NULL,
      reviewed_at DATETIME DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_case_share_project (project_id, status, updated_at),
      KEY idx_case_share_designer (designer_id, status, updated_at),
      KEY idx_case_share_owner (owner_id, status, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureUserAdminStatusColumn() {
  const [columns] = await pool.query(`
    SELECT COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'users'
      AND COLUMN_NAME = 'admin_status'
  `);
  if (columns.length > 0) return;
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN admin_status ENUM('pending', 'approved', 'rejected')
        NOT NULL DEFAULT 'approved' AFTER role,
      ADD INDEX idx_admin_status (admin_status, created_at)
  `);
}

async function ensureProjectTipsTable() {
  const defaultTips = [
    ['stage', '阶段建议', '提前确认主材到货时间，避免施工等待。', 10, 1],
    ['general', '装修小贴士', '水电验收时拍照存档，方便日后维修定位。', 20, 1],
    ['general', '装修小贴士', '防水闭水试验建议保持至少 48 小时。', 30, 1],
    ['function_intro', '项目概览说明', '这里汇总项目档案、进度和验收信息，帮助你快速了解项目当前情况。你可以邀请设计师、项目经理一起协作，让装修过程更清楚、更好推进。', 40, 1],
  ];
  await pool.query(`
    CREATE TABLE IF NOT EXISTS project_tips (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      type VARCHAR(32) NOT NULL DEFAULT 'general',
      title VARCHAR(80) NOT NULL,
      content TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_project_tips_active_sort (is_active, sort_order, id),
      KEY idx_project_tips_type (type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [contentColumns] = await pool.query(`
    SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'project_tips'
      AND COLUMN_NAME = 'content'
  `);
  const contentColumn = contentColumns[0];
  if (
    contentColumn &&
    contentColumn.DATA_TYPE !== 'text' &&
    Number(contentColumn.CHARACTER_MAXIMUM_LENGTH || 0) < 1000
  ) {
    await pool.query('ALTER TABLE project_tips MODIFY COLUMN content TEXT NOT NULL');
  }
  const [[row]] = await pool.query('SELECT COUNT(*) AS total FROM project_tips');
  if (Number(row.total) === 0) {
    await pool.query(
      `INSERT INTO project_tips (type, title, content, sort_order, is_active)
       VALUES ${defaultTips.map(() => '(?, ?, ?, ?, ?)').join(', ')}`,
      defaultTips.flat()
    );
    return;
  }
  const [tips] = await pool.query(
    `SELECT id, title, content
     FROM project_tips
     WHERE is_active = 1
     ORDER BY sort_order ASC, id ASC
     LIMIT 3`
  );
  const hasGarbledTips = tips.some((tip) =>
    /[ÃÂâèäåæçé�]/.test(`${tip.title || ''}${tip.content || ''}`)
  );
  const [[functionIntro]] = await pool.query(
    `SELECT id FROM project_tips
     WHERE type = 'function_intro'
     LIMIT 1`
  );
  if (!functionIntro) {
    await pool.query(
      `INSERT INTO project_tips (type, title, content, sort_order, is_active)
       VALUES (?, ?, ?, ?, ?)`,
      defaultTips[3]
    );
  }
  if (!hasGarbledTips) return;
  for (let index = 0; index < defaultTips.length; index += 1) {
    const existing = tips[index];
    const values = defaultTips[index];
    if (existing) {
      await pool.query(
        `UPDATE project_tips
         SET type = ?, title = ?, content = ?, sort_order = ?, is_active = ?
         WHERE id = ?`,
        [...values, existing.id]
      );
    } else {
      await pool.query(
        `INSERT INTO project_tips (type, title, content, sort_order, is_active)
         VALUES (?, ?, ?, ?, ?)`,
        values
      );
    }
  }
}

async function ensureHelpFeedbackTables() {
  const defaultFaqs = [
    ['如何修改装修阶段？', '进入装修日志后，在项目进度或阶段相关入口中查看当前阶段。阶段变更涉及项目进度，建议由业主和项目成员确认后操作。', 10, 1],
    ['工地打卡会公开吗？', '默认不会自动公开到装修圈。只有你主动发布或选择分享的内容，才会作为公开内容展示。', 20, 1],
    ['如何更换绑定的设计师？', '进入我的工地或项目成员管理，先解除原设计师关系，再邀请新的设计师加入项目。', 30, 1],
  ];
  await pool.query(`
    CREATE TABLE IF NOT EXISTS help_faqs (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      question VARCHAR(120) NOT NULL,
      answer TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_help_faq_active_sort (is_active, sort_order, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id BIGINT UNSIGNED DEFAULT NULL,
      content TEXT NOT NULL,
      contact VARCHAR(80) DEFAULT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_user_feedback_status_time (status, created_at),
      KEY idx_user_feedback_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  const [[row]] = await pool.query('SELECT COUNT(*) AS total FROM help_faqs');
  if (Number(row.total) === 0) {
    await pool.query(
      `INSERT INTO help_faqs (question, answer, sort_order, is_active)
       VALUES ${defaultFaqs.map(() => '(?, ?, ?, ?)').join(', ')}`,
      defaultFaqs.flat()
    );
  }
}

module.exports = pool;
