import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { REDESIGN_DATABASE, redesignValidationConfig } from "./redesign-config";
import { E2E_PASSWORD, E2E_READY_LOGIN } from "./e2e-config";

const root = fileURLToPath(new URL("../../", import.meta.url));
const { connectionString, childEnv, baseURL } = redesignValidationConfig(process.env);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--ui")) throw new Error("指定できる追加引数は --ui だけです。");
const withUi = args.includes("--ui");
const executionEnv = {
  ...childEnv,
  ...(withUi
    ? {
        APP_URL: baseURL,
        ALLOWED_ORIGINS: new URL(baseURL).host,
        PLAYWRIGHT_BASE_URL: baseURL,
        E2E_ISOLATED: "1",
        E2E_LOGIN_NAME: E2E_READY_LOGIN,
        E2E_PASSWORD,
      }
    : {}),
};
let stage = "専用DBの読み取り確認";

async function run(label: string, args: string[]) {
  stage = label;
  console.log(`\n[${label}]`);
  await new Promise<void>((resolve, reject) => {
    // All command arguments below are fixed, not user input or connection strings.
    const windows = process.platform === "win32";
    const command = windows ? (process.env.ComSpec ?? "cmd.exe") : "pnpm";
    const commandArgs = windows ? ["/d", "/s", "/c", `pnpm.cmd ${args.join(" ")}`] : args;
    const child = spawn(command, commandArgs, { cwd: root, env: executionEnv, stdio: "inherit" });
    child.on("error", () =>
      reject(new Error("コマンドを起動できません。通常のPowerShellで実行してください。")),
    );
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${label}が失敗しました。後続処理は実行していません。`)),
    );
  });
}

const client = new Client({
  connectionString,
  connectionTimeoutMillis: 5000,
  options: "-c search_path=public",
});
try {
  await client.connect();
  const identity = await client.query<{ database: string; account: string }>(
    "SELECT current_database() AS database, current_user AS account",
  );
  if (
    identity.rows[0]?.database !== REDESIGN_DATABASE ||
    identity.rows[0]?.account !== "buppancho_test"
  )
    throw new Error("接続先を検証できません。DB更新は行いません。");
  const lease = await client.query<{ acquired: boolean }>(
    "SELECT pg_try_advisory_lock(hashtextextended('redesign-validation',0)) AS acquired",
  );
  if (!lease.rows[0]?.acquired)
    throw new Error("同じ専用DBで検証が実行中です。重ねて起動せず、先の結果を確認してください。");
  const fixtures = await client.query<{ count: string }>(
    "SELECT count(*) FROM public.workspace WHERE name='物販帳E2E'",
  );
  if (fixtures.rows[0]?.count !== "1")
    throw new Error("専用DBのテスト初期データを確認できません。自動作成・初期化は行いません。");
  const pending = await client.query<{ count: string }>(
    "SELECT count(*) FROM public._prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL",
  );
  if (pending.rows[0]?.count !== "0")
    throw new Error("未完了のマイグレーションがあります。自動修復せず停止します。");
  console.log(
    `対象：${REDESIGN_DATABASE}（テストデータを保持。DB削除・初期化・seedは実行しません）`,
  );
  await run("追加マイグレーション", ["db:deploy"]);
  await run("フォーマット", ["format:check"]);
  await run("型チェック", ["typecheck"]);
  await run("単体・DB統合テスト", ["test"]);
  await run("lint", ["lint"]);
  await run("ビルド", ["build"]);
  if (withUi)
    await run("PC幅・スマホ幅の画面回帰", [
      "exec",
      "playwright",
      "test",
      "--config=playwright.redesign.config.ts",
    ]);
  console.log(
    withUi
      ? "\nDB・フォーマット・型・テスト・lint・ビルド・対象E2Eは成功しました。実機受入と完成範囲の判定は docs/validation.md で別に管理しています。"
      : "\nDB・フォーマット・型・テスト・lint・ビルドは成功しました。この実行にはE2Eを含みません。実機受入と完成範囲の判定は docs/validation.md を確認してください。",
  );
} catch (error) {
  // Do not print raw connection errors, environment variables, or connection URLs.
  console.error(`\n停止した段階：${stage}`);
  console.error(
    error instanceof Error && !("code" in error)
      ? error.message
      : "DBまたは実行環境への接続を確認してください。接続設定は表示しません。",
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
