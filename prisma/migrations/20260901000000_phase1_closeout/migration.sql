DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM inventory_item
    WHERE management_type = 'quantity'
      AND management_cost_method <> 'moving_average'
  ) THEN
    RAISE EXCEPTION
      '数量商品の管理原価方式にmoving_average以外が存在するため、フェーズ1制約を適用できません。対象データを確認してください。';
  END IF;
END
$$;

ALTER TABLE inventory_item
  DROP CONSTRAINT inventory_item_cost_method_check,
  ADD CONSTRAINT inventory_item_cost_method_check CHECK (
    (management_type = 'quantity' AND management_cost_method = 'moving_average') OR
    (management_type = 'unique' AND management_cost_method = 'specific')
  );

CREATE INDEX inventory_item_code_trgm_idx
  ON inventory_item USING gin(item_code gin_trgm_ops);
CREATE INDEX item_variant_code_trgm_idx
  ON item_variant USING gin(variant_code gin_trgm_ops);
CREATE INDEX item_variant_attributes_text_trgm_idx
  ON item_variant USING gin((attributes_json::text) gin_trgm_ops);
