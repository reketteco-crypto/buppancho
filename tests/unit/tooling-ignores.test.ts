import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";
import { globalIgnores } from "eslint/config";
import { generatedIgnores } from "../../eslint.ignores.mjs";

describe("generated temporary files are not application source", () => {
  // Test the production ignore patterns without cold-loading Next.js plugins
  // alongside DB tests. `pnpm lint` also verifies the full production config.
  const eslint = new ESLint({
    cwd: process.cwd(),
    overrideConfigFile: true,
    overrideConfig: [globalIgnores(generatedIgnores), { files: ["**/*.{js,ts,tsx}"] }],
  });
  it("excludes Playwright transform caches from lint", async () => {
    expect(await eslint.isPathIgnored(".tmp/playwright-transform-cache/ff/workflow.js")).toBe(true);
  });
  it("continues linting application code", async () => {
    expect(await eslint.isPathIgnored("lib/inventory/event-dates.ts")).toBe(false);
  });
  it("continues linting the E2E tests themselves", async () => {
    expect(await eslint.isPathIgnored("tests/e2e/ux-workflow.spec.ts")).toBe(false);
  });
});
