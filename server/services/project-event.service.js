const db = require('../config/db');

const ProjectEventType = Object.freeze({
  DESIGN_DOCUMENT_CONFIRMED: 'DESIGN_DOCUMENT_CONFIRMED',
  DESIGN_DOCUMENT_REVISION_REQUESTED: 'DESIGN_DOCUMENT_REVISION_REQUESTED',
  DESIGN_HANDOVER_CONFIRMED: 'DESIGN_HANDOVER_CONFIRMED',
  DESIGN_HANDOVER_REVISION_REQUESTED: 'DESIGN_HANDOVER_REVISION_REQUESTED',
  PROGRESS_ITEM_UPDATED: 'PROGRESS_ITEM_UPDATED',
  INSPECTION_REWORK_REQUIRED: 'INSPECTION_REWORK_REQUIRED',
  INSPECTION_PASSED: 'INSPECTION_PASSED',
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
  };

  await executor.query(
    `INSERT INTO project_action_notifications
       (item_id, recipient_id, event_type, delivery_status, payload)
     VALUES ${recipients.map(() => "(NULL, ?, 'project_event', 'pending', ?)").join(', ')}`,
    recipients.flatMap((recipientId) => [
      recipientId,
      JSON.stringify(notificationPayload),
    ])
  );

  return { inserted: recipients.length };
}

module.exports = {
  ProjectEventType,
  emitProjectEvent,
};
