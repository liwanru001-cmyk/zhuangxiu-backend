-- Unified sidecar relation layer for cases, reviews, projects, notes, and consultations.
-- This table intentionally avoids foreign keys to legacy content tables.

CREATE TABLE IF NOT EXISTS entity_relations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_type ENUM('case', 'review', 'project', 'note', 'consultation') NOT NULL,
  source_id BIGINT NOT NULL,
  target_type ENUM('company', 'professional', 'project', 'user') NOT NULL,
  target_id BIGINT NOT NULL,
  relation_type ENUM('owner', 'provider', 'reviewer', 'participant', 'case_owner') NOT NULL,
  role_label VARCHAR(80) DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_entity_relation (source_type, source_id, target_type, target_id, relation_type),
  KEY idx_source (source_type, source_id),
  KEY idx_target (target_type, target_id),
  KEY idx_relation_type (relation_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
