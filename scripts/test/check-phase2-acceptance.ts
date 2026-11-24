import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { E2E_PASSWORD } from "./e2e-config";

const target = new URL(process.env.APP_URL ?? "");
if (
  target.protocol !== "http:" ||
  target.port !== "3106" ||
  !target.hostname.startsWith("192.168.")
)
  throw new Error("実機受入用LANの3106番ポートを指定してください。");
const fixture = JSON.parse(await readFile(".tmp/phase2-acceptance/cases.json", "utf8")) as {
  workspace: string;
  cases: Record<string, string>;
};
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    baseURL: target.origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // No business draft or confirmation is submitted by this read-only connectivity check.
  await page.route("**/api/workflow", (route) => route.abort());
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill("phase2_acceptance");
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  await expect(page.getByText(fixture.workspace, { exact: true })).toBeAttached();
  for (const [key, path] of Object.entries(fixture.cases)) {
    await page.goto("/");
    const selector = page.locator("details.context-selector");
    await selector.locator("summary").click();
    await selector.getByLabel("対象年度").selectOption("2026");
    await selector
      .getByLabel("販売部門")
      .selectOption({ label: key === "yearSwitch" ? "年度切替確認部門" : "スマホ確認部門" });
    await selector.getByRole("button", { name: "切り替え", exact: true }).click();
    await expect(selector.locator("summary")).toContainText(
      `${key === "yearSwitch" ? "年度切替確認部門" : "スマホ確認部門"}・2026年`,
    );
    await page.goto(path);
    if (["normal", "backdated", "yearSwitch"].includes(key))
      await expect(page.getByLabel("完了日（日本時間・必須）")).toBeVisible();
    else if (key === "split")
      await expect(page.getByLabel("返品日", { exact: true })).toBeVisible();
    else
      await expect(
        page.getByRole("heading", { name: "完了前の返送を確認する", exact: true }),
      ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(
      await page
        .locator('input:not([type="hidden"]),select,textarea')
        .evaluateAll((elements) =>
          elements.every((element) => parseFloat(getComputedStyle(element).fontSize) >= 16),
        ),
    ).toBe(true);
    await page.screenshot({ path: `.tmp/phase2-acceptance/${key}.png`, fullPage: true });
  }
  expect(errors).toEqual([]);
  console.log(
    "実機受入用LAN HTTP: ログイン、6画面、390px幅、入力16px以上、画面例外なし。業務確定・下書きは未送信。",
  );
} finally {
  await browser.close();
}
