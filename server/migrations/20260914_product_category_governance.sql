CREATE TABLE IF NOT EXISTS product_ingestion_discovered_product_categories (
  job_id BIGINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  product_url_hash CHAR(64) NOT NULL,
  product_url VARCHAR(1000) NOT NULL,
  source_category_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (job_id,product_url_hash,source_category_id),
  KEY idx_discovered_category_source (source_category_id,job_id),
  CONSTRAINT fk_discovered_category_job FOREIGN KEY (job_id) REFERENCES product_ingestion_jobs(id),
  CONSTRAINT fk_discovered_category_source FOREIGN KEY (source_id) REFERENCES product_ingestion_sources(id),
  CONSTRAINT fk_discovered_category_value FOREIGN KEY (source_category_id) REFERENCES product_ingestion_source_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_ingestion_candidate_categories (
  candidate_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  assigned_by VARCHAR(80) NOT NULL,
  assigned_at DATETIME NOT NULL,
  PRIMARY KEY (candidate_id,category_id),
  CONSTRAINT fk_candidate_category_candidate FOREIGN KEY (candidate_id) REFERENCES product_ingestion_candidates(id),
  CONSTRAINT fk_candidate_category_category FOREIGN KEY (category_id) REFERENCES public_product_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS public_product_category_overrides (
  product_id BIGINT UNSIGNED NOT NULL,
  updated_by VARCHAR(80) NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (product_id),
  CONSTRAINT fk_public_product_category_override_product FOREIGN KEY (product_id) REFERENCES public_product_library_products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @addCategoryAssignmentType = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_category_relations' AND COLUMN_NAME='assignment_type') = 0,
  "ALTER TABLE public_product_category_relations ADD COLUMN assignment_type VARCHAR(20) NOT NULL DEFAULT 'source' AFTER source_category_id",
  'SELECT 1'
);
PREPARE stmt FROM @addCategoryAssignmentType;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
