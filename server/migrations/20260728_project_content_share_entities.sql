ALTER TABLE project_content_shares
  MODIFY COLUMN content_type ENUM('merchant_product', 'merchant', 'company', 'merchant_case', 'company_case') NOT NULL;
