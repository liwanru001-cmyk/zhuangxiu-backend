SET @product_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'designer_consultations'
    AND COLUMN_NAME = 'product_id'
);
SET @add_product_column_sql = IF(
  @product_column_exists = 0,
  'ALTER TABLE designer_consultations ADD COLUMN product_id BIGINT UNSIGNED DEFAULT NULL AFTER user_id',
  'SELECT 1'
);
PREPARE add_product_column_statement FROM @add_product_column_sql;
EXECUTE add_product_column_statement;
DEALLOCATE PREPARE add_product_column_statement;

SET @product_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'designer_consultations'
    AND INDEX_NAME = 'idx_consultation_product'
);
SET @add_product_index_sql = IF(
  @product_index_exists = 0,
  'ALTER TABLE designer_consultations ADD KEY idx_consultation_product (product_id)',
  'SELECT 1'
);
PREPARE add_product_index_statement FROM @add_product_index_sql;
EXECUTE add_product_index_statement;
DEALLOCATE PREPARE add_product_index_statement;

UPDATE designer_consultations consultation
JOIN (
  SELECT existing.id AS consultation_id, MIN(product.id) AS product_id
  FROM designer_consultations existing
  JOIN merchant_products product
    ON product.merchant_user_id = existing.designer_id
   AND LEFT(
     existing.content,
     CHAR_LENGTH(CONCAT('咨询商品：', product.name, CHAR(10)))
   ) = CONCAT('咨询商品：', product.name, CHAR(10))
  WHERE existing.target_role = 'merchant'
    AND existing.product_id IS NULL
  GROUP BY existing.id
  HAVING COUNT(*) = 1
) matched ON matched.consultation_id = consultation.id
SET consultation.product_id = matched.product_id;
