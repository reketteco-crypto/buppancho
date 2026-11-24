import { expect, test } from "@playwright/test";

test("restored database accepts a new HTTPS login with a secure cookie and retained history", async ({
  page,
  baseURL,
}) => {
  test.skip(baseURL !== "https://localhost:3443", "隔離したHTTPS復旧環境専用");
  await page.goto("/login");
  await page.getByLabel("ユーザー名").fill(process.env.E2E_LOGIN_NAME!);
  await page.getByLabel("パスワード").fill(process.env.E2E_PASSWORD!);
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await expect(page.getByRole("heading", { name: "ホーム", exact: true })).toBeVisible();
  const cookies = await page.context().cookies();
  expect(
    cookies.some((cookie) => cookie.httpOnly && cookie.secure && cookie.sameSite === "Lax"),
  ).toBe(true);
  await page.goto("/sales?view=completed");
  await expect(page.getByRole("heading", { name: "販売", exact: true })).toBeVisible();
  expect(new URL(page.url()).protocol).toBe("https:");
});
