ALTER TABLE project_handovers
  MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'pending_confirm';

UPDATE project_handovers
SET status = 'pending_confirm'
WHERE status = 'pending';

UPDATE project_handovers
SET status = 'revision_needed'
WHERE status = 'needs_supplement';
