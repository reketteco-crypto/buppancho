import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";

describe.skipIf(process.platform !== "win32")("更新の失敗時停止", () => {
  for (const [stage, expectedCalls] of [
    ["backup", 1],
    ["build", 2],
    ["migrate", 3],
    ["up", 4],
  ] as const) {
    it(`${stage}失敗後は後続コマンドを呼ばない`, () => {
      const directory = mkdtempSync(join(tmpdir(), "buppancho-deploy-"));
      const log = join(directory, "calls.txt");
      try {
        writeFileSync(
          join(directory, "docker.cmd"),
          [
            "@echo off",
            'echo %*>>"%BUPPANCHO_MOCK_LOG%"',
            'if "%BUPPANCHO_MOCK_FAILURE%"=="backup" if "%2"=="run" exit /b 17',
            'if "%BUPPANCHO_MOCK_FAILURE%"=="build" if "%2"=="build" exit /b 17',
            'if "%BUPPANCHO_MOCK_FAILURE%"=="migrate" if "%2"=="--profile" exit /b 17',
            'if "%BUPPANCHO_MOCK_FAILURE%"=="up" if "%2"=="up" exit /b 17',
            "exit /b 0",
          ].join("\r\n"),
        );
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve("scripts/deploy/update.ps1"),
          ],
          {
            encoding: "utf8",
            windowsHide: true,
            timeout: 10000,
            env: {
              ...process.env,
              PATH: `${directory};${process.env.PATH}`,
              BUPPANCHO_MOCK_LOG: log,
              BUPPANCHO_MOCK_FAILURE: stage,
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).not.toBe(0);
        expect(readFileSync(log, "utf8").trim().split(/\r?\n/)).toHaveLength(expectedCalls);
      } finally {
        if (dirname(directory) !== tmpdir())
          throw new Error("テスト用一時ディレクトリを確認できません。");
        rmSync(directory, { recursive: true });
      }
    });
  }
});
