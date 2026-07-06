-- Merchant billing MVP: order -> payment -> subscription -> entitlement -> audit -> event
-- Scope: merchant subject only.

CREATE TABLE IF NOT EXISTS billing_subjects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_type VARCHAR(32) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_billing_subject (subject_type, subject_id),
  KEY idx_subject_status (subject_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_plan_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_plan_group_code (code),
  KEY idx_plan_group_subject (subject_type, status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_group_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(64) NOT NULL,
  name VARCHAR(120) NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  billing_period VARCHAR(32) NOT NULL DEFAULT 'month',
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_plan_code (code),
  KEY idx_plan_group_status (plan_group_id, status, sort_order),
  KEY idx_plan_subject_status (subject_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_plan_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_id BIGINT UNSIGNED NOT NULL,
  version INT UNSIGNED NOT NULL,
  name VARCHAR(120) NOT NULL,
  price_cents INT UNSIGNED NOT NULL DEFAULT 0,
  currency VARCHAR(16) NOT NULL DEFAULT 'CNY',
  duration_days INT UNSIGNED NOT NULL DEFAULT 30,
  feature_json JSON DEFAULT NULL,
  limit_json JSON DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'published',
  published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_plan_version (plan_id, version),
  KEY idx_plan_version_status (plan_id, status, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no VARCHAR(64) NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  order_type VARCHAR(32) NOT NULL DEFAULT 'subscription',
  item_type VARCHAR(32) NOT NULL,
  item_id BIGINT UNSIGNED NOT NULL,
  item_version_id BIGINT UNSIGNED DEFAULT NULL,
  amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
  currency VARCHAR(16) NOT NULL DEFAULT 'CNY',
  payment_channel VARCHAR(32) NOT NULL DEFAULT 'manual',
  status VARCHAR(32) NOT NULL DEFAULT 'pending_payment',
  idempotency_key VARCHAR(128) DEFAULT NULL,
  paid_at DATETIME DEFAULT NULL,
  closed_at DATETIME DEFAULT NULL,
  metadata_json JSON DEFAULT NULL,
  created_by BIGINT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_no (order_no),
  UNIQUE KEY uk_order_idempotency (idempotency_key),
  KEY idx_order_subject_status (subject_type, subject_id, status, created_at),
  KEY idx_order_item (item_type, item_id, item_version_id),
  KEY idx_order_payment_channel (payment_channel, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_no VARCHAR(64) NOT NULL,
  order_id BIGINT UNSIGNED NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  payment_channel VARCHAR(32) NOT NULL DEFAULT 'manual',
  amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
  currency VARCHAR(16) NOT NULL DEFAULT 'CNY',
  status VARCHAR(32) NOT NULL DEFAULT 'succeeded',
  provider_transaction_id VARCHAR(128) DEFAULT NULL,
  idempotency_key VARCHAR(128) DEFAULT NULL,
  paid_at DATETIME DEFAULT NULL,
  raw_payload_json JSON DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_payment_no (payment_no),
  UNIQUE KEY uk_payment_idempotency (payment_channel, idempotency_key),
  KEY idx_payment_order (order_id, status),
  KEY idx_payment_subject (subject_type, subject_id, status, paid_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subscription_no VARCHAR(64) NOT NULL,
  subject_type VARCHAR(32) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  plan_id BIGINT UNSIGNED NOT NULL,
  plan_version_id BIGINT UNSIGNED NOT NULL,
  source_order_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  is_primary TINYINT(1) NOT NULL DEFAULT 1,
  started_at DATETIME NOT NULL,
  expire_at DATETIME NOT NULL,
  cancelled_at DATETIME DEFAULT NULL,
  readonly_mode TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(64) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_subscription_no (subscription_no),
  KEY idx_subscription_subject (subject_type, subject_id, status, is_primary, expire_at),
  KEY idx_subscription_order (source_order_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_entitlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_type VARCHAR(32) NOT NULL,
  subject_id BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED DEFAULT NULL,
  source_type VARCHAR(32) NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  entitlement_version INT UNSIGNED NOT NULL DEFAULT 1,
  feature_json JSON DEFAULT NULL,
  limit_json JSON DEFAULT NULL,
  readonly_mode TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(64) DEFAULT NULL,
  expire_at DATETIME NOT NULL,
  calculated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_entitlement_subject (subject_type, subject_id, status, expire_at),
  KEY idx_entitlement_source (source_type, source_id),
  KEY idx_entitlement_subscription (subscription_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject_type VARCHAR(32) DEFAULT NULL,
  subject_id BIGINT UNSIGNED DEFAULT NULL,
  actor_type VARCHAR(32) NOT NULL DEFAULT 'system',
  actor_id BIGINT UNSIGNED DEFAULT NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id BIGINT UNSIGNED DEFAULT NULL,
  before_json JSON DEFAULT NULL,
  after_json JSON DEFAULT NULL,
  reason VARCHAR(255) DEFAULT NULL,
  request_id VARCHAR(128) DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_subject (subject_type, subject_id, created_at),
  KEY idx_audit_target (target_type, target_id, created_at),
  KEY idx_audit_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS billing_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(64) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  event_version INT UNSIGNED NOT NULL DEFAULT 1,
  subject_type VARCHAR(32) DEFAULT NULL,
  subject_id BIGINT UNSIGNED DEFAULT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id BIGINT UNSIGNED DEFAULT NULL,
  payload_json JSON DEFAULT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  retry_count INT UNSIGNED NOT NULL DEFAULT 0,
  next_retry_at DATETIME DEFAULT NULL,
  dead_letter_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_event_id (event_id),
  KEY idx_event_status (status, next_retry_at, created_at),
  KEY idx_event_subject (subject_type, subject_id, created_at),
  KEY idx_event_aggregate (aggregate_type, aggregate_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO billing_plan_groups (code, name, subject_type, status, sort_order)
VALUES ('merchant_plans', '商家展示套餐', 'merchant', 'active', 10)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  subject_type = VALUES(subject_type),
  status = VALUES(status),
  sort_order = VALUES(sort_order);

INSERT INTO billing_plans (plan_group_id, code, name, subject_type, billing_period, status, sort_order)
SELECT id, 'merchant_display_monthly', '商家展示月度版', 'merchant', 'month', 'active', 10
FROM billing_plan_groups
WHERE code = 'merchant_plans'
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  subject_type = VALUES(subject_type),
  billing_period = VALUES(billing_period),
  status = VALUES(status),
  sort_order = VALUES(sort_order);

INSERT INTO billing_plan_versions (
  plan_id,
  version,
  name,
  price_cents,
  currency,
  duration_days,
  feature_json,
  limit_json,
  status,
  published_at
)
SELECT
  id,
  1,
  '商家展示月度版 v1',
  9900,
  'CNY',
  30,
  JSON_OBJECT(
    'shop_visible', true,
    'search_visible', true,
    'map_visible', true,
    'product_showcase', true,
    'case_showcase', true
  ),
  JSON_OBJECT(
    'product_limit', 100,
    'case_limit', 50
  ),
  'published',
  NOW()
FROM billing_plans
WHERE code = 'merchant_display_monthly'
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  price_cents = VALUES(price_cents),
  currency = VALUES(currency),
  duration_days = VALUES(duration_days),
  feature_json = VALUES(feature_json),
  limit_json = VALUES(limit_json),
  status = VALUES(status);
