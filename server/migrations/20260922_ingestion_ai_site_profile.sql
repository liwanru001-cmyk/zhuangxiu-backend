SET @add_ingestion_ai_profile = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_sources' AND COLUMN_NAME='ai_analysis_profile')=0,
  'ALTER TABLE product_ingestion_sources ADD COLUMN ai_analysis_profile JSON DEFAULT NULL AFTER adapter_key, ADD COLUMN ai_analysis_updated_at DATETIME DEFAULT NULL AFTER ai_analysis_profile',
  'SELECT 1'
);
PREPARE stmt FROM @add_ingestion_ai_profile; EXECUTE stmt; DEALLOCATE PREPARE stmt;
