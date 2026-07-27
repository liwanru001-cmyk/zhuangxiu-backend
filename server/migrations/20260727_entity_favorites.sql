CREATE TABLE IF NOT EXISTS user_entity_favorites (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  entity_type ENUM('shop', 'company', 'merchant_case', 'company_case') NOT NULL,
  entity_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_entity_favorite (user_id, entity_type, entity_id),
  KEY idx_user_entity_created (user_id, entity_type, created_at),
  KEY idx_entity_favorite (entity_type, entity_id),
  CONSTRAINT fk_entity_favorite_user
    FOREIGN KEY (user_id) REFERENCES users(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
