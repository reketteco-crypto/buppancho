import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
import { ensureTestContext } from "../e2e/helpers/completion";
test("101件のページ送りと検索をまたいで選択し、上部で一括登録する", async ({ page }, info) => {
  test.setTimeout(90000);
  const url = process.env.TEST_DATABASE_URL;
  if (!url || new URL(url).pathname !== "/buppancho_redesign_20261110_test")
    throw new Error("固定の専用DBが必要です。");
  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) }),
    token = randomUUID().slice(0, 8).toUpperCase(),
    prefix = `一覧確認-${info.project.name}-${token}`,
    otherUnitName = `選択解除-${token}`;
  try {
    const unit = await db.businessUnit.findFirstOrThrow({
        where: { code: "E2E", workspace: { name: "物販帳E2E" } },
      }),
      items = Array.from({ length: 101 }, (_, i) => ({
        id: randomUUID(),
        workspaceId: unit.workspaceId,
        businessUnitId: unit.id,
        itemCode: `CAT-${token}-${i}`,
        name: `${prefix}-${String(i).padStart(3, "0")}`,
        managementType: "QUANTITY" as const,
        managementCostMethod: "MOVING_AVERAGE" as const,
      }));

    const assignment = await db.businessUnitAssignment.findFirstOrThrow({
        where: { businessUnitId: unit.id, fiscalYearProfile: { year: 2026 } },
      }),
      otherUnit = await db.businessUnit.create({
        data: {
          workspaceId: unit.workspaceId,
          code: `CATCTX-${token}`,
          name: otherUnitName,
          color: "#355d4c",
        },
      });
    await db.businessUnitAssignment.create({
      data: {
        businessUnitId: otherUnit.id,
        fiscalYearProfileId: assignment.fiscalYearProfileId,
        effectiveFrom: new Date("2026-01-01"),
        effectiveTo: new Date("2026-12-31"),
      },
    });
    await db.inventoryItem.createMany({ data: items });
    const variants = items.map((i) => ({
      id: randomUUID(),
      workspaceId: i.workspaceId,
      inventoryItemId: i.id,
      variantCode: i.itemCode,
    }));
    await db.itemVariant.createMany({
      data: variants,
    });
    const skus = items.map((i, index) => ({
      id: randomUUID(),
      workspaceId: i.workspaceId,
      businessUnitId: unit.id,
      name: `一覧SKU-${token}-${String(index).padStart(3, "0")}`,
      skuCode: `SKU-9${parseInt(token, 16)}${String(index).padStart(3, "0")}`,
      skuType: "SINGLE" as const,
      requestKey: randomUUID(),
    }));
    await db.salesSku.createMany({ data: skus });
    await db.salesSkuComponent.createMany({
      data: skus.map((sku, index) => ({
        salesSkuId: sku.id,
        itemVariantId: variants[index]!.id,
        requiredQuantity: 1,
      })),
    });
    await db.supplyItem.createMany({
      data: items.map((i, index) => ({
        workspaceId: i.workspaceId,
        businessUnitId: unit.id,
        name: `一覧資材-${token}-${String(index).padStart(3, "0")}`,
        kind: index % 2 ? "EQUIPMENT" : "MATERIAL",
        unit: "個",
      })),
    });
  } finally {
    await db.$disconnect();
  }
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await ensureTestContext(page);
  await page.goto(`/products?q=${encodeURIComponent(prefix)}`);
  await expect(page.locator(".commerce-select-row")).toHaveCount(50);
  await page.locator(".commerce-select-row input").first().focus();
  await page.keyboard.press("Space");
  await page
    .getByRole("navigation", { name: "上部のページ送り" })
    .getByRole("link", { name: "次へ", exact: true })
    .click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator(".commerce-select-row").first()).toContainText(`${prefix}-050`);
  await expect(page.locator(".commerce-select-row")).toHaveCount(50);
  await page.locator(".commerce-select-row input").first().check();
  await expect(page.locator(".catalog-selection-bar")).toContainText("2件を選択");
  await page.getByLabel("商品を検索").fill(`${prefix}-100`);
  await page.getByRole("button", { name: "検索", exact: true }).click();
  await expect(page.locator(".commerce-select-row")).toHaveCount(1);
  await expect(page.locator(".catalog-selection-bar")).toContainText("2件を選択");
  await page.getByText("選択内容", { exact: true }).click();
  await expect(page.getByRole("button", { name: /の選択を解除$/ })).toHaveCount(2);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-catalog-selection.png`,
    caret: "initial",
  });
  await page.getByRole("button", { name: "単品の販売商品を一括登録", exact: true }).press("Enter");
  await expect(page).toHaveURL(/tab=skus/);
  await expect(page.locator(".commerce-list > .commerce-row")).toHaveCount(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(`/products?q=${encodeURIComponent(prefix)}&page=2`);
  await page.locator(".commerce-select-row input").first().check();
  await page.getByRole("link", { name: `${prefix}-050`, exact: true }).click();
  await page.getByRole("link", { name: "編集", exact: true }).click();
  await page.getByLabel("商品名", { exact: true }).fill(`${prefix}-050改`);
  await page.screenshot({
    path: `.tmp/redesign-ui/${info.project.name}-item-edit.png`,
    caret: "initial",
  });
  await page.getByRole("button", { name: "変更を保存", exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.getByRole("link", { name: `${prefix}-050改`, exact: true })).toBeVisible();
  await expect(page.locator(".catalog-selection-bar")).toContainText("1件を選択");
  await page
    .getByRole("navigation", { name: "商品表示" })
    .getByRole("link", { name: "販売商品", exact: true })
    .click();
  await expect(page).toHaveURL(/tab=skus/);
  await page
    .getByRole("navigation", { name: "商品表示" })
    .getByRole("link", { name: "在庫商品", exact: true })
    .click();
  await expect(page.locator(".catalog-selection-bar")).toContainText("0件を選択");

  await page.goto(`/products?q=${encodeURIComponent(prefix)}`);
  await page.locator(".commerce-select-row input").first().check();
  const context = page.locator("details.context-selector");
  for (const name of [otherUnitName, "E2E販売部門"]) {
    if (!(await context.locator('select[name="businessUnitId"]').isVisible()))
      await context.locator("summary").click();
    await context.locator('select[name="businessUnitId"]').selectOption({ label: name });
    await context.getByRole("button", { name: "切り替え", exact: true }).click();
    await expect(context.locator("summary")).toContainText(name);
  }
  await expect(page.locator(".catalog-selection-bar")).toContainText("0件を選択");
  for (const [tab, query] of [
    ["skus", `一覧SKU-${token}`],
    ["supplies", `一覧資材-${token}`],
  ]) {
    await page.goto(`/products?tab=${tab}&q=${encodeURIComponent(query!)}`);
    await expect(page.locator(".commerce-list > .commerce-row")).toHaveCount(50);
    await page
      .getByRole("navigation", { name: "上部のページ送り" })
      .getByRole("link", { name: "次へ", exact: true })
      .click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page.locator(".commerce-list > .commerce-row").first()).toContainText(
      `${query}-050`,
    );
    await page
      .getByRole("navigation", { name: "上部のページ送り" })
      .getByRole("link", { name: "次へ", exact: true })
      .click();
    await expect(page).toHaveURL(/page=3/);
    await expect(page.locator(".commerce-list > .commerce-row")).toHaveCount(1);
    await expect(page.getByRole("navigation", { name: "下部のページ送り" })).toContainText(
      "101–101 / 101件",
    );
  }
});
