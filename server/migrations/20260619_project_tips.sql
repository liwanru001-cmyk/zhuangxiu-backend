CREATE TABLE IF NOT EXISTS project_tips (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  type VARCHAR(32) NOT NULL DEFAULT 'general',
  title VARCHAR(80) NOT NULL,
  content VARCHAR(300) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_project_tips_active_sort (is_active, sort_order, id),
  KEY idx_project_tips_type (type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO project_tips (type, title, content, sort_order, is_active)
SELECT type, title, content, sort_order, is_active
FROM (
  SELECT 'stage' AS type, '阶段建议' AS title, '提前确认主材到货时间，避免施工等待。' AS content, 10 AS sort_order, 1 AS is_active
  UNION ALL
  SELECT 'general', '装修小贴士', '水电验收时拍照存档，方便日后维修定位。', 20, 1
  UNION ALL
  SELECT 'general', '装修小贴士', '防水闭水试验建议保持至少 48 小时。', 30, 1
) seed_rows
WHERE NOT EXISTS (SELECT 1 FROM project_tips);
