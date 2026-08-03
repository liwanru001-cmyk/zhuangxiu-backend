const db = require('../config/db');

const ProjectEventType = Object.freeze({
  DESIGN_DOCUMENT_CONFIRMED: 'DESIGN_DOCUMENT_CONFIRMED',
  DESIGN_DOCUMENT_REVISION_REQUESTED: 'DESIGN_DOCUMENT_REVISION_REQUESTED',
  DESIGN_HANDOVER_CONFIRMED: 'DESIGN_HANDOVER_CONFIRMED',
  DESIGN_HANDOVER_REVISION_REQUESTED: 'DESIGN_HANDOVER_REVISION_REQUESTED',
  PROGRESS_ITEM_UPDATED: 'PROGRESS_ITEM_UPDATED',
  PROGRESS_CHANGE_SUBMITTED: 'PROGRESS_CHANGE_SUBMITTED',
  PROGRESS_CHANGE_APPROVED: 'PROGRESS_CHANGE_APPROVED',
  PROGRESS_CHANGE_REJECTED: 'PROGRESS_CHANGE_REJECTED',
  INSPECTION_REWORK_REQUIRED: 'INSPECTION_REWORK_REQUIRED',
  INSPECTION_PASSED: 'INSPECTION_PASSED',
  INSPECTION_STEP_CHECK_REQUESTED: 'INSPECTION_STEP_CHECK_REQUESTED',
  INSPECTION_STEP_SUBMITTED: 'INSPECTION_STEP_SUBMITTED',
  INSPECTION_STEP_REWORK_SUBMITTED: 'INSPECTION_STEP_REWORK_SUBMITTED',
  SITE_CHECK_IN_SHARED: 'SITE_CHECK_IN_SHARED',
});

async function emitProjectEvent(eventType, payload, executor = db) {
  if (!Object.values(ProjectEventType).includes(eventType)) {
    throw new Error(`Unsupported project event type: ${eventType}`);
  }

  const projectId = Number(payload.projectId);
  const actorId = Number(payload.actorId);
  const recipients = [
    ...new Set(
      (payload.targetUserIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0 && id !== actorId)
    ),
  ];

  if (!projectId || !recipients.length) return { inserted: 0 };

  const notificationPayload = {
    source: 'project_event',
    projectEventType: eventType,
    project_id: projectId,
    projectId,
    actorId,
    entityType: payload.entityType,
    entityId: payload.entityId,
    title: payload.title,
    content: payload.content,
    route: payload.route || null,
    deepLink: payload.deepLink || null,
    detailData: payload.detailData || null,
  };

  try {
    await executor.query(
      `INSERT INTO project_action_notifications
         (item_id, recipient_id, event_type, delivery_status, payload)
       VALUES ${recipients.map(() => "(NULL, ?, 'project_event', 'pending', ?)").join(', ')}`,
      recipients.flatMap((recipientId) => [
        recipientId,
        JSON.stringify(notificationPayload),
      ])
    );
  } catch (error) {
    console.error('project event notification failed', {
      eventType,
      projectId,
      actorId,
      recipientCount: recipients.length,
      code: error.code,
      message: error.message,
    });
    return { inserted: 0, failed: true };
  }

  return { inserted: recipients.length };
}

module.exports = {
  ProjectEventType,
  emitProjectEvent,
};
