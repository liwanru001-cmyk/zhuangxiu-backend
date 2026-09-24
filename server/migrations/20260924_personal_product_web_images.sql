SET @add_personal_product_images = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='personal_products' AND COLUMN_NAME='image_urls')=0,
  'ALTER TABLE personal_products ADD COLUMN image_urls JSON DEFAULT NULL AFTER cover_url',
  'SELECT 1'
);
PREPARE stmt FROM @add_personal_product_images;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
