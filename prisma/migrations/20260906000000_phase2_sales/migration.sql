ALTER TYPE sequence_kind ADD VALUE 'sales_sku';
ALTER TYPE inventory_operation_type ADD VALUE 'sale_completion';
ALTER TYPE inventory_operation_type ADD VALUE 'sale_return';
ALTER TYPE stock_movement_type ADD VALUE 'sale_out';
ALTER TYPE stock_movement_type ADD VALUE 'return_in';
ALTER TYPE stock_movement_type ADD VALUE 'return_defective';
ALTER TYPE stock_movement_type ADD VALUE 'return_disposal';

ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_location_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_location_check CHECK (
  (movement_type = 'location_transfer' AND quantity > 0 AND storage_location_from_id IS NOT NULL AND storage_location_to_id IS NOT NULL AND storage_location_from_id <> storage_location_to_id) OR
  (movement_type IN ('receipt','adjustment_in','return_in','return_defective','return_disposal') AND quantity > 0 AND storage_location_from_id IS NULL AND storage_location_to_id IS NOT NULL) OR
  (movement_type IN ('receipt_reversal','disposal','loss','personal_use','adjustment_out','sale_out') AND quantity < 0 AND storage_location_from_id IS NOT NULL AND storage_location_to_id IS NULL)
);

CREATE TYPE sales_channel_type AS ENUM ('mercari', 'rakuma', 'yahoo_fleamarket', 'mercari_shops', 'other');
CREATE TYPE sales_sku_type AS ENUM ('single', 'bundle');
CREATE TYPE listing_status AS ENUM ('draft', 'active', 'paused', 'sold_out', 'ended');
CREATE TYPE sales_order_status AS ENUM ('draft', 'confirmed', 'awaiting_shipment', 'shipped', 'awaiting_completion', 'completed', 'cancelled', 'returned');
CREATE TYPE reservation_status AS ENUM ('reserved', 'consumed', 'released');
CREATE TYPE shipment_status AS ENUM ('pending', 'shipped', 'delivered', 'returned');
CREATE TYPE return_disposition AS ENUM ('restock', 'defective', 'disposed');

CREATE TABLE sales_channel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  name text NOT NULL, type sales_channel_type NOT NULL, default_fee_rate decimal(7,6), default_shipping_payer text,
  active boolean NOT NULL DEFAULT true, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace_id, type), CONSTRAINT sales_channel_name_check CHECK (length(trim(name)) BETWEEN 1 AND 80),
  CONSTRAINT sales_channel_fee_check CHECK (default_fee_rate IS NULL OR default_fee_rate BETWEEN 0 AND 1)
);
CREATE INDEX sales_channel_workspace_active_idx ON sales_channel(workspace_id, active);

INSERT INTO sales_channel(workspace_id, name, type)
SELECT w.id, seed.name, seed.type::sales_channel_type FROM workspace w CROSS JOIN (VALUES
  ('メルカリ','mercari'),('ラクマ','rakuma'),('Yahoo!フリマ','yahoo_fleamarket'),('メルカリShops','mercari_shops'),('その他','other')
) AS seed(name,type) ON CONFLICT DO NOTHING;

CREATE TABLE sales_sku (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT, sku_code text NOT NULL, name text NOT NULL,
  sku_type sales_sku_type NOT NULL, description text, expected_price_jpy bigint, active boolean NOT NULL DEFAULT true,
  request_key uuid NOT NULL UNIQUE, created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(workspace_id, sku_code),
  CONSTRAINT sales_sku_code_check CHECK (sku_code ~ '^SKU-[0-9]{6,}$'),
  CONSTRAINT sales_sku_name_check CHECK (length(trim(name)) BETWEEN 1 AND 120),
  CONSTRAINT sales_sku_price_check CHECK (expected_price_jpy IS NULL OR expected_price_jpy >= 0)
);
CREATE INDEX sales_sku_workspace_unit_active_idx ON sales_sku(workspace_id,business_unit_id,active);

