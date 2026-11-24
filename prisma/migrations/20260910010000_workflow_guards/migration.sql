-- Cross-owner/workspace guards supplement the reservation ownership XOR.
CREATE FUNCTION guard_reservation_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_workspace uuid; target_unit uuid; owner_workspace uuid; owner_unit uuid;
BEGIN
  SELECT i.workspace_id,i.business_unit_id INTO target_workspace,target_unit
    FROM item_variant v JOIN inventory_item i ON i.id=v.inventory_item_id WHERE v.id=NEW.item_variant_id;
  IF NEW.listing_id IS NOT NULL THEN
    SELECT s.workspace_id,s.business_unit_id INTO owner_workspace,owner_unit
      FROM listing l JOIN sales_sku s ON s.id=l.sales_sku_id WHERE l.id=NEW.listing_id;
  ELSE
    SELECT o.workspace_id,o.business_unit_id INTO owner_workspace,owner_unit
      FROM sales_order_line l JOIN sales_order o ON o.id=l.sales_order_id WHERE l.id=NEW.sales_order_line_id;
  END IF;
  IF target_workspace IS DISTINCT FROM owner_workspace OR target_unit IS DISTINCT FROM owner_unit THEN
    RAISE EXCEPTION 'reservation owner scope mismatch';
  END IF;
  IF NEW.inventory_lot_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM inventory_lot WHERE id=NEW.inventory_lot_id AND item_variant_id=NEW.item_variant_id AND tracking_mode='quantity') THEN
    RAISE EXCEPTION 'reservation lot target mismatch';
  END IF;
  IF NEW.unique_stock_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM unique_stock_unit WHERE id=NEW.unique_stock_unit_id AND item_variant_id=NEW.item_variant_id) THEN
    RAISE EXCEPTION 'reservation unique target mismatch';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage_location WHERE id=NEW.storage_location_id AND workspace_id=target_workspace AND (business_unit_id IS NULL OR business_unit_id=target_unit)) THEN
    RAISE EXCEPTION 'reservation storage scope mismatch';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER inventory_reservation_scope BEFORE INSERT OR UPDATE ON inventory_reservation FOR EACH ROW EXECUTE FUNCTION guard_reservation_scope();

CREATE FUNCTION protect_listing_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.workflow_version=2 AND (NEW.workflow_version<>2 OR NEW.components_snapshot IS DISTINCT FROM OLD.components_snapshot OR NEW.sales_sku_id<>OLD.sales_sku_id OR NEW.external_listing_id IS DISTINCT FROM OLD.external_listing_id OR NEW.sales_channel_id<>OLD.sales_channel_id) THEN
    RAISE EXCEPTION 'recorded listing identity and components are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_snapshot_immutable BEFORE UPDATE ON listing FOR EACH ROW EXECUTE FUNCTION protect_listing_snapshot();
