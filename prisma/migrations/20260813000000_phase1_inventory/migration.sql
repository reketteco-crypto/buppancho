CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE counterparty_type AS ENUM ('supplier', 'customer', 'agent', 'carrier', 'other');
CREATE TYPE sequence_kind AS ENUM ('item', 'unit', 'purchase');
CREATE TYPE inventory_management_type AS ENUM ('quantity', 'unique');
CREATE TYPE management_cost_method AS ENUM ('moving_average', 'fifo', 'specific');
CREATE TYPE inventory_item_status AS ENUM ('active', 'inactive');
CREATE TYPE inventory_cost_status AS ENUM ('provisional', 'final');
CREATE TYPE unique_stock_status AS ENUM ('in_stock', 'reserved', 'sold', 'returned', 'disposed', 'lost', 'personal_use', 'purchase_cancelled');
CREATE TYPE purchase_type AS ENUM ('domestic', 'rakumart_import', 'used_bundle', 'other');
CREATE TYPE purchase_status AS ENUM ('draft', 'ordered', 'paid', 'partially_received', 'received', 'costing', 'finalized', 'cancelled');
CREATE TYPE inventory_operation_type AS ENUM ('purchase_receipt', 'purchase_reversal', 'location_transfer', 'disposal', 'loss', 'personal_use', 'adjustment_in', 'adjustment_out');
CREATE TYPE stock_movement_type AS ENUM ('receipt', 'receipt_reversal', 'location_transfer', 'disposal', 'loss', 'personal_use', 'adjustment_in', 'adjustment_out');

CREATE TABLE storage_location (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  business_unit_id uuid REFERENCES business_unit(id) ON DELETE RESTRICT,
  code text NOT NULL,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, code),
  CONSTRAINT storage_location_code_check CHECK (code ~ '^[A-Z0-9_-]{1,40}$'),
  CONSTRAINT storage_location_name_check CHECK (length(trim(name)) BETWEEN 1 AND 80)
);
CREATE INDEX storage_location_workspace_active_idx ON storage_location(workspace_id, active);
CREATE INDEX storage_location_business_unit_idx ON storage_location(business_unit_id);

CREATE TABLE counterparty (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  name text NOT NULL,
  type counterparty_type NOT NULL DEFAULT 'supplier',
  currency text NOT NULL DEFAULT 'JPY',
  memo text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, name, type),
  CONSTRAINT counterparty_name_check CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT counterparty_currency_check CHECK (currency = 'JPY')
);
CREATE INDEX counterparty_workspace_type_active_idx ON counterparty(workspace_id, type, active);

CREATE TABLE workspace_sequence (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  kind sequence_kind NOT NULL,
  next_value bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, kind),
  CONSTRAINT workspace_sequence_positive_check CHECK (next_value > 0)
);

CREATE TABLE inventory_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT,
  item_code text NOT NULL,
  name text NOT NULL,
  category text,
  management_type inventory_management_type NOT NULL,
  management_cost_method management_cost_method NOT NULL,
  default_storage_location_id uuid REFERENCES storage_location(id) ON DELETE RESTRICT,
  status inventory_item_status NOT NULL DEFAULT 'active',
  memo text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, item_code),
  CONSTRAINT inventory_item_code_check CHECK (item_code ~ '^[A-Z0-9_-]{1,40}$'),
  CONSTRAINT inventory_item_name_check CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT inventory_item_cost_method_check CHECK (
    (management_type = 'quantity' AND management_cost_method IN ('moving_average', 'fifo')) OR
    (management_type = 'unique' AND management_cost_method = 'specific')
  )
);
CREATE INDEX inventory_item_workspace_unit_status_idx ON inventory_item(workspace_id, business_unit_id, status);
CREATE INDEX inventory_item_name_trgm_idx ON inventory_item USING gin(name gin_trgm_ops);

CREATE TABLE item_variant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES inventory_item(id) ON DELETE RESTRICT,
  variant_code text NOT NULL,
  attributes_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (inventory_item_id, variant_code),
  CONSTRAINT item_variant_code_check CHECK (variant_code ~ '^[A-Z0-9_-]{1,40}$'),
  CONSTRAINT item_variant_attributes_check CHECK (jsonb_typeof(attributes_json) = 'object')
);
CREATE INDEX item_variant_item_active_idx ON item_variant(inventory_item_id, active);