CREATE TABLE sales_sku_component (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_sku_id uuid NOT NULL REFERENCES sales_sku(id) ON DELETE CASCADE,
  item_variant_id uuid REFERENCES item_variant(id) ON DELETE RESTRICT,
  unique_stock_unit_id uuid REFERENCES unique_stock_unit(id) ON DELETE RESTRICT, required_quantity integer NOT NULL,
  UNIQUE(sales_sku_id,item_variant_id), UNIQUE(sales_sku_id,unique_stock_unit_id),
  CONSTRAINT sales_sku_component_target_check CHECK ((item_variant_id IS NULL) <> (unique_stock_unit_id IS NULL)),
  CONSTRAINT sales_sku_component_quantity_check CHECK (required_quantity > 0 AND (unique_stock_unit_id IS NULL OR required_quantity = 1))
);
CREATE INDEX sales_sku_component_variant_idx ON sales_sku_component(item_variant_id);
CREATE INDEX sales_sku_component_unit_idx ON sales_sku_component(unique_stock_unit_id);

CREATE TABLE listing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_sku_id uuid NOT NULL REFERENCES sales_sku(id) ON DELETE RESTRICT,
  sales_channel_id uuid NOT NULL REFERENCES sales_channel(id) ON DELETE RESTRICT, external_listing_id text, url text,
  listed_at timestamptz(3) NOT NULL, current_price_jpy bigint NOT NULL, listed_quantity integer NOT NULL,
  reserved_quantity integer NOT NULL DEFAULT 0, expected_shipping_jpy bigint, fee_rate decimal(7,6) NOT NULL,
  status listing_status NOT NULL DEFAULT 'draft', request_key uuid NOT NULL UNIQUE,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sales_channel_id,external_listing_id),
  CONSTRAINT listing_url_check CHECK (url IS NULL OR url ~ '^https?://'),
  CONSTRAINT listing_amount_check CHECK (current_price_jpy >= 0 AND (expected_shipping_jpy IS NULL OR expected_shipping_jpy >= 0)),
  CONSTRAINT listing_quantity_check CHECK (listed_quantity >= 0 AND reserved_quantity BETWEEN 0 AND listed_quantity),
  CONSTRAINT listing_fee_check CHECK (fee_rate BETWEEN 0 AND 1)
);
CREATE INDEX listing_sku_status_idx ON listing(sales_sku_id,status);

CREATE TABLE listing_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), listing_id uuid NOT NULL REFERENCES listing(id) ON DELETE RESTRICT,
  price_jpy bigint NOT NULL, effective_at timestamptz(3) NOT NULL, reason text,
  operator_id uuid NOT NULL REFERENCES operator(id) ON DELETE RESTRICT, idempotency_key uuid NOT NULL UNIQUE,
  CONSTRAINT listing_price_history_price_check CHECK (price_jpy >= 0)
);
CREATE INDEX listing_price_history_listing_time_idx ON listing_price_history(listing_id,effective_at);

CREATE TABLE sales_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE RESTRICT,
  business_unit_id uuid NOT NULL REFERENCES business_unit(id) ON DELETE RESTRICT,
  reporting_entity_id uuid NOT NULL REFERENCES reporting_entity(id) ON DELETE RESTRICT,
  sales_channel_id uuid NOT NULL REFERENCES sales_channel(id) ON DELETE RESTRICT, external_order_id text,
  ordered_at timestamptz(3) NOT NULL, completed_at timestamptz(3), accounting_recognition_date date,
  status sales_order_status NOT NULL DEFAULT 'draft', gross_sales_jpy bigint NOT NULL, discount_jpy bigint NOT NULL DEFAULT 0,
  fee_jpy bigint, shipping_jpy bigint, packing_jpy bigint, other_cost_jpy bigint, channel_net_receivable_jpy bigint,
  cost_status inventory_cost_status NOT NULL DEFAULT 'provisional', memo text, request_key uuid NOT NULL UNIQUE,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sales_channel_id,external_order_id),
  CONSTRAINT sales_order_amount_check CHECK (gross_sales_jpy >= 0 AND discount_jpy >= 0 AND discount_jpy <= gross_sales_jpy AND
    (fee_jpy IS NULL OR fee_jpy >= 0) AND (shipping_jpy IS NULL OR shipping_jpy >= 0) AND
    (packing_jpy IS NULL OR packing_jpy >= 0) AND (other_cost_jpy IS NULL OR other_cost_jpy >= 0)),
  CONSTRAINT sales_order_completed_check CHECK ((status = 'completed' AND completed_at IS NOT NULL) OR status <> 'completed')
);
CREATE INDEX sales_order_workspace_unit_time_idx ON sales_order(workspace_id,business_unit_id,ordered_at);
CREATE INDEX sales_order_status_time_idx ON sales_order(status,ordered_at);

