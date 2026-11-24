CREATE TABLE listing_return_case (
 id uuid PRIMARY KEY, listing_id uuid NOT NULL REFERENCES listing(id),
 workspace_id uuid NOT NULL REFERENCES workspace(id), business_unit_id uuid NOT NULL REFERENCES business_unit(id),
 reporting_entity_id uuid NOT NULL REFERENCES reporting_entity(id), request_id uuid NOT NULL UNIQUE,
 started_date date NOT NULL, created_at timestamptz(3) NOT NULL DEFAULT now()
);
CREATE INDEX listing_return_case_listing ON listing_return_case(listing_id,created_at);
CREATE TABLE listing_return_member (
 id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES listing_return_case(id),
 reservation_id uuid NOT NULL REFERENCES inventory_reservation(id), quantity integer NOT NULL CHECK(quantity>0),
 UNIQUE(case_id,reservation_id)
);
CREATE TABLE listing_return_handling (
 id uuid PRIMARY KEY, member_id uuid NOT NULL REFERENCES listing_return_member(id), request_id uuid NOT NULL,
 operation_id uuid REFERENCES inventory_operation(id), disposition text NOT NULL CHECK(disposition IN ('RESTOCK','DEFECTIVE','DISPOSED','LOST')),
 quantity integer NOT NULL CHECK(quantity>0), handled_date date NOT NULL,
 cost_total_jpy bigint NOT NULL CHECK(cost_total_jpy>=0), created_at timestamptz(3) NOT NULL DEFAULT now(),
 UNIQUE(request_id,member_id,disposition), CHECK((disposition='RESTOCK' AND operation_id IS NULL AND cost_total_jpy=0) OR (disposition<>'RESTOCK' AND operation_id IS NOT NULL))
);
CREATE INDEX listing_return_handling_member ON listing_return_handling(member_id);
CREATE FUNCTION guard_listing_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m listing_return_member%ROWTYPE; c listing_return_case%ROWTYPE; total bigint;
BEGIN
 IF TG_TABLE_NAME='listing_return_case' THEN
  IF NOT EXISTS(SELECT 1 FROM listing l JOIN sales_sku s ON s.id=l.sales_sku_id JOIN reporting_entity e ON e.id=NEW.reporting_entity_id
   WHERE l.id=NEW.listing_id AND s.workspace_id=NEW.workspace_id AND s.business_unit_id=NEW.business_unit_id AND e.workspace_id=NEW.workspace_id
   AND l.origin_reporting_entity_id=NEW.reporting_entity_id AND l.workflow_version=2)
   THEN RAISE EXCEPTION 'listing return scope mismatch'; END IF;
 ELSIF TG_TABLE_NAME='listing_return_member' THEN
  IF NOT EXISTS(SELECT 1 FROM listing_return_case c JOIN inventory_reservation r ON r.id=NEW.reservation_id
   WHERE c.id=NEW.case_id AND r.listing_id=c.listing_id AND r.status='reserved' AND r.quantity=NEW.quantity)
   THEN RAISE EXCEPTION 'listing return member mismatch'; END IF;
 ELSE
  SELECT * INTO m FROM listing_return_member WHERE id=NEW.member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing return member missing'; END IF;
  SELECT * INTO c FROM listing_return_case WHERE id=m.case_id;
  IF NOT EXISTS(SELECT 1 FROM listing l WHERE l.id=c.listing_id AND l.return_pending AND l.status<>'ended') THEN RAISE EXCEPTION 'listing return case is closed'; END IF;
  SELECT coalesce(sum(quantity),0) INTO total FROM listing_return_handling WHERE member_id=m.id;
  IF total+NEW.quantity>m.quantity OR NEW.handled_date<c.started_date THEN RAISE EXCEPTION 'listing return quantity/date mismatch'; END IF;
  IF NEW.operation_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inventory_operation o WHERE o.id=NEW.operation_id
   AND o.workspace_id=c.workspace_id AND o.business_unit_id=c.business_unit_id AND o.source_type='listing' AND o.source_id=c.listing_id AND o.idempotency_key=NEW.request_id)
   THEN RAISE EXCEPTION 'listing return operation mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_return_case_scope BEFORE INSERT ON listing_return_case FOR EACH ROW EXECUTE FUNCTION guard_listing_return();
CREATE TRIGGER listing_return_member_scope BEFORE INSERT ON listing_return_member FOR EACH ROW EXECUTE FUNCTION guard_listing_return();
CREATE TRIGGER listing_return_handling_limit BEFORE INSERT ON listing_return_handling FOR EACH ROW EXECUTE FUNCTION guard_listing_return();
CREATE TRIGGER listing_return_case_immutable BEFORE UPDATE OR DELETE ON listing_return_case FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER listing_return_member_immutable BEFORE UPDATE OR DELETE ON listing_return_member FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
CREATE TRIGGER listing_return_handling_immutable BEFORE UPDATE OR DELETE ON listing_return_handling FOR EACH ROW EXECUTE FUNCTION prevent_valuation_mutation();
