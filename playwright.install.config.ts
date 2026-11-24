import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const target = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : null;
if (
  !target ||
  !["localhost", "127.0.0.1"].includes(target.hostname) ||
  target.port !== "55432" ||
  !/^\/buppancho_phase2_install_[a-z0-9_]+_test$/.test(target.pathname)
)
  throw new Error("初回導入検証は独立したinstall専用DBを指定してください。");

export default defineConfig({
  ...base,
  workers: 1,
  testMatch: ["**/foundation.spec.ts", "**/ux-workflow.spec.ts"],
  outputDir: ".tmp/phase2-install-results",
  use: { ...base.use, baseURL: "http://127.0.0.1:3103" },
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3103",
    url: "http://127.0.0.1:3103/api/health/ready",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
