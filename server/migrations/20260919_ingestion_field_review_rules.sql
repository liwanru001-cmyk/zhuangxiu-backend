CREATE TABLE IF NOT EXISTS product_ingestion_field_review_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_id BIGINT UNSIGNED NOT NULL,
  field_path VARCHAR(240) NOT NULL,
  rule_type VARCHAR(40) NOT NULL,
  match_hash CHAR(64) NOT NULL,
  match_value JSON NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  affected_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_by VARCHAR(80) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ingestion_field_rule (source_id,field_path,rule_type,match_hash),
  KEY idx_ingestion_field_rule_status (source_id,status),
  CONSTRAINT fk_ingestion_field_rule_source FOREIGN KEY (source_id)
    REFERENCES product_ingestion_sources(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
