BEGIN;
-- AlterTable
ALTER TABLE "counterparty" ADD COLUMN     "default_allocation_method" TEXT NOT NULL DEFAULT 'VALUE',
ADD COLUMN     "default_currency" TEXT NOT NULL DEFAULT 'JPY';

ALTER TABLE counterparty ADD CONSTRAINT counterparty_purchase_currency CHECK(default_currency ~ '^[A-Z]{3}$'), ADD CONSTRAINT counterparty_purchase_allocation CHECK(default_allocation_method IN ('VALUE','QUANTITY','WEIGHT','VOLUME','EQUAL','MANUAL'));

COMMIT;
