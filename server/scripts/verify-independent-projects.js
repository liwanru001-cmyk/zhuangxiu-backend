// Run only against a disposable, socket-only MySQL instance initialized under /tmp.
// node scripts/verify-independent-projects.js /tmp/zxw-project-mysql.XXXXXX/mysql.sock
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const mysql = require('mysql2/promise');

async function main() {
  const socketPath = process.argv[2];
  if (!/^\/tmp\/zxw-project-mysql\.[\w]+\/mysql\.sock$/.test(socketPath || '')) {
    throw new Error('An explicit disposable /tmp/zxw-project-mysql.*/mysql.sock is required; business database settings are never used.');
  }
  const database = `zxw_independent_verify_${process.pid}`;
  const admin = await mysql.createConnection({ socketPath, user: 'root', multipleStatements: true });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4`);
    db = mysql.createPool({ socketPath, user: 'root', database, multipleStatements: true, dateStrings: ['DATE'] });
    const init = fs.readFileSync(path.join(__dirname, '../../db/init.sql'), 'utf8');
    for (const table of ['users', 'renovation_projects', 'project_members', 'renovation_tasks', 'project_spaces', 'project_space_images']) {
      let ddl = init.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?;`))[0];
      if (table === 'renovation_projects') {
        // Reconstruct the prior NOT NULL schema to test migration, not just fresh creation.
        ddl = ddl.replace(/^\s*(created_by|creation_source|preparation_stage|client_name) .*\n/gm, '')
          .replace('user_id BIGINT UNSIGNED DEFAULT NULL', 'user_id BIGINT UNSIGNED NOT NULL')
          .replace('start_date DATE DEFAULT NULL', 'start_date DATE NOT NULL');
      }
      await db.query(ddl);
    }
    await db.query("INSERT INTO users (id, phone, nickname, role) VALUES (7, '13800000007', '测试设计师', 'designer'), (8, '13800000008', '测试业主', 'owner'), (9, '13800000009', '其他用户', 'owner')");
    await db.query("INSERT INTO renovation_projects (id, user_id, project_code, house_area, start_date) VALUES (1, 8, 'AA00000001', 90, '2026-09-01')");
    await db.query("ALTER TABLE renovation_projects ADD project_name VARCHAR(10) NOT NULL DEFAULT '装修项目'");
    for (const migration of ['20260618_project_archive_fields.sql', '20260628_project_lifecycle_status.sql']) {
      await db.query(fs.readFileSync(path.join(__dirname, '../migrations', migration), 'utf8'));
    }
    const schema = require('../services/independent-project-schema');
    await assert.rejects(schema.assertSchema(db), /migration required/);
    // Simulate interrupted DDL, then resume and rerun on one connection.
    await db.query('ALTER TABLE renovation_projects ADD COLUMN created_by BIGINT UNSIGNED DEFAULT NULL');
    const migrationConnection = await db.getConnection();
    try {
      await schema.migrate(migrationConnection);
      await schema.migrate(migrationConnection);
      await schema.assertSchema(migrationConnection);
    } finally { migrationConnection.release(); }
    const [[legacy]] = await db.query('SELECT * FROM renovation_projects WHERE id = 1');
    assert.equal(legacy.user_id, 8);
    assert.equal(legacy.creation_source, 'owner');
    assert.equal(legacy.start_date, '2026-09-01');

    for (const migration of [
      '20260618_project_design_documents.sql', '20260627_design_document_versions_and_disclosures.sql',
      '20260627_design_document_storage_preview_fields.sql', '20260814_project_design_document_categories.sql',
      '20260627_project_design_document_revision_requests.sql', '20260804_project_design_document_delete_requests.sql',
    ]) await db.query(fs.readFileSync(path.join(__dirname, '../migrations', migration), 'utf8'));
    await db.query('ALTER TABLE project_design_documents ADD upload_batch_id VARCHAR(80), ADD upload_batch_title VARCHAR(120)');
    const dbPath = require.resolve('../config/db');
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    const independent = require('../controllers/independent-projects.controller');
    const renovation = require('../controllers/renovation.controller');
    const context = require('../utils/project-context');
    function request(projectId, body = {}, userId = 7, params = {}) {
      return { headers: { 'x-zxw-projects': 'independent-desktop-v1' }, user: { id: userId, role: userId === 7 ? 'designer' : 'owner' }, params: { id: String(projectId), ...params }, body: { project_id: projectId, ...body }, query: {}, protocol: 'http', get: () => 'localhost' };
    }
    async function invoke(fn, req, expectedStatus = 200) {
      const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await fn(req, res);
      assert.equal(res.statusCode, expectedStatus, JSON.stringify(res.body));
      return res.body?.data;
    }
    const created = await invoke(independent.create, request(null, { project_name: '前期测试' }));
    const id = created.id;
    const [[project]] = await db.query('SELECT * FROM renovation_projects WHERE id = ?', [id]);
    assert.equal(project.user_id, null);
    assert.equal(project.start_date, null);
    assert.equal(project.created_by, 7);
    const [[tasks]] = await db.query('SELECT COUNT(*) AS total FROM renovation_tasks WHERE project_id = ?', [id]);
    assert.equal(tasks.total, 0);
    const listed = await invoke(renovation.getMyProjects, request(id));
    assert.ok(listed.some(p => p.id === id && p.owner_joined === 0));
    const oldRequest = request(id);
    delete oldRequest.headers;
    assert.deepEqual(await invoke(renovation.getMyProjects, oldRequest), []);
    const rollout = require('../services/independent-project-rollout');
    await invoke((req, res) => rollout.legacyProjectGate(req, res, () => { throw new Error('Legacy scoped access escaped gate'); }), oldRequest, 409);
    const detail = await invoke(renovation.getProjectDetail, request(id));
    assert.equal(detail.project.can_manage_preparation, true);
    assert.equal(detail.project.member_role, 'designer');
    await invoke(renovation.updateProjectInfo, request(id, { style_preference: '原木风', client_name: '王女士' }));
    const space = await invoke(renovation.createProjectSpace, request(id, { name: '书房' }));
    await invoke(renovation.updateProjectSpace, request(id, { name: '儿童房' }, 7, { spaceId: String(space.id) }));
    const doc = await invoke(renovation.createProjectDesignDocument, request(id, {
      category: 'layout_plan', space_key: String(space.id), title: '平面图',
      file_url: 'https://example.invalid/test-plan.pdf', file_type: 'pdf',
    }));
    const v2 = await invoke(renovation.createProjectDesignDocument, request(id, {
      category: 'layout_plan', space_key: String(space.id), title: '平面图新版',
      file_url: 'https://example.invalid/test-plan-v2.pdf', file_type: 'pdf', version_group_id: doc.version_group_id,
    }));
    assert.equal(v2.version_no, 2);
    await invoke(renovation.deleteProjectDesignDocument, request(id, {}, 7, { documentId: String(v2.id) }));
    await invoke(renovation.deleteProjectDesignDocument, request(id, {}, 7, { documentId: String(doc.id) }));
    await invoke(renovation.deleteProjectSpace, request(id, {}, 7, { spaceId: String(space.id) }));
    // Reject nonmember access without running company-admin fallback queries.
    const deniedRes = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    const denied = await context.requireProjectContext(request(id, {}, 9), deniedRes);
    assert.equal(denied.ok, false);
    const legacyOwnerList = await invoke(renovation.getProjects, { ...request(id, {}, 8), headers: {} });
    assert.deepEqual(legacyOwnerList.projects.map(p => p.id), [1]);
    const invitation = await invoke(independent.inviteOwner, request(id, { phone: '13800000008' }));
    await invoke(independent.respondInvitation, request(id, { action: 'accept' }, 8, { invitationId: String(invitation.id) }));
    const oldOwnerList = await invoke(renovation.getProjects, { ...request(id, {}, 8), headers: {} });
    assert.deepEqual(oldOwnerList.projects.map(p => p.id), [1]);
    const [[joined]] = await db.query('SELECT * FROM renovation_projects WHERE id = ?', [id]);
    assert.equal(joined.user_id, 8);
    assert.equal(joined.created_by, 7);
    assert.equal(joined.client_name, '王女士');
    assert.equal(joined.style_preference, '原木风');
    const ownerProjects = await invoke(renovation.getProjects, request(id, {}, 8));
    assert.ok(ownerProjects.projects.some(p => p.id === id));
    const ownerDetail = await invoke(renovation.getProjectDetail, request(id, {}, 8));
    assert.equal(ownerDetail.project.member_role, 'owner');
    assert.equal((await invoke(renovation.getProjectDetail, request(id))).project.can_manage_preparation, true);
    console.log('PASS: repeatable legacy migration; name-only project; list/detail; partial needs; space create/rename/delete; document V1/V2 and deletion; nonmember isolation; owner invitation/acceptance and original project retention.');
  } finally {
    if (db) await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