CREATE TABLE purchase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT,
  reporting_entity_id uuid NOT NULL REFERENCES reporting_entity(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL REFERENCES counterparty(id) ON DELETE RESTRICT,
  storage_location_id uuid NOT NULL REFERENCES storage_location(id) ON DELETE RESTRICT,
  purchase_type purchase_type NOT NULL,
  purchase_code text NOT NULL,
  request_key uuid NOT NULL UNIQUE,
  order_number text,
  purchased_date date NOT NULL,
  currency text NOT NULL DEFAULT 'JPY',
  purchase_total_jpy bigint NOT NULL,
  expected_item_count integer,
  status purchase_status NOT NULL DEFAULT 'draft',
  memo text,
  finalized_at timestamptz(3),
  cancelled_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, purchase_code),
  CONSTRAINT purchase_code_check CHECK (purchase_code ~ '^PUR-[0-9]{6,}$'),
  CONSTRAINT purchase_currency_check CHECK (currency = 'JPY'),
  CONSTRAINT purchase_amount_check CHECK (purchase_total_jpy >= 0),
  CONSTRAINT purchase_count_check CHECK (expected_item_count IS NULL OR expected_item_count > 0),
  CONSTRAINT purchase_status_time_check CHECK (
    (status = 'finalized' AND finalized_at IS NOT NULL AND cancelled_at IS NULL) OR
    (status = 'cancelled' AND finalized_at IS NOT NULL AND cancelled_at IS NOT NULL) OR
    (status NOT IN ('finalized', 'cancelled') AND finalized_at IS NULL AND cancelled_at IS NULL)
  )
);
CREATE INDEX purchase_workspace_unit_date_idx ON purchase(workspace_id, business_unit_id, purchased_date);
CREATE INDEX purchase_status_date_idx ON purchase(status, purchased_date);

CREATE TABLE purchase_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id uuid NOT NULL REFERENCES purchase(id) ON DELETE CASCADE,
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  source_name text NOT NULL,
  source_url text,
  ordered_quantity integer NOT NULL,
  product_amount_jpy bigint NOT NULL,
  final_landed_cost_jpy bigint NOT NULL,
  draft_individual_code text,
  draft_condition text,
  draft_measurements_json jsonb,
  draft_memo text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT purchase_line_quantity_check CHECK (ordered_quantity > 0),
  CONSTRAINT purchase_line_amount_check CHECK (product_amount_jpy >= 0 AND final_landed_cost_jpy >= 0),
  CONSTRAINT purchase_line_url_check CHECK (source_url IS NULL OR source_url ~ '^https?://'),
  CONSTRAINT purchase_line_measurements_check CHECK (draft_measurements_json IS NULL OR jsonb_typeof(draft_measurements_json) = 'object')
);
CREATE INDEX purchase_line_purchase_idx ON purchase_line(purchase_id);
CREATE INDEX purchase_line_variant_idx ON purchase_line(item_variant_id);

CREATE TABLE inventory_lot (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  purchase_line_id uuid UNIQUE REFERENCES purchase_line(id) ON DELETE RESTRICT,
  received_date date NOT NULL,
  received_quantity integer NOT NULL,
  remaining_quantity integer NOT NULL,
  landed_cost_total_jpy bigint NOT NULL,
  unit_cost_jpy decimal(20,6) NOT NULL,
  cost_status inventory_cost_status NOT NULL DEFAULT 'final',
  storage_location_id uuid NOT NULL REFERENCES storage_location(id) ON DELETE RESTRICT,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inventory_lot_quantity_check CHECK (received_quantity > 0 AND remaining_quantity BETWEEN 0 AND received_quantity),
  CONSTRAINT inventory_lot_cost_check CHECK (landed_cost_total_jpy >= 0 AND unit_cost_jpy >= 0)
);
CREATE INDEX inventory_lot_variant_date_idx ON inventory_lot(item_variant_id, received_date, id);

