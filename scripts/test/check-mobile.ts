import { chromium, expect } from "@playwright/test";
import { E2E_PASSWORD } from "./e2e-config";

const target = new URL(process.env.APP_URL ?? "");
if (
  target.protocol !== "http:" ||
  target.port !== "3100" ||
  !target.hostname.startsWith("192.168.")
)
  throw new Error("確認用LANアドレスの3100番ポートを指定してください。");
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
  // This is a connectivity check; do not leave incomplete business drafts for the user.
  await page.route("**/*", async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.postData()?.includes('"requestId"')) await route.abort();
    else await route.continue();
  });
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill("mobile_test");
  await page.getByLabel("パスワード").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe("undefined");
  await page.goto("/sales/listings/new");
  await page.getByLabel("商品名・色・サイズ・個体コードで検索").fill("スマホ確認用商品");
  await page.getByRole("button", { name: /スマホ確認用商品/ }).click();
  await page.getByLabel("出品URLまたは商品ID").fill("m900000000001");
  await page.getByLabel("出品価格（円）").fill("1280");
  await expect(
    page.getByRole("button", { name: "出品を記録して在庫を確保", exact: true }),
  ).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/purchases/new");
  await expect(page.getByLabel("注文番号（任意）")).toBeVisible();
  expect(errors).toEqual([]);
  console.log(
    "LAN HTTP: login, insecure-context UUID fallback, listing input and purchase input passed. No listing or stock change submitted.",
  );
} finally {
  await browser.close();
}
