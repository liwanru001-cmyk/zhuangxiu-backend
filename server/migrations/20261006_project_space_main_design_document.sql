SET @addMainDesignDocument = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_spaces'
     AND COLUMN_NAME = 'main_design_document_id') = 0,
  'ALTER TABLE project_spaces ADD COLUMN main_design_document_id BIGINT UNSIGNED DEFAULT NULL AFTER is_default, ADD KEY idx_space_main_design_document (main_design_document_id)',
  'SELECT 1'
);
PREPARE stmt FROM @addMainDesignDocument;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addMainDesignDocumentForeignKey = IF(
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'project_spaces'
     AND CONSTRAINT_NAME = 'fk_space_main_design_document') = 0,
  'ALTER TABLE project_spaces ADD CONSTRAINT fk_space_main_design_document FOREIGN KEY (main_design_document_id) REFERENCES project_design_documents(id) ON DELETE SET NULL',
  'SELECT 1'
);
PREPARE stmt FROM @addMainDesignDocumentForeignKey;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
