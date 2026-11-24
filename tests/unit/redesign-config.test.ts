import { describe, it, expect } from "vitest";
import { redesignValidationConfig, REDESIGN_DATABASE } from "../../scripts/test/redesign-config";
describe("汎用再設計の専用DB接続", () => {
  it.each(["55432", "54320"])("明示した検証ポート %s だけを許可する", (port) => {
    const result = redesignValidationConfig({
      BUPPANCHO_TEST_POSTGRES_PORT: port,
      DATABASE_URL: "postgresql://production/private",
    });
    expect(new URL(result.connectionString).port).toBe(port);
    expect(new URL(result.connectionString).pathname).toBe(`/${REDESIGN_DATABASE}`);
    expect(result.childEnv.DATABASE_URL).toBe(result.childEnv.TEST_DATABASE_URL);
  });
  it.each([
    "postgresql://buppancho_test:test@127.0.0.1:54320/buppancho",
    `postgresql://buppancho_test:test@remote.example:54320/${REDESIGN_DATABASE}`,
    `postgresql://postgres:test@127.0.0.1:54320/${REDESIGN_DATABASE}`,
    `postgresql://buppancho_test:test@127.0.0.1:55432/${REDESIGN_DATABASE}`,
    `postgresql://buppancho_test:test@127.0.0.1:54320/${REDESIGN_DATABASE}?options=unsafe`,
  ])("通常DB・別ホスト・別ロール・ポート不一致・接続オプションを拒否する", (url) => {
    expect(() =>
      redesignValidationConfig({ BUPPANCHO_TEST_POSTGRES_PORT: "54320", TEST_DATABASE_URL: url }),
    ).toThrow();
  });
  it("未対応のポートを拒否する", () =>
    expect(() => redesignValidationConfig({ BUPPANCHO_TEST_POSTGRES_PORT: "5432" })).toThrow());
  it("使用中の確認画面から検証用3112と生成先を分離する", () => {
    const value = redesignValidationConfig({ BUPPANCHO_REDESIGN_UI_PORT: "3112" });
    expect(value.baseURL).toBe("http://127.0.0.1:3112");
    expect(value.childEnv.BUPPANCHO_TEST_INSTANCE).toBe("money-history");
    expect(value.childEnv.ALLOWED_ORIGINS).toBe("127.0.0.1:3112");
  });
  it("検証用画面の任意ポートを拒否する", () =>
    expect(() => redesignValidationConfig({ BUPPANCHO_REDESIGN_UI_PORT: "3000" })).toThrow());
  it("稼働中のstandalone生成先に触れず固定した独立生成先を使う", () => {
    const value = redesignValidationConfig({
      BUPPANCHO_REDESIGN_UI_PORT: "3112",
      BUPPANCHO_REDESIGN_ISOLATED_BUILD: "1",
    });
    expect(value.childEnv.BUPPANCHO_TEST_INSTANCE).toBe("validation");
    expect(value.baseURL).toBe("http://127.0.0.1:3112");
    expect(new URL(value.connectionString).pathname).toBe(`/${REDESIGN_DATABASE}`);
  });
  it("任意の独立生成先指定を拒否する", () => {
    expect(() =>
      redesignValidationConfig({ BUPPANCHO_REDESIGN_ISOLATED_BUILD: "../../private" }),
    ).toThrow();
  });
});
