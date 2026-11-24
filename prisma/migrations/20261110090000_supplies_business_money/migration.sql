BEGIN;
-- AlterTable
ALTER TABLE "sales_channel" ADD COLUMN     "fee_deducted" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "receiving_account_id" UUID,
ADD COLUMN     "shipping_deducted" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "sales_order" ADD COLUMN     "settlement_snapshot" JSONB;

-- AlterTable
ALTER TABLE "purchase_document_line" ADD COLUMN     "supply_item_id" UUID;

-- CreateTable
CREATE TABLE "supply_item" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "unit" TEXT NOT NULL DEFAULT '点',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supply_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sku_supply_setting" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "supply_item_id" UUID NOT NULL,
    "purpose" TEXT NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "unit_cost_jpy" DECIMAL(24,8),

    CONSTRAINT "sku_supply_setting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_use" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "reporting_entity_id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "supply_item_id" UUID NOT NULL,
    "supply_name" TEXT NOT NULL,
    "purchase_line_id" UUID,
    "purpose" TEXT NOT NULL,
    "quantity" DECIMAL(20,8) NOT NULL,
    "unit_cost_jpy" DECIMAL(24,8),
    "cost_jpy" BIGINT,
    "cost_final" BOOLEAN NOT NULL,
    "date" DATE NOT NULL,
    "reason" TEXT,
    "supersedes_id" UUID,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_use_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_category" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "money_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "other_record" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "reporting_entity_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "category_id" UUID NOT NULL,
    "category_name" TEXT NOT NULL,
    "amount_jpy" BIGINT NOT NULL,
    "source_sale_id" UUID,
    "source_purchase_id" UUID,
    "counterparty" TEXT,
    "memo" TEXT,
    "reverses_id" UUID,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "other_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "supply_item_workspace_id_business_unit_id_kind_idx" ON "supply_item"("workspace_id", "business_unit_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "sku_supply_setting_sku_id_supply_item_id_purpose_key" ON "sku_supply_setting"("sku_id", "supply_item_id", "purpose");

-- CreateIndex
CREATE UNIQUE INDEX "material_use_supersedes_id_key" ON "material_use"("supersedes_id");

