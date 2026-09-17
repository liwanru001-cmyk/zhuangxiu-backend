CREATE TABLE IF NOT EXISTS product_ingestion_sources (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  brand_name VARCHAR(120) NOT NULL,
  base_url VARCHAR(500) NOT NULL,
  allowed_hosts JSON NOT NULL,
  allowed_path_prefixes JSON NOT NULL,
  product_group VARCHAR(30) NOT NULL,
  product_type VARCHAR(30) NOT NULL,
  adapter_key VARCHAR(80) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'draft',
  max_pages_per_run INT UNSIGNED NOT NULL DEFAULT 20,
  max_products_per_run INT UNSIGNED NOT NULL DEFAULT 50,
  request_interval_ms INT UNSIGNED NOT NULL DEFAULT 2000,
  obey_robots TINYINT(1) NOT NULL DEFAULT 1,
  manual_review_required TINYINT(1) NOT NULL DEFAULT 1,
  notes VARCHAR(1000) DEFAULT NULL,
  approved_by VARCHAR(80) DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ingestion_adapter (adapter_key),
  KEY idx_ingestion_source_status (status, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @dropIngestionAdapterUnique = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_sources'
     AND INDEX_NAME='uk_ingestion_adapter') > 0,
  'ALTER TABLE product_ingestion_sources DROP INDEX uk_ingestion_adapter',
  'SELECT 1'
);
PREPARE stmt FROM @dropIngestionAdapterUnique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionAdapterIndex = IF(
  (SELECT COUNT(*) FROM information_schema.STATISTICS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_sources'
     AND INDEX_NAME='idx_ingestion_adapter') = 0,
  'ALTER TABLE product_ingestion_sources ADD KEY idx_ingestion_adapter (adapter_key)',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionAdapterIndex;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS product_ingestion_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  seed_urls JSON NOT NULL,
  max_pages INT UNSIGNED NOT NULL,
  max_products INT UNSIGNED NOT NULL,
  request_interval_ms INT UNSIGNED NOT NULL,
  reason VARCHAR(500) NOT NULL,
  scope_snapshot JSON DEFAULT NULL,
  pages_fetched INT UNSIGNED NOT NULL DEFAULT 0,
  candidates_found INT UNSIGNED NOT NULL DEFAULT 0,
  accepted_count INT UNSIGNED NOT NULL DEFAULT 0,
  rejected_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(1000) DEFAULT NULL,
  created_by VARCHAR(80) NOT NULL,
  approved_by VARCHAR(80) DEFAULT NULL,
  approved_at DATETIME DEFAULT NULL,
  started_at DATETIME DEFAULT NULL,
  finished_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ingestion_job_status_time (status, created_at),
  KEY idx_ingestion_job_source (source_id, created_at),
  CONSTRAINT fk_ingestion_job_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_candidates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id BIGINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  source_url VARCHAR(1000) NOT NULL,
  source_url_hash CHAR(64) NOT NULL,
  source_external_id VARCHAR(160) DEFAULT NULL,
  content_fingerprint CHAR(64) DEFAULT NULL,
  raw_snapshot_url VARCHAR(1000) DEFAULT NULL,
  raw_http_status SMALLINT UNSIGNED DEFAULT NULL,
  raw_content_type VARCHAR(160) DEFAULT NULL,
  raw_html MEDIUMBLOB DEFAULT NULL,
  extracted_payload JSON DEFAULT NULL,
  normalized_payload JSON DEFAULT NULL,
  generated_fields JSON DEFAULT NULL,
  validation_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  validation_issues JSON DEFAULT NULL,
  review_status VARCHAR(24) NOT NULL DEFAULT 'pending',
  review_note VARCHAR(500) DEFAULT NULL,
  reviewed_by VARCHAR(80) DEFAULT NULL,
  reviewed_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ingestion_candidate_job_url (job_id, source_url_hash),
  KEY idx_ingestion_candidate_review (review_status, validation_status, id),
  KEY idx_ingestion_candidate_source (source_id, id),
  CONSTRAINT fk_ingestion_candidate_job FOREIGN KEY (job_id)
    REFERENCES product_ingestion_jobs(id),
  CONSTRAINT fk_ingestion_candidate_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @addIngestionRawStatus = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='raw_http_status') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN raw_http_status SMALLINT UNSIGNED DEFAULT NULL AFTER raw_snapshot_url',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionRawStatus;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionRawContentType = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='raw_content_type') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN raw_content_type VARCHAR(160) DEFAULT NULL AFTER raw_http_status',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionRawContentType;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionRawHtml = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='raw_html') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN raw_html MEDIUMBLOB DEFAULT NULL AFTER raw_content_type',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionRawHtml;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionReviewNote = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='review_note') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN review_note VARCHAR(500) DEFAULT NULL AFTER review_status',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionReviewNote;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

CREATE TABLE IF NOT EXISTS public_product_library_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  source_url VARCHAR(1000) NOT NULL,
  source_url_hash CHAR(64) NOT NULL,
  brand_name VARCHAR(120) NOT NULL,
  name VARCHAR(120) NOT NULL,
  product_group VARCHAR(30) NOT NULL,
  product_type VARCHAR(30) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  current_version_id BIGINT UNSIGNED DEFAULT NULL,
  first_published_by VARCHAR(80) NOT NULL,
  first_published_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_public_product_source_url (source_id, source_url_hash),
  KEY idx_public_product_status_type (status, product_type, id),
  CONSTRAINT fk_public_product_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS public_product_library_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id BIGINT UNSIGNED NOT NULL,
  candidate_id BIGINT UNSIGNED NOT NULL,
  version_no INT UNSIGNED NOT NULL,
  content_fingerprint CHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  brand_name VARCHAR(120) NOT NULL,
  cover_url VARCHAR(1000) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  model VARCHAR(120) DEFAULT NULL,
  product_payload JSON NOT NULL,
  published_by VARCHAR(80) NOT NULL,
  published_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_public_product_version (product_id, version_no),
  UNIQUE KEY uk_public_product_candidate (candidate_id),
  KEY idx_public_version_product_time (product_id, published_at),
  CONSTRAINT fk_public_version_product FOREIGN KEY (product_id)
    REFERENCES public_product_library_products(id),
  CONSTRAINT fk_public_version_candidate FOREIGN KEY (candidate_id)
    REFERENCES product_ingestion_candidates(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS public_product_library_configurations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  version_id BIGINT UNSIGNED NOT NULL,
  configuration_key VARCHAR(80) NOT NULL,
  name VARCHAR(200) NOT NULL,
  code VARCHAR(500) DEFAULT NULL,
  sort_order INT UNSIGNED NOT NULL,
  configuration_payload JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_public_version_configuration (version_id, configuration_key),
  KEY idx_public_configuration_version_order (version_id, sort_order),
  CONSTRAINT fk_public_configuration_version FOREIGN KEY (version_id)
    REFERENCES public_product_library_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @addIngestionPublishedProduct = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='published_product_id') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN published_product_id BIGINT UNSIGNED DEFAULT NULL AFTER reviewed_at',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionPublishedProduct;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionPublishedVersion = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='published_version_id') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN published_version_id BIGINT UNSIGNED DEFAULT NULL AFTER published_product_id',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionPublishedVersion;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addIngestionPublishedAt = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='product_ingestion_candidates'
     AND COLUMN_NAME='published_at') = 0,
  'ALTER TABLE product_ingestion_candidates ADD COLUMN published_at DATETIME DEFAULT NULL AFTER published_version_id',
  'SELECT 1'
);
PREPARE stmt FROM @addIngestionPublishedAt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
