BEGIN;
-- AlterEnum
ALTER TYPE "unique_stock_status" ADD VALUE 'supplier_returned';

-- AlterEnum
ALTER TYPE "inventory_operation_type" ADD VALUE 'purchase_return';

-- AlterEnum
ALTER TYPE "stock_movement_type" ADD VALUE 'purchase_return';

-- CreateTable
CREATE TABLE "supplier_return" (
    "id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "refund_jpy" BIGINT,
    "reason" TEXT NOT NULL,
    "returned_date" DATE NOT NULL,
    "operation_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_account" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "reporting_entity_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "opening_date" DATE NOT NULL,
    "opening_balance_jpy" BIGINT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "money_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_transaction" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "business_unit_id" UUID NOT NULL,
    "reporting_entity_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "kind" TEXT NOT NULL,
    "amount_jpy" BIGINT NOT NULL,
    "fee_jpy" BIGINT NOT NULL DEFAULT 0,
    "source_id" UUID,
    "source_snapshot" JSONB,
    "category_id" UUID,
    "memo" TEXT,
    "reverses_id" UUID,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "money_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "money_entry" (
    "id" UUID NOT NULL,
    "transaction_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "amount_jpy" BIGINT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'PRINCIPAL',

    CONSTRAINT "money_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_return_operation_id_key" ON "supplier_return"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_return_request_id_key" ON "supplier_return"("request_id");

-- CreateIndex
CREATE INDEX "money_account_workspace_id_business_unit_id_idx" ON "money_account"("workspace_id", "business_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "money_transaction_reverses_id_key" ON "money_transaction"("reverses_id");

-- CreateIndex
CREATE UNIQUE INDEX "money_transaction_request_id_key" ON "money_transaction"("request_id");

-- CreateIndex
CREATE INDEX "money_transaction_workspace_id_business_unit_id_date_idx" ON "money_transaction"("workspace_id", "business_unit_id", "date");

-- CreateIndex
CREATE INDEX "money_transaction_kind_source_id_idx" ON "money_transaction"("kind", "source_id");

-- CreateIndex
CREATE INDEX "money_entry_account_id_transaction_id_idx" ON "money_entry"("account_id", "transaction_id");

-- AddForeignKey
ALTER TABLE "supplier_return" ADD CONSTRAINT "supplier_return_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "purchase_receipt_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_transaction" ADD CONSTRAINT "money_transaction_reverses_id_fkey" FOREIGN KEY ("reverses_id") REFERENCES "money_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_entry" ADD CONSTRAINT "money_entry_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "money_transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "money_entry" ADD CONSTRAINT "money_entry_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "money_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE supplier_return ADD CONSTRAINT supplier_return_amount CHECK(quantity>0 AND (refund_jpy IS NULL OR refund_jpy>=0) AND length(trim(reason))>0), ADD CONSTRAINT supplier_return_operation FOREIGN KEY(operation_id) REFERENCES inventory_operation(id);
CREATE FUNCTION guard_supplier_return() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 PERFORM id FROM purchase_receipt_line WHERE id=NEW.receipt_line_id FOR UPDATE;
 IF NEW.quantity+(SELECT coalesce(sum(quantity),0) FROM supplier_return WHERE receipt_line_id=NEW.receipt_line_id)>(SELECT quantity FROM purchase_receipt_line WHERE id=NEW.receipt_line_id) OR NOT EXISTS(SELECT 1 FROM purchase_receipt_line l JOIN purchase_receipt r ON r.id=l.receipt_id JOIN inventory_operation o ON o.id=NEW.operation_id WHERE l.id=NEW.receipt_line_id AND o.business_unit_id=r.business_unit_id AND o.workspace_id=r.workspace_id AND o.operation_type='purchase_return' AND r.received_date<=NEW.returned_date) THEN RAISE EXCEPTION 'supplier return scope or quantity mismatch'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER supplier_return_scope BEFORE INSERT ON supplier_return FOR EACH ROW EXECUTE FUNCTION guard_supplier_return();
CREATE TRIGGER supplier_return_immutable BEFORE UPDATE OR DELETE ON supplier_return FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
ALTER TABLE money_account ADD CONSTRAINT money_account_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id), ADD CONSTRAINT money_account_unit FOREIGN KEY(business_unit_id) REFERENCES business_unit(id), ADD CONSTRAINT money_account_owner FOREIGN KEY(reporting_entity_id) REFERENCES reporting_entity(id);
ALTER TABLE money_transaction ADD CONSTRAINT money_transaction_workspace FOREIGN KEY(workspace_id) REFERENCES workspace(id), ADD CONSTRAINT money_transaction_unit FOREIGN KEY(business_unit_id) REFERENCES business_unit(id), ADD CONSTRAINT money_transaction_owner FOREIGN KEY(reporting_entity_id) REFERENCES reporting_entity(id), ADD CONSTRAINT money_transaction_amount CHECK(amount_jpy>0 AND fee_jpy>=0), ADD CONSTRAINT money_transaction_kind CHECK(kind IN ('PURCHASE_PAYMENT','DELIVERY_PAYMENT','PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_REFUND','TRANSFER','EXPENSE','INCOME','REVERSAL'));
ALTER TABLE money_entry ADD CONSTRAINT money_entry_nonzero CHECK(amount_jpy<>0 AND purpose IN ('PRINCIPAL','FEE')), ADD CONSTRAINT money_entry_unique UNIQUE(transaction_id,account_id,purpose);
CREATE FUNCTION guard_money_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM business_unit u JOIN reporting_entity e ON e.id=NEW.reporting_entity_id WHERE u.id=NEW.business_unit_id AND u.workspace_id=NEW.workspace_id AND e.workspace_id=NEW.workspace_id) THEN RAISE EXCEPTION 'account scope mismatch'; END IF;
 IF TG_OP='UPDATE' AND (NEW.workspace_id<>OLD.workspace_id OR NEW.business_unit_id<>OLD.business_unit_id OR NEW.reporting_entity_id<>OLD.reporting_entity_id OR NEW.opening_date<>OLD.opening_date OR NEW.opening_balance_jpy<>OLD.opening_balance_jpy) THEN RAISE EXCEPTION 'account opening is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER money_account_scope BEFORE INSERT OR UPDATE ON money_account FOR EACH ROW EXECUTE FUNCTION guard_money_account();