-- CreateIndex
CREATE INDEX "material_use_workspace_id_business_unit_id_date_idx" ON "material_use"("workspace_id", "business_unit_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "money_category_workspace_id_name_kind_key" ON "money_category"("workspace_id", "name", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "other_record_reverses_id_key" ON "other_record"("reverses_id");

-- CreateIndex
CREATE UNIQUE INDEX "other_record_request_id_key" ON "other_record"("request_id");

-- CreateIndex
CREATE INDEX "other_record_workspace_id_business_unit_id_date_idx" ON "other_record"("workspace_id", "business_unit_id", "date");

-- AddForeignKey
ALTER TABLE "purchase_document_line" ADD CONSTRAINT "purchase_document_line_supply_item_id_fkey" FOREIGN KEY ("supply_item_id") REFERENCES "supply_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_supply_setting" ADD CONSTRAINT "sku_supply_setting_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sales_sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sku_supply_setting" ADD CONSTRAINT "sku_supply_setting_supply_item_id_fkey" FOREIGN KEY ("supply_item_id") REFERENCES "supply_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_use" ADD CONSTRAINT "material_use_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "material_use"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_use" ADD CONSTRAINT "material_use_supply_item_id_fkey" FOREIGN KEY ("supply_item_id") REFERENCES "supply_item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_use" ADD CONSTRAINT "material_use_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_record" ADD CONSTRAINT "other_record_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "other_record"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "other_record" ADD CONSTRAINT "other_record_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "money_category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE supply_item ADD CONSTRAINT supply_item_kind CHECK(kind IN ('MATERIAL','EQUIPMENT')), ADD CONSTRAINT supply_item_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id), ADD CONSTRAINT supply_item_unit FOREIGN KEY(business_unit_id) REFERENCES business_unit(id);
CREATE FUNCTION guard_supply_item() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM business_unit u WHERE u.id=NEW.business_unit_id AND u.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'supply scope mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.business_unit_id<>OLD.business_unit_id OR NEW.kind<>OLD.kind) THEN RAISE EXCEPTION 'supply ownership is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supply_scope BEFORE INSERT OR UPDATE ON supply_item FOR EACH ROW EXECUTE FUNCTION guard_supply_item();
CREATE TRIGGER supply_revision BEFORE UPDATE ON supply_item FOR EACH ROW EXECUTE FUNCTION advance_master_revision();
CREATE TRIGGER supply_no_delete BEFORE DELETE ON supply_item FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
ALTER TABLE sku_supply_setting ADD CONSTRAINT sku_supply_amount CHECK(quantity>0 AND (unit_cost_jpy IS NULL OR unit_cost_jpy>=0) AND purpose IN ('PACKING','COMPONENT'));
CREATE FUNCTION guard_sku_supply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sales_sku k JOIN supply_item s ON s.id=NEW.supply_item_id WHERE k.id=NEW.sku_id AND k.workspace_id=s.workspace_id AND k.business_unit_id=s.business_unit_id AND s.kind='MATERIAL') THEN RAISE EXCEPTION 'sku supply scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER sku_supply_scope BEFORE INSERT OR UPDATE ON sku_supply_setting FOR EACH ROW EXECUTE FUNCTION guard_sku_supply();
CREATE FUNCTION advance_sku_supply_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN UPDATE sales_sku SET revision=revision+1 WHERE id=OLD.sku_id; ELSE UPDATE sales_sku SET revision=revision+1 WHERE id=NEW.sku_id; END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER sku_supply_revision AFTER INSERT OR UPDATE OR DELETE ON sku_supply_setting FOR EACH ROW EXECUTE FUNCTION advance_sku_supply_revision();
ALTER TABLE material_use ADD CONSTRAINT material_use_amount CHECK(quantity>=0 AND (unit_cost_jpy IS NULL OR unit_cost_jpy>=0) AND (cost_jpy IS NULL OR cost_jpy>=0) AND (NOT cost_final OR (unit_cost_jpy IS NOT NULL AND cost_jpy IS NOT NULL)) AND purpose IN ('PACKING','COMPONENT')), ADD CONSTRAINT material_use_purchase FOREIGN KEY(purchase_line_id) REFERENCES purchase_document_line(id);
CREATE FUNCTION guard_material_use() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM sales_order o JOIN supply_item s ON s.id=NEW.supply_item_id WHERE o.id=NEW.sale_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id AND s.workspace_id=NEW.workspace_id AND s.business_unit_id=NEW.business_unit_id AND s.kind='MATERIAL') THEN RAISE EXCEPTION 'material use scope mismatch'; END IF;
 IF NEW.purchase_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM purchase_document_line l JOIN purchase_document p ON p.id=l.document_id WHERE l.id=NEW.purchase_line_id AND l.supply_item_id=NEW.supply_item_id AND p.workspace_id=NEW.workspace_id AND p.business_unit_id=NEW.business_unit_id AND p.reporting_entity_id=NEW.reporting_entity_id AND p.purchased_date<=NEW.date) THEN RAISE EXCEPTION 'material purchase scope mismatch'; END IF;
 IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM material_use m WHERE m.id=NEW.supersedes_id AND m.sale_id=NEW.sale_id AND m.supply_item_id=NEW.supply_item_id AND m.workspace_id=NEW.workspace_id AND m.business_unit_id=NEW.business_unit_id AND m.reporting_entity_id=NEW.reporting_entity_id) THEN RAISE EXCEPTION 'material revision mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER material_use_scope BEFORE INSERT ON material_use FOR EACH ROW EXECUTE FUNCTION guard_material_use();
