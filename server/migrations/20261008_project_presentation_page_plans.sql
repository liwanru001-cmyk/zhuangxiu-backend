SET @addPresentationPagePlan = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_presentation_documents'
     AND COLUMN_NAME = 'page_plan_json') = 0,
  'ALTER TABLE project_presentation_documents ADD COLUMN page_plan_json LONGTEXT NULL AFTER document_json, ADD COLUMN page_plan_version INT NOT NULL DEFAULT 1 AFTER page_plan_json, ADD COLUMN page_plan_updated_by BIGINT UNSIGNED NULL AFTER page_plan_version',
  'SELECT 1'
);
PREPARE stmt FROM @addPresentationPagePlan;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addPresentationPagePlanUpdaterIndex = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_presentation_documents'
     AND INDEX_NAME = 'idx_presentation_page_plan_updater') = 0,
  'ALTER TABLE project_presentation_documents ADD KEY idx_presentation_page_plan_updater (page_plan_updated_by)',
  'SELECT 1'
);
PREPARE stmt FROM @addPresentationPagePlanUpdaterIndex;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
