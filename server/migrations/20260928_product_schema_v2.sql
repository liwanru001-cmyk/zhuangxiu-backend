-- Product Schema v2 keeps the canonical document in existing JSON payloads.
-- Only the schema discriminator and structured correction payload need indexed
-- columns; legacy v1 payloads remain readable without destructive rewriting.
SET @ddl = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates')=1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates' AND COLUMN_NAME='product_schema_version')=0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN product_schema_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER normalized_payload, ADD KEY idx_ingestion_product_schema (product_schema_version,id)', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_versions')=1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_versions' AND COLUMN_NAME='product_schema_version')=0,
  'ALTER TABLE public_product_library_versions ADD COLUMN product_schema_version INT UNSIGNED NOT NULL DEFAULT 1 AFTER product_payload, ADD KEY idx_public_product_schema (product_schema_version,id)', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_site_rule_feedback')=1 AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_site_rule_feedback' AND COLUMN_NAME='issues')=0,
  'ALTER TABLE product_ingestion_site_rule_feedback ADD COLUMN issues JSON NULL AFTER error_types', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
