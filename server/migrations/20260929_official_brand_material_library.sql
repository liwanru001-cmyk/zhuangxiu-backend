-- Official brand materials are shared entities. Products only retain audited
-- declarations and an open/closed-world policy; Product Schema v2 is untouched.

CREATE TABLE IF NOT EXISTS official_brand_material_catalogs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  catalog_key VARCHAR(120) NOT NULL,
  name VARCHAR(200) NOT NULL,
  source_url VARCHAR(1000) NOT NULL,
  source_url_hash CHAR(64) NOT NULL,
  rule_schema_version VARCHAR(40) NOT NULL DEFAULT 'official-material-rule-v1',
  catalog_rule JSON NOT NULL,
  product_subset_rule JSON DEFAULT NULL,
  rule_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  current_revision INT UNSIGNED NOT NULL DEFAULT 0,
  last_scan_id BIGINT UNSIGNED DEFAULT NULL,
  last_complete_scan_id BIGINT UNSIGNED DEFAULT NULL,
  frozen_rule_hash CHAR(64) DEFAULT NULL,
  validation_evidence JSON DEFAULT NULL,
  frozen_at DATETIME DEFAULT NULL,
  created_by VARCHAR(80) NOT NULL,
  approved_by VARCHAR(80) DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_official_material_catalog (source_id,catalog_key),
  KEY idx_official_material_catalog_status (source_id,status,id),
  CONSTRAINT fk_official_material_catalog_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='official_brand_material_catalogs' AND COLUMN_NAME='frozen_rule_hash')=0,
  'ALTER TABLE official_brand_material_catalogs ADD COLUMN frozen_rule_hash CHAR(64) DEFAULT NULL AFTER last_complete_scan_id, ADD COLUMN validation_evidence JSON DEFAULT NULL AFTER frozen_rule_hash, ADD COLUMN frozen_at DATETIME DEFAULT NULL AFTER validation_evidence', 'SELECT 1');
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS product_ingestion_related_resource_snapshots (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  resource_role VARCHAR(40) NOT NULL,
  resource_url VARCHAR(1000) NOT NULL,
  resource_url_hash CHAR(64) NOT NULL,
  final_url VARCHAR(1000) NOT NULL,
  parent_url VARCHAR(1000) DEFAULT NULL,
  http_status SMALLINT UNSIGNED NOT NULL,
  content_type VARCHAR(160) NOT NULL,
  content_hash CHAR(64) NOT NULL,
  html MEDIUMBLOB NOT NULL,
  fetched_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_related_snapshot_cache (source_id,resource_url_hash,expires_at),
  KEY idx_related_snapshot_content (content_hash),
  CONSTRAINT fk_related_snapshot_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_brand_material_scans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  catalog_id BIGINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  scan_kind VARCHAR(32) NOT NULL,
  product_id BIGINT UNSIGNED DEFAULT NULL,
  product_url VARCHAR(1000) DEFAULT NULL,
  product_url_hash CHAR(64) DEFAULT NULL,
  resource_url VARCHAR(1000) NOT NULL,
  rule_hash CHAR(64) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  completeness VARCHAR(24) NOT NULL DEFAULT 'unknown',
  cache_status VARCHAR(24) NOT NULL DEFAULT 'not_checked',
  pages_attempted INT UNSIGNED NOT NULL DEFAULT 0,
  pages_succeeded INT UNSIGNED NOT NULL DEFAULT 0,
  observations_found INT UNSIGNED NOT NULL DEFAULT 0,
  materials_upserted INT UNSIGNED NOT NULL DEFAULT 0,
  assets_archived INT UNSIGNED NOT NULL DEFAULT 0,
  failure_code VARCHAR(80) DEFAULT NULL,
  last_error VARCHAR(1000) DEFAULT NULL,
  evidence JSON DEFAULT NULL,
  started_at DATETIME DEFAULT NULL,
  finished_at DATETIME DEFAULT NULL,
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_official_material_scan_catalog (catalog_id,id),
  KEY idx_official_material_scan_product (source_id,product_url_hash,id),
  KEY idx_official_material_scan_status (status,id),
  CONSTRAINT fk_official_material_scan_catalog FOREIGN KEY (catalog_id)
    REFERENCES official_brand_material_catalogs(id),
  CONSTRAINT fk_official_material_scan_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id),
  CONSTRAINT fk_official_material_scan_product FOREIGN KEY (product_id)
    REFERENCES public_product_library_products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_related_resource_links (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id BIGINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  parent_url VARCHAR(1000) NOT NULL,
  target_url VARCHAR(1000) NOT NULL,
  target_url_hash CHAR(64) NOT NULL,
  resource_role VARCHAR(40) NOT NULL,
  link_text VARCHAR(500) DEFAULT NULL,
  locator JSON NOT NULL,
  decision VARCHAR(24) NOT NULL DEFAULT 'accepted',
  rejection_reason VARCHAR(160) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_related_resource_link (scan_id,target_url_hash,resource_role),
  KEY idx_related_resource_link_source (source_id,target_url_hash),
  CONSTRAINT fk_related_resource_link_scan FOREIGN KEY (scan_id)
    REFERENCES official_brand_material_scans(id),
  CONSTRAINT fk_related_resource_link_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_brand_materials (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  canonical_key CHAR(64) NOT NULL,
  kind VARCHAR(120) DEFAULT NULL,
  series VARCHAR(200) DEFAULT NULL,
  name VARCHAR(300) NOT NULL,
  code VARCHAR(160) DEFAULT NULL,
  color VARCHAR(160) DEFAULT NULL,
  composition VARCHAR(500) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  verification_status VARCHAR(24) NOT NULL DEFAULT 'official_observed',
  first_seen_scan_id BIGINT UNSIGNED NOT NULL,
  last_seen_scan_id BIGINT UNSIGNED NOT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  evidence JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_official_material_identity (source_id,canonical_key),
  KEY idx_official_material_browse (source_id,status,kind,series,id),
  KEY idx_official_material_code (source_id,code),
  CONSTRAINT fk_official_material_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id),
  CONSTRAINT fk_official_material_first_scan FOREIGN KEY (first_seen_scan_id)
    REFERENCES official_brand_material_scans(id),
  CONSTRAINT fk_official_material_last_scan FOREIGN KEY (last_seen_scan_id)
    REFERENCES official_brand_material_scans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_brand_material_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  material_id BIGINT UNSIGNED NOT NULL,
  asset_id BIGINT UNSIGNED NOT NULL,
  asset_role VARCHAR(40) NOT NULL DEFAULT 'material_swatch',
  original_url VARCHAR(1000) NOT NULL,
  original_url_hash CHAR(64) NOT NULL,
  evidence JSON NOT NULL,
  first_seen_scan_id BIGINT UNSIGNED NOT NULL,
  last_seen_scan_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_official_material_asset (material_id,original_url_hash),
  KEY idx_official_material_asset_file (asset_id,material_id),
  CONSTRAINT fk_official_material_asset_material FOREIGN KEY (material_id)
    REFERENCES official_brand_materials(id),
  CONSTRAINT fk_official_material_asset_file FOREIGN KEY (asset_id)
    REFERENCES public_product_library_assets(id),
  CONSTRAINT fk_official_material_asset_first_scan FOREIGN KEY (first_seen_scan_id)
    REFERENCES official_brand_material_scans(id),
  CONSTRAINT fk_official_material_asset_last_scan FOREIGN KEY (last_seen_scan_id)
    REFERENCES official_brand_material_scans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_brand_material_catalog_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  catalog_id BIGINT UNSIGNED NOT NULL,
  material_id BIGINT UNSIGNED NOT NULL,
  membership_kind VARCHAR(32) NOT NULL DEFAULT 'catalog_listing',
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  evidence JSON NOT NULL,
  first_seen_scan_id BIGINT UNSIGNED NOT NULL,
  last_seen_scan_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_official_material_catalog_item (catalog_id,material_id,membership_kind),
  KEY idx_official_material_catalog_item_state (catalog_id,membership_kind,status),
  KEY idx_official_material_catalog_item_material (material_id,status),
  CONSTRAINT fk_official_material_catalog_item_catalog FOREIGN KEY (catalog_id)
    REFERENCES official_brand_material_catalogs(id),
  CONSTRAINT fk_official_material_catalog_item_material FOREIGN KEY (material_id)
    REFERENCES official_brand_materials(id),
  CONSTRAINT fk_official_material_catalog_item_first_scan FOREIGN KEY (first_seen_scan_id)
    REFERENCES official_brand_material_scans(id),
  CONSTRAINT fk_official_material_catalog_item_last_scan FOREIGN KEY (last_seen_scan_id)
    REFERENCES official_brand_material_scans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_product_material_constraints (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED DEFAULT NULL,
  product_url VARCHAR(1000) NOT NULL,
  product_url_hash CHAR(64) NOT NULL,
  policy_mode VARCHAR(24) NOT NULL DEFAULT 'open_world',
  policy_basis VARCHAR(32) NOT NULL DEFAULT 'system_default',
  policy_evidence JSON DEFAULT NULL,
  revision INT UNSIGNED NOT NULL DEFAULT 1,
  last_scan_id BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_material_constraint (source_id,product_url_hash),
  KEY idx_product_material_constraint_product (product_id),
  CONSTRAINT fk_product_material_constraint_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id),
  CONSTRAINT fk_product_material_constraint_product FOREIGN KEY (product_id)
    REFERENCES public_product_library_products(id),
  CONSTRAINT fk_product_material_constraint_scan FOREIGN KEY (last_scan_id)
    REFERENCES official_brand_material_scans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS official_product_material_assertions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED DEFAULT NULL,
  product_url VARCHAR(1000) NOT NULL,
  product_url_hash CHAR(64) NOT NULL,
  material_id BIGINT UNSIGNED NOT NULL,
  assertion VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  evidence JSON NOT NULL,
  first_seen_scan_id BIGINT UNSIGNED NOT NULL,
  last_seen_scan_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_material_assertion (source_id,product_url_hash,material_id,assertion),
  KEY idx_product_material_assertion_product (product_id,status),
  KEY idx_product_material_assertion_material (material_id,status),
  CONSTRAINT fk_product_material_assertion_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id),
  CONSTRAINT fk_product_material_assertion_product FOREIGN KEY (product_id)
    REFERENCES public_product_library_products(id),
  CONSTRAINT fk_product_material_assertion_material FOREIGN KEY (material_id)
    REFERENCES official_brand_materials(id),
  CONSTRAINT fk_product_material_assertion_first_scan FOREIGN KEY (first_seen_scan_id)
    REFERENCES official_brand_material_scans(id),
  CONSTRAINT fk_product_material_assertion_last_scan FOREIGN KEY (last_seen_scan_id)
    REFERENCES official_brand_material_scans(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_material_observations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scan_id BIGINT UNSIGNED NOT NULL,
  snapshot_id BIGINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  ordinal INT UNSIGNED NOT NULL,
  canonical_key CHAR(64) DEFAULT NULL,
  extracted_fields JSON NOT NULL,
  field_evidence JSON NOT NULL,
  swatch_url VARCHAR(1000) DEFAULT NULL,
  swatch_evidence JSON DEFAULT NULL,
  outcome VARCHAR(32) NOT NULL,
  issue_code VARCHAR(80) DEFAULT NULL,
  material_id BIGINT UNSIGNED DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_material_observation (scan_id,snapshot_id,ordinal),
  KEY idx_material_observation_outcome (scan_id,outcome),
  CONSTRAINT fk_material_observation_scan FOREIGN KEY (scan_id)
    REFERENCES official_brand_material_scans(id),
  CONSTRAINT fk_material_observation_snapshot FOREIGN KEY (snapshot_id)
    REFERENCES product_ingestion_related_resource_snapshots(id),
  CONSTRAINT fk_material_observation_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id),
  CONSTRAINT fk_material_observation_material FOREIGN KEY (material_id)
    REFERENCES official_brand_materials(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
