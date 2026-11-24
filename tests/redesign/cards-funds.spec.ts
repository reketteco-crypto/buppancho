import { test, expect } from "@playwright/test";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "../../scripts/test/e2e-config";
test("カード未払額と引落、私用との資金移動を記録する", async ({ page }, info) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(15000);
  const token = `${info.project.name}-${Date.now()}`,
    bank = `資金銀行-${token}`,
    card = `確認カード-${token}`;
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(E2E_READY_LOGIN);
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  for (const [name, kind] of [
    [bank, "STANDARD"],
    [card, "CREDIT_CARD"],
  ] as const) {
    await page.goto("/money");
    const add = page.locator('details:has(>summary:text-is("口座を追加"))');
    await add.locator(":scope > summary").click();
    await add.getByLabel("口座名", { exact: true }).fill(name);
    await add.getByRole("combobox", { name: "口座の種類", exact: true }).selectOption(kind);
    await add
      .getByLabel(kind === "CREDIT_CARD" ? "開始時の未払額（円）" : "開始残高（円）", {
        exact: true,
      })
      .fill("10000");
    await add.getByRole("button", { name: "口座を保存", exact: true }).click();
    await expect(
      page.locator(".commerce-row").filter({ has: page.getByText(name, { exact: true }) }),
    ).toBeVisible();
  }
  const cardRow = page
    .locator(".commerce-row")
    .filter({ has: page.getByText(card, { exact: true }) });
  await expect(cardRow).toContainText("未払額");
  await expect(cardRow).toContainText("¥10,000");
  await cardRow.getByRole("link", { name: "引落を記録", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "振替先", exact: true })).toHaveValue(/.+/);
  await page
    .getByRole("combobox", { name: "振替元", exact: true })
    .selectOption({ label: `${bank} · ¥10,000` });
  await expect(page.getByLabel("金額（円）", { exact: true })).toHaveValue("");
  await page.getByLabel("金額（円）", { exact: true }).fill("10000");
  await page.getByRole("button", { name: "振替を記録", exact: true }).click();
  await expect(cardRow).toContainText("¥0");
  for (const [kind, amount, balance] of [
    ["OWNER_CONTRIBUTION", "5000", "¥5,000"],
    ["OWNER_DRAWING", "2000", "¥3,000"],
  ] as const) {
    await page.getByRole("link", { name: /^口座間の移動/ }).click();
    await page.getByRole("combobox", { name: "資金移動の内容", exact: true }).selectOption(kind);
    const select = page.getByRole("combobox", { name: "口座", exact: true });
    const option = select.locator("option").filter({ hasText: bank });
    await select.selectOption((await option.getAttribute("value")) ?? "");
    await page.getByLabel("金額（円）", { exact: true }).fill(amount);
    await page.getByRole("button", { name: "資金移動を記録", exact: true }).click();
    await expect(
      page.locator(".commerce-row").filter({ has: page.getByText(bank, { exact: true }) }),
    ).toContainText(balance);
  }
  await page.getByRole("link", { name: /^口座間の移動/ }).click();
  await expect(page).toHaveURL(/\/money\/move(?:\?|$)/);
  await page
    .getByRole("combobox", { name: "資金移動の内容", exact: true })
    .selectOption("OWNER_CONTRIBUTION");
  await page
    .getByRole("combobox", { name: "口座", exact: true })
    .selectOption({ label: `${bank} · ¥3,000` });
  await page.getByLabel("金額（円）", { exact: true }).fill("100");
  const other = await page.context().newPage();
  await other.goto("/money/move");
  await other
    .getByRole("combobox", { name: "資金移動の内容", exact: true })
    .selectOption("OWNER_CONTRIBUTION");
  await other
    .getByRole("combobox", { name: "口座", exact: true })
    .selectOption({ label: `${bank} · ¥3,000` });
  await other.getByLabel("金額（円）", { exact: true }).fill("1");
  await other.getByRole("button", { name: "資金移動を記録", exact: true }).click();
  await expect(other).toHaveURL(/\/money$/);
  await other.close();
  await page.getByRole("button", { name: "資金移動を記録", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "口座の残高" })).toBeVisible();
  await page.getByRole("button", { name: "口座情報を再確認", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "口座情報を更新" })).toBeVisible();
  await expect(page.getByLabel("金額（円）", { exact: true })).toHaveValue("100");
  await page.getByRole("button", { name: "資金移動を記録", exact: true }).click();
  await expect(
    page.locator(".commerce-row").filter({ has: page.getByText(bank, { exact: true }) }),
  ).toContainText("¥3,101");
});
