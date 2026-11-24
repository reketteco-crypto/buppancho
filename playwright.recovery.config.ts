import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const target = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : null;
if (
  !target ||
  !["localhost", "127.0.0.1"].includes(target.hostname) ||
  target.port !== "55432" ||
  !/^\/buppancho_phase2_restored_[a-z0-9_]+_test$/.test(target.pathname)
)
  throw new Error("HTTPS復旧検証はrestored専用DBを指定してください。");

export default defineConfig({
  ...base,
  workers: 1,
  testMatch: ["**/recovery-https.spec.ts", "**/ux-workflow.spec.ts"],
  outputDir: ".tmp/phase2-recovery-results",
  // This rehearsal uses a temporary local certificate; it does not install a trusted root.
  use: { ...base.use, baseURL: "https://localhost:3443", ignoreHTTPSErrors: true },
  webServer: {
    command: "node scripts/test/serve-recovery-https.mjs",
    url: "https://localhost:3443/api/health/ready",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