CREATE TRIGGER material_use_immutable BEFORE UPDATE OR DELETE ON material_use FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
ALTER TABLE money_category ADD CONSTRAINT money_category_kind CHECK(kind IN ('EXPENSE','INCOME')), ADD CONSTRAINT money_category_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id);
CREATE FUNCTION guard_money_category() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.workspace_id<>OLD.workspace_id OR NEW.kind<>OLD.kind THEN RAISE EXCEPTION 'category scope and kind are immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER money_category_scope BEFORE UPDATE ON money_category FOR EACH ROW EXECUTE FUNCTION guard_money_category();
CREATE TRIGGER money_category_revision BEFORE UPDATE ON money_category FOR EACH ROW EXECUTE FUNCTION advance_master_revision();
CREATE TRIGGER money_category_no_delete BEFORE DELETE ON money_category FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
ALTER TABLE other_record ADD CONSTRAINT other_record_kind CHECK(kind IN ('EXPENSE','INCOME')), ADD CONSTRAINT other_record_amount CHECK((reverses_id IS NULL AND amount_jpy>=0) OR (reverses_id IS NOT NULL AND amount_jpy<=0)), ADD CONSTRAINT other_record_sale FOREIGN KEY(source_sale_id) REFERENCES sales_order(id), ADD CONSTRAINT other_record_purchase FOREIGN KEY(source_purchase_id) REFERENCES purchase_document(id), ADD CONSTRAINT other_record_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id), ADD CONSTRAINT other_record_unit FOREIGN KEY(business_unit_id) REFERENCES business_unit(id), ADD CONSTRAINT other_record_owner FOREIGN KEY(reporting_entity_id) REFERENCES reporting_entity(id);
CREATE FUNCTION guard_other_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM money_category c JOIN business_unit u ON u.id=NEW.business_unit_id JOIN reporting_entity e ON e.id=NEW.reporting_entity_id WHERE c.id=NEW.category_id AND c.workspace_id=NEW.workspace_id AND c.kind=NEW.kind AND u.workspace_id=NEW.workspace_id AND e.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'other record category scope mismatch'; END IF;
 IF NEW.source_sale_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sales_order o WHERE o.id=NEW.source_sale_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) THEN RAISE EXCEPTION 'other record sale scope mismatch'; END IF;
 IF NEW.source_purchase_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM purchase_document p WHERE p.id=NEW.source_purchase_id AND p.workspace_id=NEW.workspace_id AND p.business_unit_id=NEW.business_unit_id AND p.reporting_entity_id=NEW.reporting_entity_id) THEN RAISE EXCEPTION 'other record purchase scope mismatch'; END IF;
 IF NEW.reverses_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM other_record o WHERE o.id=NEW.reverses_id AND o.reverses_id IS NULL AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id AND o.category_id=NEW.category_id AND o.kind=NEW.kind AND o.amount_jpy=-NEW.amount_jpy AND o.source_sale_id IS NOT DISTINCT FROM NEW.source_sale_id AND o.source_purchase_id IS NOT DISTINCT FROM NEW.source_purchase_id AND o.date<=NEW.date) THEN RAISE EXCEPTION 'other record reversal mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER other_record_scope BEFORE INSERT ON other_record FOR EACH ROW EXECUTE FUNCTION guard_other_record();
CREATE TRIGGER other_record_immutable BEFORE UPDATE OR DELETE ON other_record FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
ALTER TABLE sales_channel ADD CONSTRAINT sales_channel_receiving_account FOREIGN KEY(receiving_account_id) REFERENCES money_account(id);
CREATE FUNCTION guard_channel_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.receiving_account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM money_account a WHERE a.id=NEW.receiving_account_id AND a.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'channel account scope mismatch'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER channel_account_scope BEFORE INSERT OR UPDATE ON sales_channel FOR EACH ROW EXECUTE FUNCTION guard_channel_account();
CREATE FUNCTION guard_settlement_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.settlement_snapshot IS NOT NULL AND NEW.settlement_snapshot IS DISTINCT FROM OLD.settlement_snapshot THEN RAISE EXCEPTION 'settlement snapshot is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER settlement_snapshot_immutable BEFORE UPDATE ON sales_order FOR EACH ROW EXECUTE FUNCTION guard_settlement_snapshot();
CREATE FUNCTION guard_purchase_supply() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF (NEW.purpose='STOCK' AND (NEW.item_variant_id IS NULL OR NEW.supply_item_id IS NOT NULL OR NEW.tracking_mode='NONE')) OR (NEW.purpose IN ('MATERIAL','EQUIPMENT') AND (NEW.item_variant_id IS NOT NULL OR NEW.supply_item_id IS NULL OR NEW.tracking_mode<>'NONE')) OR NEW.purpose NOT IN ('STOCK','MATERIAL','EQUIPMENT') THEN RAISE EXCEPTION 'purchase purpose mismatch'; END IF;
 IF NEW.supply_item_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supply_item s JOIN purchase_document p ON p.id=NEW.document_id WHERE s.id=NEW.supply_item_id AND s.kind=NEW.purpose AND s.workspace_id=p.workspace_id AND s.business_unit_id=p.business_unit_id) THEN RAISE EXCEPTION 'purchase supply scope mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.purpose<>OLD.purpose OR NEW.supply_item_id IS DISTINCT FROM OLD.supply_item_id) THEN RAISE EXCEPTION 'purchase purpose is immutable'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER purchase_supply_scope BEFORE INSERT OR UPDATE ON purchase_document_line FOR EACH ROW EXECUTE FUNCTION guard_purchase_supply();