CREATE TABLE sales_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  listing_id uuid REFERENCES listing(id) ON DELETE RESTRICT, sales_sku_id uuid NOT NULL REFERENCES sales_sku(id) ON DELETE RESTRICT,
  quantity integer NOT NULL, unit_price_jpy bigint NOT NULL, allocated_discount_jpy bigint NOT NULL DEFAULT 0,
  management_cogs_jpy bigint, returned_quantity integer NOT NULL DEFAULT 0,
  CONSTRAINT sales_order_line_quantity_check CHECK (quantity > 0 AND returned_quantity BETWEEN 0 AND quantity),
  CONSTRAINT sales_order_line_amount_check CHECK (unit_price_jpy >= 0 AND allocated_discount_jpy >= 0 AND (management_cogs_jpy IS NULL OR management_cogs_jpy >= 0))
);
CREATE INDEX sales_order_line_order_idx ON sales_order_line(sales_order_id);
CREATE INDEX sales_order_line_sku_idx ON sales_order_line(sales_sku_id);

CREATE TABLE inventory_reservation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_line_id uuid NOT NULL REFERENCES sales_order_line(id) ON DELETE RESTRICT,
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  inventory_lot_id uuid REFERENCES inventory_lot(id) ON DELETE RESTRICT,
  unique_stock_unit_id uuid REFERENCES unique_stock_unit(id) ON DELETE RESTRICT,
  storage_location_id uuid NOT NULL REFERENCES storage_location(id) ON DELETE RESTRICT, quantity integer NOT NULL,
  status reservation_status NOT NULL DEFAULT 'reserved', created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT inventory_reservation_quantity_check CHECK (quantity > 0),
  CONSTRAINT inventory_reservation_target_check CHECK ((inventory_lot_id IS NULL) <> (unique_stock_unit_id IS NULL))
);
CREATE INDEX inventory_reservation_variant_status_idx ON inventory_reservation(item_variant_id,status);
CREATE INDEX inventory_reservation_lot_status_idx ON inventory_reservation(inventory_lot_id,status);
CREATE INDEX inventory_reservation_unit_status_idx ON inventory_reservation(unique_stock_unit_id,status);
CREATE UNIQUE INDEX inventory_reservation_unique_active_idx ON inventory_reservation(unique_stock_unit_id) WHERE unique_stock_unit_id IS NOT NULL AND status='reserved';

CREATE TABLE order_component_consumption (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_line_id uuid NOT NULL REFERENCES sales_order_line(id) ON DELETE RESTRICT,
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  inventory_lot_id uuid REFERENCES inventory_lot(id) ON DELETE RESTRICT,
  unique_stock_unit_id uuid REFERENCES unique_stock_unit(id) ON DELETE RESTRICT,
  storage_location_id uuid NOT NULL REFERENCES storage_location(id) ON DELETE RESTRICT, quantity integer NOT NULL,
  unit_cost_jpy decimal(20,6) NOT NULL, cost_total_jpy bigint NOT NULL,
  cost_status inventory_cost_status NOT NULL DEFAULT 'final', created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT order_consumption_quantity_check CHECK (quantity > 0),
  CONSTRAINT order_consumption_cost_check CHECK (unit_cost_jpy >= 0 AND cost_total_jpy >= 0),
  CONSTRAINT order_consumption_target_check CHECK ((inventory_lot_id IS NULL) <> (unique_stock_unit_id IS NULL))
);
CREATE INDEX order_consumption_line_idx ON order_component_consumption(sales_order_line_id);

CREATE TABLE shipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid NOT NULL UNIQUE REFERENCES sales_order(id) ON DELETE RESTRICT,
  shipped_at timestamptz(3), shipping_method text, tracking_number text, actual_shipping_jpy bigint,
  status shipment_status NOT NULL DEFAULT 'pending',
  CONSTRAINT shipment_amount_check CHECK (actual_shipping_jpy IS NULL OR actual_shipping_jpy >= 0)
);

