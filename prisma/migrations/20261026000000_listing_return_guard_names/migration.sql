-- Repair the applied function without modifying migration history or business records.
CREATE OR REPLACE FUNCTION guard_listing_return() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE member_row listing_return_member%ROWTYPE;
        case_row listing_return_case%ROWTYPE;
        processed_total bigint;
BEGIN
 IF TG_TABLE_NAME='listing_return_case' THEN
  IF NOT EXISTS(
   SELECT 1 FROM listing target_listing
   JOIN sales_sku sku ON sku.id=target_listing.sales_sku_id
   JOIN reporting_entity owner_entity ON owner_entity.id=NEW.reporting_entity_id
   WHERE target_listing.id=NEW.listing_id AND sku.workspace_id=NEW.workspace_id
   AND sku.business_unit_id=NEW.business_unit_id AND owner_entity.workspace_id=NEW.workspace_id
   AND target_listing.origin_reporting_entity_id=NEW.reporting_entity_id AND target_listing.workflow_version=2
  ) THEN RAISE EXCEPTION 'listing return scope mismatch'; END IF;
 ELSIF TG_TABLE_NAME='listing_return_member' THEN
  IF NOT EXISTS(
   SELECT 1 FROM listing_return_case parent_case
   JOIN inventory_reservation reservation ON reservation.id=NEW.reservation_id
   WHERE parent_case.id=NEW.case_id AND reservation.listing_id=parent_case.listing_id
   AND reservation.status='reserved' AND reservation.quantity=NEW.quantity
  ) THEN RAISE EXCEPTION 'listing return member mismatch'; END IF;
 ELSE
  SELECT member.* INTO member_row FROM listing_return_member member WHERE member.id=NEW.member_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'listing return member missing'; END IF;
  SELECT parent_case.* INTO case_row FROM listing_return_case parent_case WHERE parent_case.id=member_row.case_id;
  IF NOT EXISTS(SELECT 1 FROM listing target_listing WHERE target_listing.id=case_row.listing_id
   AND target_listing.return_pending AND target_listing.status<>'ended') THEN RAISE EXCEPTION 'listing return case is closed'; END IF;
  SELECT coalesce(sum(handling.quantity),0) INTO processed_total FROM listing_return_handling handling WHERE handling.member_id=member_row.id;
  IF processed_total+NEW.quantity>member_row.quantity OR NEW.handled_date<case_row.started_date
   THEN RAISE EXCEPTION 'listing return quantity/date mismatch'; END IF;
  IF NEW.operation_id IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM inventory_operation operation WHERE operation.id=NEW.operation_id
   AND operation.workspace_id=case_row.workspace_id AND operation.business_unit_id=case_row.business_unit_id
   AND operation.source_type='listing' AND operation.source_id=case_row.listing_id AND operation.idempotency_key=NEW.request_id
  ) THEN RAISE EXCEPTION 'listing return operation mismatch'; END IF;
 END IF;
 RETURN NEW;
END $$;
