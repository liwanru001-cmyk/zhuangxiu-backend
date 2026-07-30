-- 旧版公司综合评价迁移到四维评价体系。
-- 旧评分无法可靠拆分维度，因此同一评分作为四个维度的历史初始分；
-- 旧文字只挂在“沟通体验”一条记录上，避免详情页重复显示四次。

SET @reviewer_nullable := (
  SELECT IS_NULLABLE
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_evaluation_feedback'
    AND COLUMN_NAME = 'reviewer_user_id'
  LIMIT 1
);
SET @ddl := IF(
  @reviewer_nullable = 'NO',
  'ALTER TABLE company_evaluation_feedback MODIFY COLUMN reviewer_user_id BIGINT UNSIGNED NULL',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_legacy_review_id := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_evaluation_feedback'
    AND COLUMN_NAME = 'legacy_review_id'
);
SET @ddl := IF(
  @has_legacy_review_id = 0,
  'ALTER TABLE company_evaluation_feedback ADD COLUMN legacy_review_id BIGINT UNSIGNED NULL AFTER consultation_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_legacy_dimension_key := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'company_evaluation_feedback'
    AND INDEX_NAME = 'uk_legacy_review_dimension'
);
SET @ddl := IF(
  @has_legacy_dimension_key = 0,
  'ALTER TABLE company_evaluation_feedback ADD UNIQUE KEY uk_legacy_review_dimension (legacy_review_id, dimension)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT INTO company_evaluation_feedback
  (company_id, project_id, consultation_id, legacy_review_id,
   reviewer_user_id, dimension, score, comment_private,
   source_scene, status, created_at, updated_at)
SELECT
  review.company_id,
  review.project_id,
  NULL,
  review.id,
  review.reviewer_user_id,
  dimension.dimension,
  LEAST(5, GREATEST(1, review.rating)),
  CASE
    WHEN dimension.dimension = 'communication'
      THEN NULLIF(LEFT(TRIM(review.content), 300), '')
    ELSE NULL
  END,
  'legacy_review',
  review.status,
  review.created_at,
  review.updated_at
FROM company_reviews review
CROSS JOIN (
  SELECT 'communication' AS dimension
  UNION ALL SELECT 'materials'
  UNION ALL SELECT 'progress'
  UNION ALL SELECT 'problem_handling'
) dimension
WHERE review.status = 1
  AND NOT EXISTS (
    SELECT 1
    FROM company_evaluation_feedback current_feedback
    WHERE current_feedback.legacy_review_id IS NULL
      AND current_feedback.company_id = review.company_id
      AND current_feedback.project_id <=> review.project_id
      AND current_feedback.reviewer_user_id <=> review.reviewer_user_id
      AND current_feedback.dimension = dimension.dimension
  )
ON DUPLICATE KEY UPDATE
  project_id = VALUES(project_id),
  reviewer_user_id = VALUES(reviewer_user_id),
  score = VALUES(score),
  comment_private = VALUES(comment_private),
  status = VALUES(status),
  created_at = VALUES(created_at),
  updated_at = VALUES(updated_at);
