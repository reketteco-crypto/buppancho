/** The final-work DB is disposable test input, never the smartphone acceptance DB. */
export const FINAL_WORK_DATABASE = "buppancho_phase2_final_work_20261024_test";
const DEFAULT_URL = `postgresql://buppancho_test:buppancho_test_only@127.0.0.1:55432/${FINAL_WORK_DATABASE}`;

export function finalValidationConfig<T extends Record<string, string | undefined>>(env: T) {
  // Deliberately do not fall back to DATABASE_URL or .env.
  const connectionString = env.TEST_DATABASE_URL ?? DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("専用テストDBの接続設定を確認してください。接続文字列は表示しません。");
  }
  if (
    !["postgresql:", "postgres:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    url.port !== "55432" ||
    url.username !== "buppancho_test" ||
    url.pathname !== `/${FINAL_WORK_DATABASE}` ||
    url.search ||
    url.hash
  )
    throw new Error(
      "このコマンドはlocalhost:55432のフェーズ2最終作業DB専用です。スマホ用・通常DBは変更しません。",
    );
  return {
    connectionString,
    childEnv: {
      ...env,
      DATABASE_URL: connectionString,
      TEST_DATABASE_URL: connectionString,
      PGOPTIONS: "-c search_path=public",
      BUPPANCHO_TEST_INSTANCE: "phase2",
    },
  };
}
