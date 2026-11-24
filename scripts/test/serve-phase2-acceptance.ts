import { spawn } from "node:child_process";

const target = new URL(process.env.DATABASE_URL ?? "");
const address = new URL(process.env.APP_URL ?? "");
if (
  target.hostname !== "127.0.0.1" ||
  target.port !== "55432" ||
  target.pathname !== "/buppancho_phase2_acceptance_20261028_01_test" ||
  address.protocol !== "http:" ||
  address.port !== "3106" ||
  !/^192\.168\.\d{1,3}\.\d{1,3}$/.test(address.hostname)
)
  throw new Error("専用受入DBと信頼するLANの3106番ポートを指定してください。");

// Explicit development-only LAN server. Production Secure cookies stay unchanged.
// Next 16 stores development artifacts in .next-phase2/dev, outside the mobile server's .next.
const child = spawn(
  process.execPath,
  ["node_modules/next/dist/bin/next", "dev", "--hostname", address.hostname, "--port", "3106"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "development",
      BUPPANCHO_TEST_INSTANCE: "phase2",
      ALLOWED_ORIGINS: address.host,
    },
  },
);
const stop = () => {
  child.kill();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("error", () => {
  console.error("受入サーバーを起動できませんでした。");
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
