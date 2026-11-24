BEGIN;
-- DropIndex
ALTER TABLE sales_channel DROP CONSTRAINT sales_channel_workspace_id_type_key;

-- AlterTable
ALTER TABLE "sales_channel" ADD COLUMN     "default_delivery_method_id" UUID,
ADD COLUMN     "default_shipping_jpy" BIGINT;

-- AlterTable
ALTER TABLE "sales_sku" ADD COLUMN     "revision" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sales_order" ADD COLUMN     "buyer_name" TEXT,
ADD COLUMN     "recording_mode" TEXT NOT NULL DEFAULT 'LISTING',
ADD COLUMN     "sale_snapshot" JSONB,
ADD COLUMN     "source_draft_id" UUID;

-- CreateTable
CREATE TABLE "purchase_document" (
    "tax_amount_jpy" BIGINT,
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "reporting_entity_id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "supplier_name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "purchased_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ORDERED',
    "currency" TEXT NOT NULL DEFAULT 'JPY',
    "exchange_rate" DECIMAL(24,10) NOT NULL DEFAULT 1,
    "tax_mode" TEXT NOT NULL DEFAULT 'INCLUDED',
    "total_jpy" BIGINT NOT NULL,
    "cost_final" BOOLEAN NOT NULL DEFAULT true,
    "memo" TEXT,
    "request_key" UUID NOT NULL,
    "source_draft_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "purchase_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_document_line" (
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "item_variant_id" UUID,
    "name" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'STOCK',
    "tracking_mode" TEXT NOT NULL DEFAULT 'QUANTITY',
    "quantity" INTEGER NOT NULL,
    "amount" DECIMAL(24,8) NOT NULL,
    "price_basis" TEXT NOT NULL DEFAULT 'UNIT',
    "product_amount_jpy" BIGINT NOT NULL,
    "landed_cost_jpy" BIGINT NOT NULL,
    "received_quantity" INTEGER NOT NULL DEFAULT 0,
    "weight_g" DECIMAL(24,8),
    "volume_cm3" DECIMAL(24,8),

    CONSTRAINT "purchase_document_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_charge" (
    "allocated" BOOLEAN NOT NULL DEFAULT false,
    "id" UUID NOT NULL,
    "document_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "amount_jpy" BIGINT,
    "allocation_method" TEXT NOT NULL DEFAULT 'VALUE',
    "capitalized" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_charge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_charge_allocation" (
    "id" UUID NOT NULL,
    "charge_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "amount_jpy" BIGINT NOT NULL,

    CONSTRAINT "purchase_charge_allocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "reporting_entity_id" UUID NOT NULL,
    "received_date" DATE NOT NULL,
    "storage_location_id" UUID NOT NULL,
    "operation_id" UUID,
    "request_key" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt_line" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "line_id" UUID NOT NULL,
    "inventory_lot_id" UUID,
    "quantity" INTEGER NOT NULL,
    "cost_jpy" BIGINT NOT NULL,

    CONSTRAINT "purchase_receipt_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_method" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "name" TEXT NOT NULL,
    "default_shipping_jpy" BIGINT,
    "default_allocation_method" TEXT NOT NULL DEFAULT 'VALUE',
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "delivery_method_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_channel_setting" (
    "id" UUID NOT NULL,
    "sales_sku_id" UUID NOT NULL,
    "sales_channel_id" UUID NOT NULL,
    "delivery_method_id" UUID,
    "price_jpy" BIGINT,
    "shipping_jpy" BIGINT,

    CONSTRAINT "sku_channel_setting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_request_key_key" ON "purchase_document"("request_key");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_source_draft_id_key" ON "purchase_document"("source_draft_id");

-- CreateIndex
CREATE INDEX "purchase_document_workspace_id_business_unit_id_purchased_d_idx" ON "purchase_document"("workspace_id", "business_unit_id", "purchased_date");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_workspace_id_code_key" ON "purchase_document"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_line_document_id_position_key" ON "purchase_document_line"("document_id", "position");

-- CreateIndex
CREATE INDEX "purchase_charge_document_id_idx" ON "purchase_charge"("document_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_charge_allocation_charge_id_line_id_key" ON "purchase_charge_allocation"("charge_id", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipt_operation_id_key" ON "purchase_receipt"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipt_request_key_key" ON "purchase_receipt"("request_key");

-- CreateIndex
CREATE INDEX "purchase_receipt_workspace_id_business_unit_id_received_dat_idx" ON "purchase_receipt"("workspace_id", "business_unit_id", "received_date");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipt_line_inventory_lot_id_key" ON "purchase_receipt_line"("inventory_lot_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipt_line_receipt_id_line_id_key" ON "purchase_receipt_line"("receipt_id", "line_id");

-- CreateIndex
CREATE UNIQUE INDEX "delivery_method_workspace_id_name_key" ON "delivery_method"("workspace_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "sku_channel_setting_sales_sku_id_sales_channel_id_key" ON "sku_channel_setting"("sales_sku_id", "sales_channel_id");

-- CreateIndex
CREATE INDEX "sales_channel_workspace_id_type_idx" ON "sales_channel"("workspace_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "sales_order_source_draft_id_key" ON "sales_order"("source_draft_id");

-- AddForeignKey
ALTER TABLE "purchase_document_line" ADD CONSTRAINT "purchase_document_line_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "purchase_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_charge" ADD CONSTRAINT "purchase_charge_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "purchase_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_charge_allocation" ADD CONSTRAINT "purchase_charge_allocation_charge_id_fkey" FOREIGN KEY ("charge_id") REFERENCES "purchase_charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_charge_allocation" ADD CONSTRAINT "purchase_charge_allocation_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "purchase_document_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_line" ADD CONSTRAINT "purchase_receipt_line_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "purchase_receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_line" ADD CONSTRAINT "purchase_receipt_line_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "purchase_document_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_line" ADD CONSTRAINT "purchase_receipt_line_inventory_lot_id_fkey" FOREIGN KEY ("inventory_lot_id") REFERENCES "inventory_lot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_channel_setting" ADD CONSTRAINT "sku_channel_setting_sales_sku_id_fkey" FOREIGN KEY ("sales_sku_id") REFERENCES "sales_sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_channel_setting" ADD CONSTRAINT "sku_channel_setting_sales_channel_id_fkey" FOREIGN KEY ("sales_channel_id") REFERENCES "sales_channel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Scope and append-only guards for the new workflows.
ALTER TABLE workflow_draft DROP CONSTRAINT workflow_draft_kind_check;
ALTER TABLE workflow_draft ADD CONSTRAINT workflow_draft_kind_check CHECK(kind IN ('LISTING','PURCHASE','COMPLETION','RETURN','REFUND','LISTING_RETURN','COMMERCE_PURCHASE','COMMERCE_SALE'));
ALTER TABLE purchase_document ADD CONSTRAINT purchase_document_scope_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id), ADD CONSTRAINT purchase_document_scope_unit FOREIGN KEY(business_unit_id) REFERENCES business_unit(id), ADD CONSTRAINT purchase_document_supplier FOREIGN KEY(supplier_id) REFERENCES counterparty(id), ADD CONSTRAINT purchase_document_entity FOREIGN KEY(reporting_entity_id) REFERENCES reporting_entity(id), ADD CONSTRAINT purchase_document_amount CHECK(total_jpy>=0 AND (tax_amount_jpy IS NULL OR tax_amount_jpy>=0)), ADD CONSTRAINT purchase_document_state CHECK(status IN ('ORDERED','PARTIALLY_RECEIVED','RECEIVED','CANCELLED'));
ALTER TABLE purchase_document_line ADD CONSTRAINT purchase_document_line_variant FOREIGN KEY(item_variant_id) REFERENCES item_variant(id), ADD CONSTRAINT purchase_document_line_amount CHECK(quantity>0 AND received_quantity BETWEEN 0 AND quantity AND product_amount_jpy>=0 AND landed_cost_jpy>=0 AND amount>=0), ADD CONSTRAINT purchase_document_line_mode CHECK(tracking_mode IN ('QUANTITY','UNIQUE','NONE') AND (tracking_mode<>'UNIQUE' OR quantity=1)), ADD CONSTRAINT purchase_document_line_basis CHECK(price_basis IN ('UNIT','LINE'));
ALTER TABLE purchase_receipt ADD CONSTRAINT purchase_receipt_operation FOREIGN KEY(operation_id) REFERENCES inventory_operation(id), ADD CONSTRAINT purchase_receipt_location FOREIGN KEY(storage_location_id) REFERENCES storage_location(id);
ALTER TABLE purchase_receipt_line ADD CONSTRAINT purchase_receipt_line_amount CHECK(quantity>0 AND cost_jpy>=0);
ALTER TABLE purchase_charge ADD CONSTRAINT purchase_charge_method CHECK(allocation_method IN ('VALUE','QUANTITY','WEIGHT','VOLUME','EQUAL','MANUAL'));
ALTER TABLE delivery_method ADD CONSTRAINT delivery_method_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id), ADD CONSTRAINT delivery_method_amount CHECK(default_shipping_jpy IS NULL OR default_shipping_jpy>=0), ADD CONSTRAINT delivery_method_allocation CHECK(default_allocation_method IN ('VALUE','QUANTITY','WEIGHT','VOLUME','EQUAL','MANUAL'));
ALTER TABLE sku_channel_setting ADD CONSTRAINT sku_channel_method FOREIGN KEY(delivery_method_id) REFERENCES delivery_method(id), ADD CONSTRAINT sku_channel_amount CHECK((price_jpy IS NULL OR price_jpy>=0) AND (shipping_jpy IS NULL OR shipping_jpy>=0));
ALTER TABLE sales_channel ADD CONSTRAINT sales_channel_method FOREIGN KEY(default_delivery_method_id) REFERENCES delivery_method(id);
ALTER TABLE sales_order ADD CONSTRAINT sales_order_recording_mode CHECK(recording_mode IN ('LISTING','DIRECT'));

CREATE FUNCTION guard_purchase_document_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM business_unit u JOIN reporting_entity e ON e.id=NEW.reporting_entity_id JOIN counterparty c ON c.id=NEW.supplier_id WHERE u.id=NEW.business_unit_id AND u.workspace_id=NEW.workspace_id AND e.workspace_id=NEW.workspace_id AND c.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'purchase document scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_document_scope BEFORE INSERT OR UPDATE ON purchase_document FOR EACH ROW EXECUTE FUNCTION guard_purchase_document_scope();
CREATE FUNCTION guard_purchase_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.item_variant_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM purchase_document p JOIN item_variant v ON v.id=NEW.item_variant_id JOIN inventory_item i ON i.id=v.inventory_item_id WHERE p.id=NEW.document_id AND v.workspace_id=p.workspace_id AND i.business_unit_id=p.business_unit_id) THEN RAISE EXCEPTION 'purchase line scope mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.document_id<>OLD.document_id OR NEW.position<>OLD.position OR NEW.item_variant_id IS DISTINCT FROM OLD.item_variant_id OR NEW.name<>OLD.name OR NEW.quantity<>OLD.quantity OR NEW.amount<>OLD.amount OR NEW.product_amount_jpy<>OLD.product_amount_jpy OR NEW.tracking_mode<>OLD.tracking_mode) THEN RAISE EXCEPTION 'recorded purchase line is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_line_scope BEFORE INSERT OR UPDATE ON purchase_document_line FOR EACH ROW EXECUTE FUNCTION guard_purchase_line_scope();
CREATE FUNCTION guard_purchase_receipt_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM business_unit u JOIN reporting_entity e ON e.id=NEW.reporting_entity_id JOIN storage_location l ON l.id=NEW.storage_location_id WHERE u.id=NEW.business_unit_id AND u.workspace_id=NEW.workspace_id AND e.workspace_id=NEW.workspace_id AND l.workspace_id=NEW.workspace_id AND (l.business_unit_id IS NULL OR l.business_unit_id=NEW.business_unit_id)) THEN RAISE EXCEPTION 'receipt scope mismatch'; END IF;
 IF NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_operation o WHERE o.id=NEW.operation_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id) THEN RAISE EXCEPTION 'receipt operation scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER purchase_receipt_scope BEFORE INSERT ON purchase_receipt FOR EACH ROW EXECUTE FUNCTION guard_purchase_receipt_scope();
CREATE FUNCTION guard_receipt_line_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM purchase_receipt r JOIN purchase_document_line l ON l.id=NEW.line_id JOIN purchase_document p ON p.id=l.document_id WHERE r.id=NEW.receipt_id AND r.workspace_id=p.workspace_id AND r.business_unit_id=p.business_unit_id AND r.reporting_entity_id=p.reporting_entity_id) THEN RAISE EXCEPTION 'receipt line scope mismatch'; END IF;
 IF NEW.inventory_lot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_lot lot JOIN purchase_document_line l ON l.id=NEW.line_id WHERE lot.id=NEW.inventory_lot_id AND lot.item_variant_id=l.item_variant_id AND lot.received_quantity=NEW.quantity) THEN RAISE EXCEPTION 'receipt lot mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_line_scope BEFORE INSERT ON purchase_receipt_line FOR EACH ROW EXECUTE FUNCTION guard_receipt_line_scope();
