CREATE TABLE IF NOT EXISTS public_product_library_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  content_hash CHAR(64) NOT NULL,
  storage_uri VARCHAR(1000) NOT NULL,
  original_url VARCHAR(1000) NOT NULL,
  content_type VARCHAR(120) NOT NULL,
  byte_size BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_public_asset_hash (content_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @addIngestionAssetHosts = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_sources'
     AND COLUMN_NAME='allowed_asset_hosts') = 0,
  'ALTER TABLE product_ingestion_sources ADD COLUMN allowed_asset_hosts JSON DEFAULT NULL AFTER allowed_hosts',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionAssetHosts;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS public_product_library_version_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id BIGINT UNSIGNED NOT NULL,
  asset_id BIGINT UNSIGNED NOT NULL,
  asset_role VARCHAR(80) NOT NULL,
  payload_path VARCHAR(500) NOT NULL,
  original_url VARCHAR(1000) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_public_version_asset_path (version_id, payload_path),
  KEY idx_public_version_asset (asset_id, version_id),
  CONSTRAINT fk_public_version_asset_version FOREIGN KEY (version_id)
    REFERENCES public_product_library_versions(id),
  CONSTRAINT fk_public_version_asset_file FOREIGN KEY (asset_id)
    REFERENCES public_product_library_assets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @addPublicVersionAssetStatus = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_versions'
     AND COLUMN_NAME='asset_status') = 0,
  "ALTER TABLE public_product_library_versions ADD COLUMN asset_status VARCHAR(20) NOT NULL DEFAULT 'pending' AFTER product_payload",
  'SELECT 1'
);
PREPARE stmt FROM @addPublicVersionAssetStatus;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addPublicVersionAssetCount = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_versions'
     AND COLUMN_NAME='asset_count') = 0,
  'ALTER TABLE public_product_library_versions ADD COLUMN asset_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER asset_status',
  'SELECT 1'
);
PREPARE stmt FROM @addPublicVersionAssetCount;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addPublicVersionAssetsArchivedAt = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_versions'
     AND COLUMN_NAME='assets_archived_at') = 0,
  'ALTER TABLE public_product_library_versions ADD COLUMN assets_archived_at DATETIME DEFAULT NULL AFTER asset_count',
  'SELECT 1'
);
PREPARE stmt FROM @addPublicVersionAssetsArchivedAt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemeProductSourceType = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='source_type') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN source_type VARCHAR(24) DEFAULT NULL AFTER personal_product_id',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemeProductSourceType;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @backfillSchemeProductSourceType = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='source_type') = 1,
  "UPDATE project_scheme_products SET source_type=CASE WHEN personal_product_id IS NOT NULL THEN 'personal' ELSE 'merchant' END WHERE source_type IS NULL OR source_type=''",
  'SELECT 1'
);
PREPARE stmt FROM @backfillSchemeProductSourceType;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @requireSchemeProductSourceType = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='source_type') = 1,
  "ALTER TABLE project_scheme_products MODIFY source_type VARCHAR(24) NOT NULL DEFAULT 'merchant'",
  'SELECT 1'
);
PREPARE stmt FROM @requireSchemeProductSourceType;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemePublicProduct = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='public_product_id') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN public_product_id BIGINT UNSIGNED DEFAULT NULL AFTER source_type, ADD KEY idx_scheme_public_product (public_product_id)',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemePublicProduct;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemePublicVersion = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='public_product_version_id') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN public_product_version_id BIGINT UNSIGNED DEFAULT NULL AFTER public_product_id, ADD KEY idx_scheme_public_version (public_product_version_id)',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemePublicVersion;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemePublicConfiguration = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='public_product_configuration_id') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN public_product_configuration_id BIGINT UNSIGNED DEFAULT NULL AFTER public_product_version_id, ADD KEY idx_scheme_public_configuration (public_product_configuration_id)',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemePublicConfiguration;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemePublicConfigurationKey = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='public_configuration_key') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN public_configuration_key VARCHAR(80) DEFAULT NULL AFTER public_product_configuration_id',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemePublicConfigurationKey;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemeProductSnapshot = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='product_snapshot') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN product_snapshot JSON DEFAULT NULL AFTER public_configuration_key',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemeProductSnapshot;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemeSnapshotVersion = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='snapshot_schema_version') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN snapshot_schema_version INT UNSIGNED DEFAULT NULL AFTER product_snapshot',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemeSnapshotVersion;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemeSnapshotCreatedAt = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND COLUMN_NAME='snapshot_created_at') = 0,
  'ALTER TABLE project_scheme_products ADD COLUMN snapshot_created_at DATETIME DEFAULT NULL AFTER snapshot_schema_version',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemeSnapshotCreatedAt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemePublicProductFk = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND CONSTRAINT_NAME='fk_scheme_public_product') = 0,
  'ALTER TABLE project_scheme_products ADD CONSTRAINT fk_scheme_public_product FOREIGN KEY (public_product_id) REFERENCES public_product_library_products(id) ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemePublicProductFk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemePublicVersionFk = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND CONSTRAINT_NAME='fk_scheme_public_version') = 0,
  'ALTER TABLE project_scheme_products ADD CONSTRAINT fk_scheme_public_version FOREIGN KEY (public_product_version_id) REFERENCES public_product_library_versions(id) ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemePublicVersionFk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addSchemePublicConfigurationFk = IF(
  (SELECT COUNT(*) FROM information_schema.TABLES
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products') = 1 AND
  (SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
   WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='project_scheme_products'
     AND CONSTRAINT_NAME='fk_scheme_public_configuration') = 0,
  'ALTER TABLE project_scheme_products ADD CONSTRAINT fk_scheme_public_configuration FOREIGN KEY (public_product_configuration_id) REFERENCES public_product_library_configurations(id) ON DELETE RESTRICT',
  'SELECT 1'
);
PREPARE stmt FROM @addSchemePublicConfigurationFk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
