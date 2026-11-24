import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Never reuse the smartphone server or any already-running application.
export default defineConfig({
  ...base,
  workers: 1,
  testMatch: [
    "**/ux-finish.spec.ts",
    "**/master-conflict.spec.ts",
    "**/valuation-year.spec.ts",
    "**/inventory-recovery.spec.ts",
    "**/purchase-conflict.spec.ts",
    "**/return-workflow.spec.ts",
    "**/ux-workflow.spec.ts",
    "**/reliability.spec.ts",
    "**/phase2-sales.spec.ts",
  ],
  use: { ...base.use, baseURL: "http://127.0.0.1:3102" },
  webServer: {
    command: "node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3102",
    url: "http://127.0.0.1:3102/api/health/ready",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
