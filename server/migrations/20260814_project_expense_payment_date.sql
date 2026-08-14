SET @ddl = IF(
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'project_expenses'
     AND COLUMN_NAME = 'payment_date') = 0,
  'ALTER TABLE project_expenses ADD COLUMN payment_date DATE NULL AFTER expense_date, ADD KEY idx_project_payment_date (project_id, payment_date)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl; EXECUTE stmt; DEALLOCATE PREPARE stmt;
