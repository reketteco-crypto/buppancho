BEGIN;
ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_location_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_location_check CHECK (
  (movement_type = 'location_transfer' AND quantity > 0 AND storage_location_from_id IS NOT NULL AND storage_location_to_id IS NOT NULL AND storage_location_from_id <> storage_location_to_id) OR
  (movement_type IN ('receipt','adjustment_in','return_in','return_defective','return_disposal') AND quantity > 0 AND storage_location_from_id IS NULL AND storage_location_to_id IS NOT NULL) OR
  (movement_type IN ('receipt_reversal','disposal','loss','personal_use','adjustment_out','sale_out','purchase_return') AND quantity < 0 AND storage_location_from_id IS NOT NULL AND storage_location_to_id IS NULL)
);

COMMIT;
