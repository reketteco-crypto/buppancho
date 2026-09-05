import { spawn } from "node:child_process";
import { E2E_PASSWORD, E2E_READY_LOGIN, E2E_SETUP_LOGIN } from "./e2e-config";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const commonEnv = {
  ...process.env,
  TEST_DATABASE_URL:
    process.env.TEST_DATABASE_URL ??
    "postgresql://buppancho_test:buppancho_test_only@127.0.0.1:55432/buppancho_test",
  PLAYWRIGHT_BASE_URL: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100",
  E2E_LOGIN_NAME: process.env.E2E_LOGIN_NAME ?? E2E_READY_LOGIN,
  E2E_PASSWORD: process.env.E2E_PASSWORD ?? E2E_PASSWORD,
  E2E_SETUP_LOGIN_NAME: process.env.E2E_SETUP_LOGIN_NAME ?? E2E_SETUP_LOGIN,
  E2E_SETUP_PASSWORD: process.env.E2E_SETUP_PASSWORD ?? E2E_PASSWORD,
  E2E_ISOLATED: "1",
};

async function run(args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const command = process.platform === "win32" ? process.env.ComSpec! : pnpm;
    const commandArgs =
      process.platform === "win32" ? ["/d", "/s", "/c", `${pnpm} ${args.join(" ")}`] : args;
    const child = spawn(command, commandArgs, { stdio: "inherit", env: commonEnv });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${args.join(" ")} failed`)),
    );
  });
}

await fetch(`${commonEnv.PLAYWRIGHT_BASE_URL}/api/health/ready`).then((response) => {
  if (!response.ok) throw new Error("E2E用アプリが起動していません。");
});
await run(["exec", "vitest", "run"]);
await run(["exec", "playwright", "test"]);
