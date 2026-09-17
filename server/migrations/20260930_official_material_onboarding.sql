-- Audits AI-assisted onboarding of brand-level fabric and leather catalogs.
-- Product Schema V2 and merchant material tables are intentionally untouched.

CREATE TABLE IF NOT EXISTS official_brand_material_ai_calls (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  catalog_id BIGINT UNSIGNED DEFAULT NULL,
  purpose VARCHAR(48) NOT NULL,
  model VARCHAR(120) NOT NULL,
  prompt_version VARCHAR(80) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  input_manifest JSON NOT NULL,
  raw_output JSON DEFAULT NULL,
  normalized_output JSON DEFAULT NULL,
  validation_errors JSON DEFAULT NULL,
  input_tokens INT UNSIGNED DEFAULT NULL,
  output_tokens INT UNSIGNED DEFAULT NULL,
  total_tokens INT UNSIGNED DEFAULT NULL,
  elapsed_ms INT UNSIGNED DEFAULT NULL,
  status VARCHAR(24) NOT NULL,
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_material_ai_source (source_id,id),
  KEY idx_material_ai_catalog (catalog_id,id),
  KEY idx_material_ai_request (request_hash,status),
  CONSTRAINT fk_material_ai_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id),
  CONSTRAINT fk_material_ai_catalog FOREIGN KEY (catalog_id)
    REFERENCES official_brand_material_catalogs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
