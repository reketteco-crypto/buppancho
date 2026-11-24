import { ESLint } from "eslint";

// Run sequentially in the lint gate, outside Vitest's parallel workers.
// This loads the real Next.js/TypeScript config: the fast unit test is not a substitute.
const eslint = new ESLint({ cwd: process.cwd() });
const checks = [
  [".tmp/playwright-transform-cache/ff/workflow.js", true],
  ["lib/inventory/event-dates.ts", false],
  ["tests/e2e/ux-workflow.spec.ts", false],
];
for (const [path, expected] of checks) {
  if ((await eslint.isPathIgnored(path)) !== expected)
    throw new Error(`ESLintの実設定が想定外です：${path}`);
}
console.log("ESLint実設定の除外・ソース対象確認：3件成功");
