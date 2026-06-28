ALTER TABLE project_material_items
  ADD COLUMN space_tags JSON DEFAULT NULL AFTER location;

