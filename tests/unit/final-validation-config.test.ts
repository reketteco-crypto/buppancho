import { describe, expect, it } from "vitest";
import {
  FINAL_WORK_DATABASE,
  finalValidationConfig,
} from "../../scripts/test/final-validation-config";

describe("final validation database safety", () => {
  const valid = `postgresql://buppancho_test:test@127.0.0.1:55432/${FINAL_WORK_DATABASE}`;
  it("ignores the ordinary DATABASE_URL and explicitly sets both child connection variables", () => {
    const config = finalValidationConfig({
      DATABASE_URL: "postgresql://production/private",
      OTHER: "kept",
    });
    expect(new URL(config.connectionString).pathname).toBe(`/${FINAL_WORK_DATABASE}`);
    expect(config.childEnv.DATABASE_URL).toBe(config.childEnv.TEST_DATABASE_URL);
    expect(config.childEnv.OTHER).toBe("kept");
    expect(config.childEnv.BUPPANCHO_TEST_INSTANCE).toBe("phase2");
  });
  it.each([
    valid.replace(FINAL_WORK_DATABASE, "buppancho_mobile_test"),
    valid.replace(FINAL_WORK_DATABASE, "buppancho"),
    valid.replace("127.0.0.1", "remote.example"),
    valid.replace("55432", "5432"),
    valid.replace("buppancho_test:", "postgres:"),
    `${valid}?options=unsafe`,
    `${valid}#ignored`,
    "not a url",
  ])("rejects any other destination or additional connection options", (url) => {
    expect(() => finalValidationConfig({ TEST_DATABASE_URL: url })).toThrow();
  });
  it("accepts the exact dedicated DB without echoing its password", () => {
    expect(finalValidationConfig({ TEST_DATABASE_URL: valid }).connectionString).toBe(valid);
    try {
      finalValidationConfig({ TEST_DATABASE_URL: valid.replace("127.0.0.1", "remote.example") });
    } catch (error) {
      expect(String(error)).not.toContain(":test@");
    }
  });
});