CREATE FUNCTION guard_purchase_receipt_purpose() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE l purchase_document_line; BEGIN
 SELECT * INTO l FROM purchase_document_line WHERE id=NEW.line_id FOR UPDATE;
 IF (l.purpose='STOCK')<>(NEW.inventory_lot_id IS NOT NULL) OR NEW.quantity+(SELECT coalesce(sum(quantity),0) FROM purchase_receipt_line WHERE line_id=l.id)>l.quantity THEN RAISE EXCEPTION 'receipt purpose or quantity mismatch'; END IF; RETURN NEW;
END $$;
CREATE TRIGGER receipt_purpose_scope BEFORE INSERT ON purchase_receipt_line FOR EACH ROW EXECUTE FUNCTION guard_purchase_receipt_purpose();

ALTER TABLE money_transaction DROP CONSTRAINT money_transaction_kind;
ALTER TABLE money_transaction ADD CONSTRAINT money_transaction_kind CHECK(kind IN ('PURCHASE_PAYMENT','DELIVERY_PAYMENT','PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_REFUND','TRANSFER','REVERSAL','FEE_PAYMENT','SHIPPING_PAYMENT','SALE_FEE_REFUND','SALE_SHIPPING_REFUND','OTHER_PAYMENT','OTHER_RECEIPT','PURCHASE_CREDIT_REFUND','DELIVERY_CREDIT_REFUND','SALE_CREDIT_REFUND','SALE_SETTLEMENT_PAYMENT'));
CREATE OR REPLACE FUNCTION check_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target uuid; t money_transaction; n integer; total bigint; BEGIN
 IF TG_TABLE_NAME='money_transaction' THEN target:=NEW.id; ELSE target:=NEW.transaction_id; END IF;
 SELECT * INTO t FROM money_transaction WHERE id=target;
 SELECT count(*),coalesce(sum(amount_jpy),0) INTO n,total FROM money_entry WHERE transaction_id=target;
 IF t.kind='TRANSFER' THEN
  IF n<>(CASE WHEN t.fee_jpy>0 THEN 3 ELSE 2 END) OR total<>-t.fee_jpy OR (SELECT count(*) FROM money_entry WHERE transaction_id=target AND purpose='PRINCIPAL' AND amount_jpy=t.amount_jpy)<>1 OR (SELECT count(*) FROM money_entry WHERE transaction_id=target AND purpose='PRINCIPAL' AND amount_jpy=-t.amount_jpy)<>1 OR (t.fee_jpy>0 AND NOT EXISTS(SELECT 1 FROM money_entry f JOIN money_entry p ON p.transaction_id=f.transaction_id AND p.account_id=f.account_id WHERE f.transaction_id=target AND f.purpose='FEE' AND f.amount_jpy=-t.fee_jpy AND p.purpose='PRINCIPAL' AND p.amount_jpy=-t.amount_jpy)) THEN RAISE EXCEPTION 'transfer entries mismatch'; END IF;
 ELSIF t.kind='REVERSAL' THEN
  IF NOT EXISTS(SELECT 1 FROM money_transaction o WHERE o.id=t.reverses_id AND o.reverses_id IS NULL AND o.workspace_id=t.workspace_id AND o.business_unit_id=t.business_unit_id AND o.reporting_entity_id=t.reporting_entity_id AND o.date<=t.date AND o.amount_jpy=t.amount_jpy AND o.fee_jpy=t.fee_jpy) OR EXISTS((SELECT account_id,purpose,amount_jpy FROM money_entry WHERE transaction_id=target) EXCEPT (SELECT account_id,purpose,-amount_jpy FROM money_entry WHERE transaction_id=t.reverses_id)) OR EXISTS((SELECT account_id,purpose,-amount_jpy FROM money_entry WHERE transaction_id=t.reverses_id) EXCEPT (SELECT account_id,purpose,amount_jpy FROM money_entry WHERE transaction_id=target)) THEN RAISE EXCEPTION 'reversal entries mismatch'; END IF;
 ELSE
  IF n<>1 OR t.fee_jpy<>0 OR total<>(CASE WHEN t.kind IN ('PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_FEE_REFUND','SALE_SHIPPING_REFUND','OTHER_RECEIPT','PURCHASE_CREDIT_REFUND','DELIVERY_CREDIT_REFUND') THEN t.amount_jpy ELSE -t.amount_jpy END) THEN RAISE EXCEPTION 'settlement entries mismatch'; END IF;
 END IF;
 IF t.kind IN ('PURCHASE_PAYMENT','DELIVERY_PAYMENT','PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_REFUND') AND t.source_id IS NULL THEN RAISE EXCEPTION 'settlement needs source'; END IF;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION guard_money_source() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE valid boolean:=false; BEGIN
 IF NEW.kind IN ('PURCHASE_PAYMENT','PURCHASE_CREDIT_REFUND') THEN
 SELECT EXISTS(SELECT 1 FROM purchase_document p WHERE p.id=NEW.source_id AND p.workspace_id=NEW.workspace_id AND p.business_unit_id=NEW.business_unit_id AND p.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('DELIVERY_PAYMENT','DELIVERY_CREDIT_REFUND') THEN
 SELECT EXISTS(SELECT 1 FROM inbound_delivery d WHERE d.id=NEW.source_id AND d.workspace_id=NEW.workspace_id AND d.business_unit_id=NEW.business_unit_id AND d.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind='PURCHASE_REFUND' THEN
 SELECT EXISTS(SELECT 1 FROM purchase_charge c LEFT JOIN purchase_document p ON p.id=c.document_id LEFT JOIN inbound_delivery d ON d.id=c.delivery_id WHERE c.id=NEW.source_id AND c.refund AND coalesce(p.workspace_id,d.workspace_id)=NEW.workspace_id AND coalesce(p.business_unit_id,d.business_unit_id)=NEW.business_unit_id AND coalesce(p.reporting_entity_id,d.reporting_entity_id)=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind='SUPPLIER_RETURN_REFUND' THEN
 SELECT EXISTS(SELECT 1 FROM supplier_return s JOIN purchase_receipt_line l ON l.id=s.receipt_line_id JOIN purchase_receipt r ON r.id=l.receipt_id WHERE s.id=NEW.source_id AND r.workspace_id=NEW.workspace_id AND r.business_unit_id=NEW.business_unit_id AND r.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('SALE_RECEIPT','SALE_SETTLEMENT_PAYMENT','SALE_CREDIT_REFUND','FEE_PAYMENT','SHIPPING_PAYMENT') THEN
 SELECT EXISTS(SELECT 1 FROM sales_order o WHERE o.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('SALE_REFUND','SALE_FEE_REFUND','SALE_SHIPPING_REFUND') THEN
 SELECT EXISTS(SELECT 1 FROM sales_return r JOIN sales_order o ON o.id=r.sales_order_id WHERE r.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSIF NEW.kind IN ('OTHER_PAYMENT','OTHER_RECEIPT') THEN
 SELECT EXISTS(SELECT 1 FROM other_record o WHERE o.id=NEW.source_id AND o.workspace_id=NEW.workspace_id AND o.business_unit_id=NEW.business_unit_id AND o.reporting_entity_id=NEW.reporting_entity_id) INTO valid;
 ELSE valid:=NEW.kind IN ('TRANSFER','REVERSAL'); END IF;
 IF NOT valid THEN RAISE EXCEPTION 'settlement source scope mismatch'; END IF;
 RETURN NEW;
END $$;

COMMIT;
