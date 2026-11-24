import { spawn } from "node:child_process";
import { cpSync, existsSync, symlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { redesignValidationConfig } from "./redesign-config";

const root = new URL("../../", import.meta.url);
const distDir = existsSync(new URL(".next-validation/standalone/server.js", root))
  ? ".next-validation"
  : ".next-money-history";
const source = new URL(`${distDir}/standalone/`, root);
const sourceModules = fileURLToPath(new URL("node_modules", source));
const standalone = new URL(`.tmp/preview-3113-${randomUUID()}/`, root);
const config = redesignValidationConfig({
  ...process.env,
  BUPPANCHO_TEST_POSTGRES_PORT: "54320",
  BUPPANCHO_REDESIGN_UI_PORT: "3112",
  ...(distDir === ".next-validation" ? { BUPPANCHO_REDESIGN_ISOLATED_BUILD: "1" } : {}),
});
if (!existsSync(new URL("server.js", source)))
  throw new Error("確認用ビルドがありません。専用DBで test:redesign:ui を実行してください。");

// Run from a separate snapshot so neither the next build nor the running preview locks the other's files.
cpSync(source, standalone, {
  recursive: true,
  dereference: true,
  filter: (path) => path !== sourceModules && !basename(path).startsWith(".env"),
});
// pnpm's traced standalone dependencies can rely on links outside the copied tree on Windows.
symlinkSync(
  fileURLToPath(new URL("node_modules", root)),
  new URL("node_modules", standalone),
  "junction",
);
cpSync(new URL(`${distDir}/static/`, root), new URL(`${distDir}/static/`, standalone), {
  recursive: true,
});
cpSync(new URL("public/", root), new URL("public/", standalone), { recursive: true });

console.log("確認画面 http://127.0.0.1:3113/purchases/new");
console.log("再設計の専用テストDBを使用します。終了はCtrl+Cです。");
const server = spawn(process.execPath, [fileURLToPath(new URL("server.js", standalone))], {
  cwd: fileURLToPath(standalone),
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...config.childEnv,
    NODE_ENV: "production",
    NODE_PATH: fileURLToPath(new URL("node_modules/.pnpm/node_modules", root)),
    PORT: "3113",
    HOSTNAME: "127.0.0.1",
    APP_URL: "http://127.0.0.1:3113",
    ALLOWED_ORIGINS: "127.0.0.1:3113",
  },
});
server.on("error", () => {
  console.error("確認用サーバーを起動できませんでした。");
  process.exitCode = 1;
});
server.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
