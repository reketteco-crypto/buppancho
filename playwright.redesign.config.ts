import { defineConfig, devices } from "@playwright/test";
import { redesignValidationConfig } from "./scripts/test/redesign-config";

const config = redesignValidationConfig(process.env);
export default defineConfig({
  testDir: "./tests/redesign",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: config.baseURL, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["iPhone 13"], browserName: "chromium" } },
  ],
  webServer: {
    command: `pnpm dev --hostname 127.0.0.1 --port ${config.uiPort}`,
    url: `${config.baseURL}/api/health/live`,
    env: Object.fromEntries(
      Object.entries(config.childEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    reuseExistingServer: false,
    timeout: 120000,
  },
});
