// Creation ownership never implies the business role "owner" (the client).
function isIndependentProjectManager(project, userId, memberRole) {
  return project?.creation_source === 'designer'
    && Number(project.created_by) === Number(userId)
    && memberRole === 'designer';
}

async function canManageProjectPreparation(db, projectId, userId) {
  const [rows] = await db.query(
    `SELECT p.created_by, p.creation_source, pm.role
     FROM renovation_projects p
     JOIN project_members pm ON pm.project_id = p.id
       AND pm.user_id = ? AND pm.status = 1
     WHERE p.id = ? AND COALESCE(p.lifecycle_status, 'active') = 'active'`,
    [userId, projectId]
  );
  return rows.some(row => isIndependentProjectManager(row, userId, row.role));
}

module.exports = { isIndependentProjectManager, canManageProjectPreparation };
