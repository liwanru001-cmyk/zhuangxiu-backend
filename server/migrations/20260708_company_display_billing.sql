-- Company display billing MVP.
-- Scope: verified companies can be manually activated by admin.

INSERT INTO billing_plan_groups (code, name, subject_type, status, sort_order)
VALUES ('company_plans', '装修公司展示套餐', 'company', 'active', 20)
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  subject_type = VALUES(subject_type),
  status = VALUES(status),
  sort_order = VALUES(sort_order);

INSERT INTO billing_plans (plan_group_id, code, name, subject_type, billing_period, status, sort_order)
SELECT id, 'company_display_monthly', '装修公司展示月度版', 'company', 'month', 'active', 10
FROM billing_plan_groups
WHERE code = 'company_plans'
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
  '装修公司展示月度版 v1',
  9900,
  'CNY',
  30,
  JSON_OBJECT(
    'company_visible', true,
    'search_visible', true,
    'case_showcase', true,
    'review_showcase', true
  ),
  JSON_OBJECT(
    'case_limit', 100
  ),
  'published',
  NOW()
FROM billing_plans
WHERE code = 'company_display_monthly'
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  price_cents = VALUES(price_cents),
  currency = VALUES(currency),
  duration_days = VALUES(duration_days),
  feature_json = VALUES(feature_json),
  limit_json = VALUES(limit_json),
  status = VALUES(status);
