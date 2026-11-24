export const REDESIGN_DATABASE = "buppancho_redesign_20261110_test";
const DEFAULT_URL = `postgresql://buppancho_test:buppancho_test_only@127.0.0.1:55432/${REDESIGN_DATABASE}`;
export function redesignValidationConfig<T extends Record<string, string | undefined>>(env: T) {
  const port = env.BUPPANCHO_TEST_POSTGRES_PORT ?? "55432";
  if (!["55432", "54320"].includes(port))
    throw new Error("再設計の検証用ポートは55432または54320を指定してください。");
  const uiPort = env.BUPPANCHO_REDESIGN_UI_PORT ?? "3110";
  if (!["3110", "3112"].includes(uiPort))
    throw new Error("検証画面のポートは3110または3112を指定してください。");
  const baseURL = `http://127.0.0.1:${uiPort}`;
  const isolatedBuild = env.BUPPANCHO_REDESIGN_ISOLATED_BUILD;
  if (isolatedBuild !== undefined && isolatedBuild !== "1")
    throw new Error("独立した検証用生成先は1を指定してください。");
  const connectionString = env.TEST_DATABASE_URL ?? DEFAULT_URL.replace(":55432/", `:${port}/`);
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("再設計専用DBの設定を確認してください。");
  }
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== port ||
    url.username !== "buppancho_test" ||
    url.pathname !== `/${REDESIGN_DATABASE}` ||
    url.search ||
    url.hash
  )
    throw new Error(
      "再設計の検証は固定の専用DBだけを対象にします。通常DB・スマホDBは変更しません。",
    );
  return {
    connectionString,
    uiPort,
    baseURL,
    childEnv: {
      ...env,
      DATABASE_URL: connectionString,
      TEST_DATABASE_URL: connectionString,
      PGOPTIONS: "-c search_path=public",
      BUPPANCHO_TEST_INSTANCE:
        isolatedBuild === "1" ? "validation" : uiPort === "3112" ? "money-history" : "redesign",
      APP_URL: baseURL,
      ALLOWED_ORIGINS: `127.0.0.1:${uiPort}`,
    },
  };
}
