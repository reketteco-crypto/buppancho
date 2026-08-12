ALTER TABLE business_unit_assignment
  ADD COLUMN default_operator_id uuid;

UPDATE business_unit_assignment AS assignment
SET default_operator_id = unit.default_operator_id
FROM business_unit AS unit
WHERE unit.id = assignment.business_unit_id;

ALTER TABLE business_unit_assignment
  ADD CONSTRAINT business_unit_assignment_default_operator_id_fkey
  FOREIGN KEY (default_operator_id) REFERENCES operator(id) ON DELETE RESTRICT;

CREATE INDEX business_unit_assignment_default_operator_id_idx
  ON business_unit_assignment(default_operator_id);

ALTER TABLE business_unit
  DROP CONSTRAINT business_unit_default_operator_id_fkey,
  DROP COLUMN default_operator_id;
