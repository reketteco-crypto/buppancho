BEGIN;
ALTER TABLE supply_item ADD COLUMN memo text;
COMMIT;
