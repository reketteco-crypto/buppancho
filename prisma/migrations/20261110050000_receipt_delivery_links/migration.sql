BEGIN;
-- CreateTable
CREATE TABLE "receipt_delivery_link" (
    "id" UUID NOT NULL,
    "receipt_line_id" UUID NOT NULL,
    "delivery_line_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "request_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_delivery_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipt_delivery_link_request_id_receipt_line_id_delivery_l_key" ON "receipt_delivery_link"("request_id", "receipt_line_id", "delivery_line_id");

-- AddForeignKey
ALTER TABLE "receipt_delivery_link" ADD CONSTRAINT "receipt_delivery_link_receipt_line_id_fkey" FOREIGN KEY ("receipt_line_id") REFERENCES "purchase_receipt_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_delivery_link" ADD CONSTRAINT "receipt_delivery_link_delivery_line_id_fkey" FOREIGN KEY ("delivery_line_id") REFERENCES "inbound_delivery_line"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE receipt_delivery_link ADD CONSTRAINT receipt_delivery_link_quantity CHECK(quantity>0);
CREATE FUNCTION guard_receipt_delivery_link() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE r purchase_receipt_line; d inbound_delivery_line; BEGIN
 SELECT * INTO r FROM purchase_receipt_line WHERE id=NEW.receipt_line_id FOR UPDATE;
 SELECT * INTO d FROM inbound_delivery_line WHERE id=NEW.delivery_line_id FOR UPDATE;
 IF r.line_id<>d.purchase_line_id OR r.delivery_line_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM purchase_receipt pr JOIN inbound_delivery dd ON dd.id=d.delivery_id WHERE pr.id=r.receipt_id AND pr.workspace_id=dd.workspace_id AND pr.business_unit_id=dd.business_unit_id AND pr.reporting_entity_id=dd.reporting_entity_id AND pr.received_date>=dd.shipped_date) THEN RAISE EXCEPTION 'receipt attribution scope mismatch'; END IF;
 IF NEW.quantity+(SELECT coalesce(sum(quantity),0) FROM receipt_delivery_link WHERE receipt_line_id=r.id)>r.quantity OR NEW.quantity+(SELECT coalesce(sum(quantity),0) FROM receipt_delivery_link WHERE delivery_line_id=d.id)+(SELECT coalesce(sum(quantity),0) FROM purchase_receipt_line WHERE delivery_line_id=d.id)>d.quantity THEN RAISE EXCEPTION 'receipt attribution exceeds quantity'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER receipt_delivery_link_guard BEFORE INSERT ON receipt_delivery_link FOR EACH ROW EXECUTE FUNCTION guard_receipt_delivery_link();
CREATE TRIGGER receipt_delivery_link_immutable BEFORE UPDATE OR DELETE ON receipt_delivery_link FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE OR REPLACE FUNCTION guard_receipt_delivery() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.delivery_line_id IS NOT NULL THEN
 PERFORM id FROM inbound_delivery_line WHERE id=NEW.delivery_line_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM inbound_delivery_line d JOIN inbound_delivery dd ON dd.id=d.delivery_id JOIN purchase_receipt r ON r.id=NEW.receipt_id WHERE d.id=NEW.delivery_line_id AND d.purchase_line_id=NEW.line_id AND r.received_date>=dd.shipped_date) THEN RAISE EXCEPTION 'receipt delivery mismatch'; END IF;
 IF (SELECT coalesce(sum(quantity),0) FROM purchase_receipt_line WHERE delivery_line_id=NEW.delivery_line_id)+(SELECT coalesce(sum(quantity),0) FROM receipt_delivery_link WHERE delivery_line_id=NEW.delivery_line_id)+NEW.quantity>(SELECT quantity FROM inbound_delivery_line WHERE id=NEW.delivery_line_id) THEN RAISE EXCEPTION 'receipt exceeds delivery'; END IF;
 END IF;
 RETURN NEW;
END $$;

COMMIT;