CREATE TABLE unique_stock_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  inventory_lot_id uuid NOT NULL REFERENCES inventory_lot(id) ON DELETE RESTRICT,
  individual_code text NOT NULL,
  condition text NOT NULL,
  measurements_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  acquisition_cost_jpy bigint NOT NULL,
  storage_location_id uuid NOT NULL REFERENCES storage_location(id) ON DELETE RESTRICT,
  status unique_stock_status NOT NULL DEFAULT 'in_stock',
  memo text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, individual_code),
  CONSTRAINT unique_stock_code_check CHECK (individual_code ~ '^[A-Z0-9_-]{1,50}$'),
  CONSTRAINT unique_stock_condition_check CHECK (length(trim(condition)) BETWEEN 1 AND 200),
  CONSTRAINT unique_stock_measurements_check CHECK (jsonb_typeof(measurements_json) = 'object'),
  CONSTRAINT unique_stock_cost_check CHECK (acquisition_cost_jpy >= 0)
);
CREATE INDEX unique_stock_variant_status_idx ON unique_stock_unit(item_variant_id, status);
CREATE INDEX unique_stock_location_status_idx ON unique_stock_unit(storage_location_id, status);
CREATE INDEX unique_stock_code_trgm_idx ON unique_stock_unit USING gin(individual_code gin_trgm_ops);

CREATE TABLE inventory_cost_balance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT,
  quantity integer NOT NULL DEFAULT 0,
  carrying_cost_total_jpy bigint NOT NULL DEFAULT 0,
  average_unit_cost_jpy decimal(20,6) NOT NULL DEFAULT 0,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (item_variant_id, business_unit_id),
  CONSTRAINT inventory_cost_balance_nonnegative_check CHECK (quantity >= 0 AND carrying_cost_total_jpy >= 0 AND average_unit_cost_jpy >= 0),
  CONSTRAINT inventory_cost_balance_zero_check CHECK ((quantity = 0) = (carrying_cost_total_jpy = 0))
);
CREATE INDEX inventory_cost_balance_unit_quantity_idx ON inventory_cost_balance(business_unit_id, quantity);

CREATE TABLE inventory_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT,
  operator_id uuid NOT NULL REFERENCES operator(id) ON DELETE RESTRICT,
  operation_type inventory_operation_type NOT NULL,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  idempotency_key uuid NOT NULL UNIQUE,
  occurred_at timestamptz(3) NOT NULL,
  note text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX inventory_operation_workspace_time_idx ON inventory_operation(workspace_id, occurred_at);
CREATE INDEX inventory_operation_source_idx ON inventory_operation(source_type, source_id);

CREATE TABLE stock_movement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES inventory_operation(id) ON DELETE RESTRICT,
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  inventory_lot_id uuid REFERENCES inventory_lot(id) ON DELETE RESTRICT,
  unique_stock_unit_id uuid REFERENCES unique_stock_unit(id) ON DELETE RESTRICT,
  movement_type stock_movement_type NOT NULL,
  quantity integer NOT NULL,
  cost_total_jpy bigint NOT NULL,
  movement_at timestamptz(3) NOT NULL,
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT,
  storage_location_from_id uuid REFERENCES storage_location(id) ON DELETE RESTRICT,
  storage_location_to_id uuid REFERENCES storage_location(id) ON DELETE RESTRICT,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  operator_id uuid NOT NULL REFERENCES operator(id) ON DELETE RESTRICT,
  note text,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT stock_movement_quantity_check CHECK (quantity <> 0),
  CONSTRAINT stock_movement_cost_check CHECK (
    (quantity > 0 AND cost_total_jpy >= 0) OR (quantity < 0 AND cost_total_jpy <= 0)
  ),
  CONSTRAINT stock_movement_location_check CHECK (
    (movement_type = 'location_transfer' AND quantity > 0 AND storage_location_from_id IS NOT NULL AND storage_location_to_id IS NOT NULL AND storage_location_from_id <> storage_location_to_id) OR
    (movement_type IN ('receipt', 'adjustment_in') AND quantity > 0 AND storage_location_from_id IS NULL AND storage_location_to_id IS NOT NULL) OR
    (movement_type IN ('receipt_reversal', 'disposal', 'loss', 'personal_use', 'adjustment_out') AND quantity < 0 AND storage_location_from_id IS NOT NULL AND storage_location_to_id IS NULL)
  )
);
CREATE INDEX stock_movement_variant_time_idx ON stock_movement(item_variant_id, movement_at);
CREATE INDEX stock_movement_lot_time_idx ON stock_movement(inventory_lot_id, movement_at);
CREATE INDEX stock_movement_unit_time_idx ON stock_movement(unique_stock_unit_id, movement_at);
CREATE INDEX stock_movement_business_unit_time_idx ON stock_movement(business_unit_id, movement_at);