CREATE TRIGGER money_account_revision BEFORE UPDATE ON money_account FOR EACH ROW EXECUTE FUNCTION advance_master_revision();
CREATE TRIGGER money_account_no_delete BEFORE DELETE ON money_account FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE FUNCTION guard_money_entry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM money_account a JOIN money_transaction t ON t.id=NEW.transaction_id WHERE a.id=NEW.account_id AND a.workspace_id=t.workspace_id AND a.business_unit_id=t.business_unit_id AND a.reporting_entity_id=t.reporting_entity_id AND a.opening_date<=t.date) THEN RAISE EXCEPTION 'money entry scope or date mismatch'; END IF;
 UPDATE money_account SET revision=revision+1 WHERE id=NEW.account_id;
 RETURN NEW;
END $$;
CREATE TRIGGER money_entry_scope BEFORE INSERT ON money_entry FOR EACH ROW EXECUTE FUNCTION guard_money_entry();
CREATE TRIGGER money_entry_immutable BEFORE UPDATE OR DELETE ON money_entry FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER money_transaction_immutable BEFORE UPDATE OR DELETE ON money_transaction FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE FUNCTION check_money_transaction() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE target uuid; t money_transaction; n integer; total bigint; BEGIN
 IF TG_TABLE_NAME='money_transaction' THEN target:=NEW.id; ELSE target:=NEW.transaction_id; END IF;
 SELECT * INTO t FROM money_transaction WHERE id=target;
 SELECT count(*),coalesce(sum(amount_jpy),0) INTO n,total FROM money_entry WHERE transaction_id=target;
 IF t.kind='TRANSFER' THEN
  IF n<>(CASE WHEN t.fee_jpy>0 THEN 3 ELSE 2 END) OR total<>-t.fee_jpy OR (SELECT count(*) FROM money_entry WHERE transaction_id=target AND purpose='PRINCIPAL' AND amount_jpy=t.amount_jpy)<>1 OR (SELECT count(*) FROM money_entry WHERE transaction_id=target AND purpose='PRINCIPAL' AND amount_jpy=-t.amount_jpy)<>1 OR (t.fee_jpy>0 AND NOT EXISTS(SELECT 1 FROM money_entry f JOIN money_entry p ON p.transaction_id=f.transaction_id AND p.account_id=f.account_id WHERE f.transaction_id=target AND f.purpose='FEE' AND f.amount_jpy=-t.fee_jpy AND p.purpose='PRINCIPAL' AND p.amount_jpy=-t.amount_jpy)) THEN RAISE EXCEPTION 'transfer entries mismatch'; END IF;
 ELSIF t.kind='REVERSAL' THEN
  IF NOT EXISTS(SELECT 1 FROM money_transaction o WHERE o.id=t.reverses_id AND o.reverses_id IS NULL AND o.workspace_id=t.workspace_id AND o.business_unit_id=t.business_unit_id AND o.reporting_entity_id=t.reporting_entity_id AND o.date<=t.date AND o.amount_jpy=t.amount_jpy AND o.fee_jpy=t.fee_jpy) OR EXISTS((SELECT account_id,purpose,amount_jpy FROM money_entry WHERE transaction_id=target) EXCEPT (SELECT account_id,purpose,-amount_jpy FROM money_entry WHERE transaction_id=t.reverses_id)) OR EXISTS((SELECT account_id,purpose,-amount_jpy FROM money_entry WHERE transaction_id=t.reverses_id) EXCEPT (SELECT account_id,purpose,amount_jpy FROM money_entry WHERE transaction_id=target)) THEN RAISE EXCEPTION 'reversal entries mismatch'; END IF;
 ELSE
  IF n<>1 OR t.fee_jpy<>0 OR total<>(CASE WHEN t.kind IN ('PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','INCOME') THEN t.amount_jpy ELSE -t.amount_jpy END) THEN RAISE EXCEPTION 'settlement entries mismatch'; END IF;
 END IF;
 IF t.kind IN ('PURCHASE_PAYMENT','DELIVERY_PAYMENT','PURCHASE_REFUND','SUPPLIER_RETURN_REFUND','SALE_RECEIPT','SALE_REFUND') AND t.source_id IS NULL THEN RAISE EXCEPTION 'settlement needs source'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER money_transaction_balanced AFTER INSERT ON money_transaction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_money_transaction();
CREATE CONSTRAINT TRIGGER money_entry_balanced AFTER INSERT ON money_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_money_transaction();

COMMIT;
