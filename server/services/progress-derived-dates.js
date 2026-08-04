function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

async function recomputeProjectProgressDerivedDates(executor, projectId) {
  const [items] = await executor.query(
    `SELECT id, task_id, parent_id, planned_start, planned_end
     FROM project_progress_items
     WHERE project_id = ?`,
    [projectId]
  );
  if (!items.length) return;

  const byId = new Map(items.map((item) => [Number(item.id), item]));
  const childrenByParent = new Map();
  for (const item of items) {
    if (!item.parent_id) continue;
    const parentId = Number(item.parent_id);
    if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
    childrenByParent.get(parentId).push(item);
  }

  const depthByItem = new Map();
  const depthOf = (item) => {
    const itemId = Number(item.id);
    if (depthByItem.has(itemId)) return depthByItem.get(itemId);
    const parent = item.parent_id ? byId.get(Number(item.parent_id)) : null;
    const depth = parent ? depthOf(parent) + 1 : 0;
    depthByItem.set(itemId, depth);
    return depth;
  };
  const parents = items
    .filter((item) => childrenByParent.has(Number(item.id)))
    .sort((left, right) => depthOf(right) - depthOf(left));

  for (const parent of parents) {
    const children = childrenByParent.get(Number(parent.id)) || [];
    const starts = children.map((child) => dateOnly(child.planned_start)).filter(Boolean);
    const ends = children.map((child) => dateOnly(child.planned_end)).filter(Boolean);
    const plannedStart = starts.length ? starts.sort()[0] : dateOnly(parent.planned_start);
    const plannedEnd = ends.length ? ends.sort().at(-1) : dateOnly(parent.planned_end);
    parent.planned_start = plannedStart;
    parent.planned_end = plannedEnd;
    await executor.query(
      `UPDATE project_progress_items
       SET planned_start = ?, planned_end = ?
       WHERE id = ? AND project_id = ?`,
      [plannedStart || null, plannedEnd || null, parent.id, projectId]
    );
  }

  const rootsByTask = new Map();
  for (const item of items) {
    if (item.parent_id || !item.task_id) continue;
    const taskId = Number(item.task_id);
    if (!rootsByTask.has(taskId)) rootsByTask.set(taskId, []);
    rootsByTask.get(taskId).push(item);
  }
  for (const [taskId, roots] of rootsByTask.entries()) {
    const starts = roots.map((item) => dateOnly(item.planned_start)).filter(Boolean);
    const ends = roots.map((item) => dateOnly(item.planned_end)).filter(Boolean);
    if (!starts.length && !ends.length) continue;
    const fields = [];
    const params = [];
    if (starts.length) {
      fields.push('planned_start = ?');
      params.push(starts.sort()[0]);
    }
    if (ends.length) {
      fields.push('planned_end = ?');
      params.push(ends.sort().at(-1));
    }
    params.push(taskId, projectId);
    await executor.query(
      `UPDATE renovation_tasks SET ${fields.join(', ')}
       WHERE id = ? AND project_id = ?`,
      params
    );
  }
}

module.exports = { recomputeProjectProgressDerivedDates };
