BEGIN;
-- AlterTable
ALTER TABLE "purchase_document" ADD COLUMN     "actual_order_jpy" BIGINT,
ADD COLUMN     "external_reference" TEXT,
ADD COLUMN     "import_source" JSONB,
ADD COLUMN     "rate_basis" TEXT NOT NULL DEFAULT 'JPY';

-- AlterTable
ALTER TABLE "purchase_charge" ADD COLUMN     "amount_foreign" DECIMAL(24,8),
ADD COLUMN     "basis_snapshot" JSONB,
ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'JPY',
ADD COLUMN     "delivery_id" UUID,
ADD COLUMN     "exchange_rate" DECIMAL(24,10),
ADD COLUMN     "rate_basis" TEXT NOT NULL DEFAULT 'JPY',
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "refund" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "supersedes_id" UUID,
ALTER COLUMN "document_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "purchase_receipt_line" ADD COLUMN     "delivery_line_id" UUID;

-- CreateTable
CREATE TABLE "inbound_delivery" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "reporting_entity_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "code" TEXT NOT NULL,
    "shipped_date" DATE NOT NULL,
    "delivery_method_id" UUID,
    "method_name" TEXT,
    "counterparty_id" UUID,
    "reference" TEXT,
    "memo" TEXT,
    "request_key" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbound_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_delivery_line" (
    "position" INTEGER NOT NULL DEFAULT 0,
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "purchase_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,

    CONSTRAINT "inbound_delivery_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_cost_correction" (
    "id" UUID NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "movement_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "before_jpy" BIGINT NOT NULL,
    "after_jpy" BIGINT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_cost_correction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inbound_delivery_request_key_key" ON "inbound_delivery"("request_key");

-- CreateIndex
CREATE INDEX "inbound_delivery_workspace_id_business_unit_id_shipped_date_idx" ON "inbound_delivery"("workspace_id", "business_unit_id", "shipped_date");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_delivery_workspace_id_code_key" ON "inbound_delivery"("workspace_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_delivery_line_delivery_id_purchase_line_id_key" ON "inbound_delivery_line"("delivery_id", "purchase_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_cost_correction_sequence_key" ON "receipt_cost_correction"("sequence");

-- CreateIndex
CREATE INDEX "receipt_cost_correction_workspace_id_business_unit_id_seque_idx" ON "receipt_cost_correction"("workspace_id", "business_unit_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_cost_correction_request_id_receipt_line_id_key" ON "receipt_cost_correction"("request_id", "receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_document_workspace_id_supplier_id_external_referen_key" ON "purchase_document"("workspace_id", "supplier_id", "external_reference");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_charge_supersedes_id_key" ON "purchase_charge"("supersedes_id");

-- AddForeignKey
ALTER TABLE "purchase_charge" ADD CONSTRAINT "purchase_charge_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "inbound_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_charge" ADD CONSTRAINT "purchase_charge_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "purchase_charge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_line" ADD CONSTRAINT "purchase_receipt_line_delivery_line_id_fkey" FOREIGN KEY ("delivery_line_id") REFERENCES "inbound_delivery_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_delivery_line" ADD CONSTRAINT "inbound_delivery_line_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "inbound_delivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_delivery_line" ADD CONSTRAINT "inbound_delivery_line_purchase_line_id_fkey" FOREIGN KEY ("purchase_line_id") REFERENCES "purchase_document_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_cost_correction" ADD CONSTRAINT "receipt_cost_correction_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "purchase_receipt_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_cost_correction" ADD CONSTRAINT "receipt_cost_correction_movement_id_fkey" FOREIGN KEY ("movement_id") REFERENCES "stock_movement"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE purchase_charge ADD CONSTRAINT purchase_charge_owner CHECK((document_id IS NULL)<>(delivery_id IS NULL));
ALTER TABLE inbound_delivery ADD CONSTRAINT inbound_delivery_unit FOREIGN KEY(business_unit_id) REFERENCES business_unit(id), ADD CONSTRAINT inbound_delivery_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id), ADD CONSTRAINT inbound_delivery_entity FOREIGN KEY(reporting_entity_id) REFERENCES reporting_entity(id), ADD CONSTRAINT inbound_delivery_method FOREIGN KEY(delivery_method_id) REFERENCES delivery_method(id), ADD CONSTRAINT inbound_delivery_counterparty FOREIGN KEY(counterparty_id) REFERENCES counterparty(id);
ALTER TABLE inbound_delivery_line ADD CONSTRAINT inbound_delivery_line_quantity CHECK(quantity>0 AND position>=0);
ALTER TABLE receipt_cost_correction ADD CONSTRAINT receipt_cost_operation FOREIGN KEY(operation_id) REFERENCES inventory_operation(id), ADD CONSTRAINT receipt_cost_amount CHECK(before_jpy>=0 AND after_jpy>=0 AND length(trim(reason))>0);
CREATE TRIGGER inbound_delivery_revision BEFORE UPDATE ON inbound_delivery FOR EACH ROW EXECUTE FUNCTION advance_master_revision();
CREATE FUNCTION guard_inbound_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM business_unit u JOIN reporting_entity e ON e.id=NEW.reporting_entity_id WHERE u.id=NEW.business_unit_id AND u.workspace_id=NEW.workspace_id AND e.workspace_id=NEW.workspace_id) OR (NEW.delivery_method_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM delivery_method m WHERE m.id=NEW.delivery_method_id AND m.workspace_id=NEW.workspace_id)) OR (NEW.counterparty_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM counterparty p WHERE p.id=NEW.counterparty_id AND p.workspace_id=NEW.workspace_id)) THEN RAISE EXCEPTION 'delivery scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inbound_scope BEFORE INSERT OR UPDATE ON inbound_delivery FOR EACH ROW EXECUTE FUNCTION guard_inbound_scope();
CREATE FUNCTION guard_inbound_line() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE ordered integer; BEGIN
 IF NOT EXISTS(SELECT 1 FROM inbound_delivery d JOIN purchase_document_line l ON l.id=NEW.purchase_line_id JOIN purchase_document p ON p.id=l.document_id WHERE d.id=NEW.delivery_id AND d.workspace_id=p.workspace_id AND d.business_unit_id=p.business_unit_id AND d.reporting_entity_id=p.reporting_entity_id) THEN RAISE EXCEPTION 'delivery line scope mismatch'; END IF;
 SELECT quantity INTO ordered FROM purchase_document_line WHERE id=NEW.purchase_line_id;
 IF (SELECT coalesce(sum(quantity),0) FROM inbound_delivery_line WHERE purchase_line_id=NEW.purchase_line_id)+NEW.quantity>ordered THEN RAISE EXCEPTION 'delivery exceeds ordered quantity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER inbound_line_scope BEFORE INSERT ON inbound_delivery_line FOR EACH ROW EXECUTE FUNCTION guard_inbound_line();