CREATE TABLE sales_order_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  from_status sales_order_status, to_status sales_order_status NOT NULL, occurred_at timestamptz(3) NOT NULL,
  operator_id uuid NOT NULL REFERENCES operator(id) ON DELETE RESTRICT, reason text, idempotency_key uuid NOT NULL UNIQUE
);
CREATE INDEX sales_order_event_order_time_idx ON sales_order_event(sales_order_id,occurred_at);

CREATE TABLE sales_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid NOT NULL REFERENCES sales_order(id) ON DELETE RESTRICT,
  returned_at timestamptz(3) NOT NULL, sales_refund_jpy bigint NOT NULL DEFAULT 0, fee_refund_jpy bigint NOT NULL DEFAULT 0,
  shipping_refund_jpy bigint NOT NULL DEFAULT 0, memo text, request_key uuid NOT NULL UNIQUE,
  created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT sales_return_amount_check CHECK (sales_refund_jpy >= 0 AND fee_refund_jpy >= 0 AND shipping_refund_jpy >= 0)
);
CREATE INDEX sales_return_order_time_idx ON sales_return(sales_order_id,returned_at);

CREATE TABLE sales_return_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_return_id uuid NOT NULL REFERENCES sales_return(id) ON DELETE RESTRICT,
  sales_order_line_id uuid NOT NULL REFERENCES sales_order_line(id) ON DELETE RESTRICT, quantity integer NOT NULL,
  UNIQUE(sales_return_id,sales_order_line_id), CONSTRAINT sales_return_line_quantity_check CHECK (quantity > 0)
);

CREATE TABLE return_component_disposition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_return_line_id uuid NOT NULL REFERENCES sales_return_line(id) ON DELETE RESTRICT,
  consumption_id uuid REFERENCES order_component_consumption(id) ON DELETE RESTRICT,
  item_variant_id uuid NOT NULL REFERENCES item_variant(id) ON DELETE RESTRICT,
  inventory_lot_id uuid REFERENCES inventory_lot(id) ON DELETE RESTRICT,
  unique_stock_unit_id uuid REFERENCES unique_stock_unit(id) ON DELETE RESTRICT,
  storage_location_id uuid NOT NULL REFERENCES storage_location(id) ON DELETE RESTRICT, quantity integer NOT NULL,
  disposition return_disposition NOT NULL, cost_total_jpy bigint NOT NULL,
  CONSTRAINT return_disposition_quantity_check CHECK (quantity > 0),
  CONSTRAINT return_disposition_cost_check CHECK (cost_total_jpy >= 0),
  CONSTRAINT return_disposition_target_check CHECK ((inventory_lot_id IS NULL) <> (unique_stock_unit_id IS NULL))
);
CREATE INDEX return_component_disposition_line_idx ON return_component_disposition(sales_return_line_id);

CREATE OR REPLACE FUNCTION validate_sales_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE sku_workspace uuid; sku_unit uuid; target_workspace uuid; target_unit uuid;
BEGIN
  SELECT workspace_id,business_unit_id INTO sku_workspace,sku_unit FROM sales_sku WHERE id=NEW.sales_sku_id;
  IF NEW.item_variant_id IS NOT NULL THEN
    SELECT item_variant.workspace_id,inventory_item.business_unit_id INTO target_workspace,target_unit FROM item_variant
      JOIN inventory_item ON inventory_item.id=item_variant.inventory_item_id WHERE item_variant.id=NEW.item_variant_id;
  ELSE
    SELECT unique_stock_unit.workspace_id,inventory_item.business_unit_id INTO target_workspace,target_unit FROM unique_stock_unit
      JOIN item_variant ON item_variant.id=unique_stock_unit.item_variant_id
      JOIN inventory_item ON inventory_item.id=item_variant.inventory_item_id WHERE unique_stock_unit.id=NEW.unique_stock_unit_id;
  END IF;
  IF target_workspace IS DISTINCT FROM sku_workspace OR target_unit IS DISTINCT FROM sku_unit THEN
    RAISE EXCEPTION 'sales SKU component scope mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_sku_component_scope_trigger BEFORE INSERT OR UPDATE ON sales_sku_component
FOR EACH ROW EXECUTE FUNCTION validate_sales_scope();
