SET @addPublicProductArchivedAt = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_products' AND COLUMN_NAME='archived_at') = 0,
  'ALTER TABLE public_product_library_products ADD COLUMN archived_at DATETIME DEFAULT NULL AFTER status',
  'SELECT 1'
);
PREPARE stmt FROM @addPublicProductArchivedAt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
SET @addPublicProductArchivedBy = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_products' AND COLUMN_NAME='archived_by') = 0,
  'ALTER TABLE public_product_library_products ADD COLUMN archived_by VARCHAR(80) DEFAULT NULL AFTER archived_at',
  'SELECT 1'
);
PREPARE stmt FROM @addPublicProductArchivedBy;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addPublicProductDeletedAt = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_products' AND COLUMN_NAME='deleted_at') = 0,
  'ALTER TABLE public_product_library_products ADD COLUMN deleted_at DATETIME DEFAULT NULL AFTER archived_by',
  'SELECT 1'
);
PREPARE stmt FROM @addPublicProductDeletedAt;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addPublicProductDeletedBy = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_products' AND COLUMN_NAME='deleted_by') = 0,
  'ALTER TABLE public_product_library_products ADD COLUMN deleted_by VARCHAR(80) DEFAULT NULL AFTER deleted_at',
  'SELECT 1'
);
PREPARE stmt FROM @addPublicProductDeletedBy;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @addPublicProductLifecycleUpdatedBy = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='public_product_library_products' AND COLUMN_NAME='lifecycle_updated_by') = 0,
  'ALTER TABLE public_product_library_products ADD COLUMN lifecycle_updated_by VARCHAR(80) DEFAULT NULL AFTER deleted_by',
  'SELECT 1'
);
PREPARE stmt FROM @addPublicProductLifecycleUpdatedBy;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
