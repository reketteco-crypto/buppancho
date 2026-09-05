ALTER TYPE sequence_kind ADD VALUE IF NOT EXISTS 'variant';

CREATE TYPE item_condition_category AS ENUM ('unspecified', 'new', 'used');

ALTER TABLE inventory_item
  ADD COLUMN default_condition_category item_condition_category NOT NULL DEFAULT 'unspecified';

ALTER TABLE item_variant ADD COLUMN workspace_id uuid;
UPDATE item_variant AS variant
SET workspace_id = item.workspace_id
FROM inventory_item AS item
WHERE item.id = variant.inventory_item_id;
ALTER TABLE item_variant
  ALTER COLUMN workspace_id SET NOT NULL,
  ADD CONSTRAINT item_variant_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspace(id) ON DELETE RESTRICT,
  ADD CONSTRAINT item_variant_workspace_id_variant_code_key
    UNIQUE (workspace_id, variant_code);

ALTER TABLE purchase_line
  ADD COLUMN tracking_mode inventory_management_type,
  ADD COLUMN condition_category item_condition_category NOT NULL DEFAULT 'unspecified';
UPDATE purchase_line AS line
SET tracking_mode = item.management_type
FROM item_variant AS variant
JOIN inventory_item AS item ON item.id = variant.inventory_item_id
WHERE variant.id = line.item_variant_id;
ALTER TABLE purchase_line ALTER COLUMN tracking_mode SET NOT NULL;
ALTER TABLE purchase_line ADD CONSTRAINT purchase_line_tracking_quantity_check
  CHECK (tracking_mode <> 'unique' OR ordered_quantity = 1);

ALTER TABLE inventory_lot ADD COLUMN tracking_mode inventory_management_type;
UPDATE inventory_lot AS lot
SET tracking_mode = item.management_type
FROM item_variant AS variant
JOIN inventory_item AS item ON item.id = variant.inventory_item_id
WHERE variant.id = lot.item_variant_id;
ALTER TABLE inventory_lot ALTER COLUMN tracking_mode SET NOT NULL;

ALTER TABLE inventory_cost_balance ADD COLUMN tracking_mode inventory_management_type;
UPDATE inventory_cost_balance AS balance
SET tracking_mode = item.management_type
FROM item_variant AS variant
JOIN inventory_item AS item ON item.id = variant.inventory_item_id
WHERE variant.id = balance.item_variant_id;
ALTER TABLE inventory_cost_balance ALTER COLUMN tracking_mode SET NOT NULL;
ALTER TABLE inventory_cost_balance
  DROP CONSTRAINT inventory_cost_balance_item_variant_id_business_unit_id_key,
  ADD CONSTRAINT inventory_cost_balance_variant_unit_tracking_key
    UNIQUE (item_variant_id, business_unit_id, tracking_mode);

CREATE INDEX item_variant_workspace_code_idx ON item_variant(workspace_id, variant_code);
CREATE INDEX item_variant_attributes_gin_idx ON item_variant USING gin(attributes_json);
CREATE INDEX inventory_lot_variant_tracking_date_idx
  ON inventory_lot(item_variant_id, tracking_mode, received_date, id);

ALTER TABLE unique_stock_unit
  DROP CONSTRAINT IF EXISTS unique_stock_unit_individual_code_key;
