ALTER TABLE listing
 ADD COLUMN display_name text,
 ADD COLUMN expected_fee_source text NOT NULL DEFAULT 'UNKNOWN' CHECK(expected_fee_source IN ('RATE','AMOUNT','UNKNOWN')),
 ADD COLUMN expected_fee_jpy bigint CHECK(expected_fee_jpy>=0),
 ADD COLUMN expected_packing_jpy bigint CHECK(expected_packing_jpy>=0),
 ADD COLUMN expected_other_jpy bigint CHECK(expected_other_jpy>=0);
ALTER TABLE sales_order_line ADD COLUMN display_name text;