CREATE OR REPLACE FUNCTION guard_charge_allocation_scope() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM purchase_charge c JOIN purchase_document_line l ON l.id=NEW.line_id WHERE c.id=NEW.charge_id AND (c.document_id=l.document_id OR EXISTS(SELECT 1 FROM inbound_delivery_line dl JOIN inbound_delivery d ON d.id=dl.delivery_id JOIN purchase_document p ON p.id=l.document_id WHERE dl.delivery_id=c.delivery_id AND dl.purchase_line_id=l.id AND d.workspace_id=p.workspace_id AND d.business_unit_id=p.business_unit_id AND d.reporting_entity_id=p.reporting_entity_id))) THEN RAISE EXCEPTION 'allocation scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE FUNCTION guard_charge_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM purchase_charge c WHERE c.id=NEW.supersedes_id AND c.document_id IS NOT DISTINCT FROM NEW.document_id AND c.delivery_id IS NOT DISTINCT FROM NEW.delivery_id) THEN RAISE EXCEPTION 'charge revision scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER charge_revision_scope BEFORE INSERT ON purchase_charge FOR EACH ROW EXECUTE FUNCTION guard_charge_revision();
CREATE FUNCTION guard_receipt_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.delivery_line_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbound_delivery_line d WHERE d.id=NEW.delivery_line_id AND d.purchase_line_id=NEW.line_id) THEN RAISE EXCEPTION 'receipt delivery mismatch'; END IF;
 IF NEW.delivery_line_id IS NOT NULL AND (SELECT coalesce(sum(quantity),0) FROM purchase_receipt_line WHERE delivery_line_id=NEW.delivery_line_id)+NEW.quantity>(SELECT quantity FROM inbound_delivery_line WHERE id=NEW.delivery_line_id) THEN RAISE EXCEPTION 'receipt exceeds delivery'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_delivery_scope BEFORE INSERT ON purchase_receipt_line FOR EACH ROW EXECUTE FUNCTION guard_receipt_delivery();
CREATE FUNCTION guard_receipt_cost_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM purchase_receipt_line l JOIN purchase_receipt r ON r.id=l.receipt_id JOIN stock_movement m ON m.id=NEW.movement_id WHERE l.id=NEW.receipt_line_id AND r.workspace_id=NEW.workspace_id AND r.business_unit_id=NEW.business_unit_id AND m.inventory_lot_id=l.inventory_lot_id AND m.operation_id=NEW.operation_id AND m.movement_type='receipt' AND m.quantity=l.quantity) THEN RAISE EXCEPTION 'receipt cost correction scope mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_cost_scope BEFORE INSERT ON receipt_cost_correction FOR EACH ROW EXECUTE FUNCTION guard_receipt_cost_correction();
CREATE TRIGGER receipt_cost_immutable BEFORE UPDATE OR DELETE ON receipt_cost_correction FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER inbound_line_immutable BEFORE UPDATE OR DELETE ON inbound_delivery_line FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER inbound_no_delete BEFORE DELETE ON inbound_delivery FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();

COMMIT;
