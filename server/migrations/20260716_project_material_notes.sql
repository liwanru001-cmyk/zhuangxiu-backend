CREATE TABLE IF NOT EXISTS project_material_notes (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  material_id BIGINT UNSIGNED NOT NULL,
  content VARCHAR(1000) NULL,
  created_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_material_notes_material (material_id, created_at),
  KEY idx_material_notes_project (project_id),
  CONSTRAINT fk_material_notes_material FOREIGN KEY (material_id) REFERENCES project_material_items(id) ON DELETE CASCADE,
  CONSTRAINT fk_material_notes_creator FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_material_note_media (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  note_id BIGINT UNSIGNED NOT NULL,
  media_type VARCHAR(20) NOT NULL DEFAULT 'image',
  media_url VARCHAR(500) NOT NULL,
  uploaded_by BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_material_note_media_note (note_id),
  CONSTRAINT fk_material_note_media_note FOREIGN KEY (note_id) REFERENCES project_material_notes(id) ON DELETE CASCADE,
  CONSTRAINT fk_material_note_media_uploader FOREIGN KEY (uploaded_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
