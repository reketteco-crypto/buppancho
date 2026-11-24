import { describe, expect, it } from "vitest";
import { z } from "zod";
import { masterAction } from "@/lib/settings/master-result";
import { assertNewMasterVersion, MasterConflict } from "@/lib/settings/master-version";

describe("master save feedback", () => {
  it("distinguishes validation, stale versions and confirmed saves", async () => {
    expect(await masterAction(async () => {})).toEqual({ status: "SAVED" });
    expect(
      await masterAction(async () => {
        throw new MasterConflict("別端末の変更を確認してください。");
      }),
    ).toMatchObject({ status: "CONFLICT" });
    expect(
      await masterAction(async () => {
        z.object({ name: z.string().min(1) }).parse({ name: "" });
      }),
    ).toMatchObject({
      status: "VALIDATION",
      fields: { name: "この項目の入力内容を確認してください。" },
    });
  });
  it("does not expose raw database errors or swallow auth redirects", async () => {
    expect(
      await masterAction(async () => {
        throw new TypeError("private connection data");
      }),
    ).not.toHaveProperty("error", expect.stringContaining("private"));
    const redirect = { digest: "NEXT_REDIRECT" };
    await expect(
      masterAction(async () => {
        throw redirect;
      }),
    ).rejects.toEqual(redirect);
  });
  it("requires an explicit new-record baseline", () => {
    expect(() => assertNewMasterVersion("NEW")).not.toThrow();
    expect(() => assertNewMasterVersion(null)).toThrow(MasterConflict);
    expect(() => assertNewMasterVersion("0")).toThrow(MasterConflict);
  });
});