CREATE FUNCTION guard_charge_allocation_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM purchase_charge c JOIN purchase_document_line l ON l.id=NEW.line_id WHERE c.id=NEW.charge_id AND c.document_id=l.document_id) THEN RAISE EXCEPTION 'allocation scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER charge_allocation_scope BEFORE INSERT ON purchase_charge_allocation FOR EACH ROW EXECUTE FUNCTION guard_charge_allocation_scope();
CREATE FUNCTION check_charge_allocation_sum() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target uuid; charge purchase_charge; allocated_sum bigint; BEGIN
 target:=CASE WHEN TG_TABLE_NAME='purchase_charge' THEN NEW.id ELSE NEW.charge_id END;
 SELECT * INTO charge FROM purchase_charge WHERE id=target;
 SELECT COALESCE(sum(amount_jpy),0) INTO allocated_sum FROM purchase_charge_allocation WHERE charge_id=target;
 IF charge.allocated AND (charge.amount_jpy IS NULL OR charge.amount_jpy<>allocated_sum) THEN RAISE EXCEPTION 'allocation sum mismatch'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER charge_allocation_sum AFTER INSERT ON purchase_charge DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_charge_allocation_sum();
CREATE CONSTRAINT TRIGGER charge_allocation_row_sum AFTER INSERT ON purchase_charge_allocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_charge_allocation_sum();
CREATE FUNCTION guard_sku_channel_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sales_sku s JOIN sales_channel c ON c.id=NEW.sales_channel_id WHERE s.id=NEW.sales_sku_id AND s.workspace_id=c.workspace_id AND (NEW.delivery_method_id IS NULL OR EXISTS(SELECT 1 FROM delivery_method m WHERE m.id=NEW.delivery_method_id AND m.workspace_id=s.workspace_id))) THEN RAISE EXCEPTION 'sku channel scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sku_channel_scope BEFORE INSERT OR UPDATE ON sku_channel_setting FOR EACH ROW EXECUTE FUNCTION guard_sku_channel_scope();
CREATE TRIGGER purchase_document_revision BEFORE UPDATE ON purchase_document FOR EACH ROW EXECUTE FUNCTION advance_master_revision();
CREATE TRIGGER delivery_method_revision BEFORE UPDATE ON delivery_method FOR EACH ROW EXECUTE FUNCTION advance_master_revision();
CREATE TRIGGER sales_sku_revision BEFORE UPDATE ON sales_sku FOR EACH ROW EXECUTE FUNCTION advance_master_revision();
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['purchase_charge','purchase_charge_allocation','purchase_receipt','purchase_receipt_line'] LOOP
  EXECUTE format('CREATE TRIGGER recorded_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation()',target);
 END LOOP;
 FOREACH target IN ARRAY ARRAY['purchase_document','purchase_document_line'] LOOP
  EXECUTE format('CREATE TRIGGER recorded_no_delete BEFORE DELETE ON %I FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation()',target);
 END LOOP;
END $$;

COMMIT;
