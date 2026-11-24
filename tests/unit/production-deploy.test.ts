import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";

describe.skipIf(process.platform !== "win32")(
  "production deployment guards",
  { timeout: 30000 },
  () => {
    function scenario(options: {
      mode?: string;
      database?: string;
      stage?: string;
      tables?: string;
      inheritedDatabase?: string;
      pending?: boolean;
    }) {
      const directory = mkdtempSync(join(tmpdir(), "buppancho-production-"));
      const workspace = join(directory, "source");
      const scriptDirectory = join(workspace, "scripts", "deploy");
      mkdirSync(scriptDirectory, { recursive: true });
      const script = join(scriptDirectory, "production.ps1");
      writeFileSync(script, readFileSync(resolve("scripts/deploy/production.ps1")));
      const log = join(directory, "docker-calls.txt");
      const envPath = join(directory, "production.env");
      const status = join(directory, "status.json");
      if (options.pending) writeFileSync(join(directory, "operation.pending"), "Update pending");
      writeFileSync(
        status,
        JSON.stringify({
          status: "success",
          mirror: "/mirror",
          file: "/backups/daily/example.dump.age",
        }),
      );
      writeFileSync(
        envPath,
        [
          `POSTGRES_DB=${options.database ?? "buppancho_prod"}`,
          "POSTGRES_USER=buppancho_prod",
          `POSTGRES_PASSWORD=${"a".repeat(64)}`,
          "LAN_ADDRESS=192.168.11.12",
          `CADDY_IMAGE=caddy:2-alpine@sha256:${"b".repeat(64)}`,
          `RELEASE_SHA=${"c".repeat(40)}`,
          `BACKUP_DIR=${directory}`,
          `BACKUP_STATUS_DIR=${directory}`,
          `BACKUP_MIRROR_DIR=${directory}`,
          `BACKUP_IDENTITY_FILE=${status}`,
        ].join("\n"),
      );
      writeFileSync(
        join(directory, "git.cmd"),
        ["@echo off", `if "%3"=="rev-parse" echo ${"c".repeat(40)}`, "exit /b 0"].join("\r\n"),
      );
      writeFileSync(
        join(directory, "docker.cmd"),
        [
          "@echo off",
          'echo %*>>"%BUPPANCHO_MOCK_LOG%"',
          'if not "%POSTGRES_DB%"=="buppancho_prod" exit /b 19',
          'echo %* | findstr /c:"%BUPPANCHO_MOCK_FAILURE%" >nul && exit /b 17',
          'echo %* | findstr /c:"pg_tables" >nul && echo %BUPPANCHO_MOCK_TABLES%',
          "exit /b 0",
        ].join("\r\n"),
      );
      const wrapper = join(directory, "wrapper.ps1");
      writeFileSync(
        wrapper,
        [
          "$ErrorActionPreference='Stop'",
          "function Get-NetIPAddress { [pscustomobject]@{IPAddress='192.168.11.12'} }",
          "& $env:BUPPANCHO_MOCK_SCRIPT -Mode $env:BUPPANCHO_MOCK_MODE -EnvFile $env:BUPPANCHO_MOCK_ENV",
        ].join("\r\n"),
      );
      try {
        const result = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper],
          {
            windowsHide: true,
            encoding: "utf8",
            timeout: 20000,
            env: {
              ...process.env,
              PATH: `${directory};${process.env.PATH}`,
              BUPPANCHO_MOCK_LOG: log,
              BUPPANCHO_MOCK_SCRIPT: script,
              BUPPANCHO_MOCK_MODE: options.mode ?? "Update",
              BUPPANCHO_MOCK_ENV: envPath,
              BUPPANCHO_MOCK_FAILURE: options.stage ?? "never-match-a-command",
              BUPPANCHO_MOCK_TABLES: options.tables ?? "0",
              POSTGRES_DB: options.inheritedDatabase ?? "buppancho_prod",
            },
          },
        );
        expect(result.error).toBeUndefined();
        return {
          status: result.status,
          calls: existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/) : [],
        };
      } finally {
        if (dirname(directory) !== tmpdir()) throw new Error("Unexpected fixture directory");
        rmSync(directory, { recursive: true });
      }
    }

    it("rejects the legacy database before any Docker call", () => {
      const result = scenario({ database: "buppancho" });
      expect(result.status).not.toBe(0);
      expect(result.calls).toHaveLength(0);
    });
    it("uses validated settings even when the shell points to the legacy DB", () => {
      const result = scenario({ inheritedDatabase: "buppancho", stage: "build" });
      expect(result.status).not.toBe(0);
      expect(result.calls.at(-1)).toContain("build");
    });
    it("does not restart services while an operation is unresolved", () => {
      const result = scenario({ mode: "Start", pending: true });
      expect(result.status).not.toBe(0);
      expect(result.calls).toHaveLength(0);
    });
    it("refuses initialization of a nonempty DB before building or migrating", () => {
      const result = scenario({ mode: "Initialize", tables: "1" });
      expect(result.status).not.toBe(0);
      expect(result.calls.some((call) => call.includes("pg_tables"))).toBe(true);
      expect(
        result.calls.some((call) => call.includes("build") || call.includes("run --rm migrate")),
      ).toBe(false);
    });
    for (const stage of [
      "build",
      "stop proxy",
      "buppancho-backup backup",
      "run --rm migrate",
      "up -d --wait app",
    ]) {
      it(`stops an update after ${stage} fails`, () => {
        const result = scenario({ stage });
        expect(result.status).not.toBe(0);
        const failureIndex = result.calls.findIndex((call) => call.includes(stage));
        expect(failureIndex).toBeGreaterThanOrEqual(0);
        expect(
          result.calls
            .slice(failureIndex + 1)
            .every((call) => call.includes("stop proxy app backup")),
        ).toBe(true);
        expect(result.calls.every((call) => call.includes("--project-name buppancho-prod"))).toBe(
          true,
        );
        expect(result.calls.every((call) => !call.includes("a".repeat(64)))).toBe(true);
      });
    }
  },
);
