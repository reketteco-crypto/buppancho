import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";

test("主要5画面の操作とPC・スマホのレイアウト", async ({ page }, testInfo) => {
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード", { exact: true }).fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goto("/design");
  for (const name of ["購入", "購入詳細", "商品・SKU", "販売", "お金"]) {
    await page
      .getByRole("navigation", { name: "プレビュー画面" })
      .getByRole("button", { name, exact: true })
      .click();
    await expect(page.locator(".commerce-heading h1")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: `.tmp/redesign-ui/${testInfo.project.name}-${name === "購入" ? "purchase" : name === "購入詳細" ? "detail" : name === "商品・SKU" ? "products" : name === "販売" ? "sale" : "money"}.png`,
      fullPage: true,
      caret: "initial",
    });
  }
  await page
    .getByRole("navigation", { name: "プレビュー画面" })
    .getByRole("button", { name: "購入", exact: true })
    .click();
  await page.getByLabel("受取済み").uncheck();
  await expect(page.getByRole("button", { name: "購入を保存", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "購入を保存", exact: true }).click();
  await expect(page.locator(".commerce-toast")).toContainText("データは保存していません");
});
