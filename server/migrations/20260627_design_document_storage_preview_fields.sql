ALTER TABLE project_design_documents
  ADD COLUMN storage_key VARCHAR(500) DEFAULT NULL AFTER file_url,
  ADD COLUMN preview_url VARCHAR(500) DEFAULT NULL AFTER storage_key,
  ADD COLUMN thumbnail_url VARCHAR(500) DEFAULT NULL AFTER preview_url,
  ADD COLUMN preview_status VARCHAR(32) NOT NULL DEFAULT 'none' AFTER thumbnail_url,
  ADD COLUMN preview_type VARCHAR(32) NOT NULL DEFAULT 'none' AFTER preview_status;
