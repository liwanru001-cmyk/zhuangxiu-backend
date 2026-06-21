ALTER TABLE renovation_projects
  ADD COLUMN budget_range VARCHAR(80) DEFAULT NULL AFTER renovation_method,
  ADD COLUMN expected_move_in_date DATE DEFAULT NULL AFTER budget_range,
  ADD COLUMN resident_info VARCHAR(255) DEFAULT NULL AFTER expected_move_in_date,
  ADD COLUMN lifestyle_notes TEXT DEFAULT NULL AFTER resident_info,
  ADD COLUMN style_preference VARCHAR(255) DEFAULT NULL AFTER lifestyle_notes,
  ADD COLUMN key_spaces VARCHAR(255) DEFAULT NULL AFTER style_preference,
  ADD COLUMN special_needs TEXT DEFAULT NULL AFTER key_spaces;
