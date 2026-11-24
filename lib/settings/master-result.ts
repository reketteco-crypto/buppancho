import { z } from "zod";
import { MasterConflict } from "./master-version";

export type MasterResult = {
  status: "SAVED" | "VALIDATION" | "CONFLICT" | "ERROR";
  error?: string;
  fields?: Record<string, string>;
};
export async function masterAction(work: () => Promise<void>): Promise<MasterResult> {
  try {
    await work();
    return { status: "SAVED" };
  } catch (error) {
    // Next redirect/auth control flow must reach the framework.
    if (error && typeof error === "object" && "digest" in error) throw error;
    if (error instanceof MasterConflict) return { status: "CONFLICT", error: error.message };
    if (error instanceof z.ZodError) {
      const fields = Object.fromEntries(
        error.issues.map((issue) => [
          issue.path.join("."),
          /[ぁ-んァ-ン一-龠]/.test(issue.message)
            ? issue.message
            : "この項目の入力内容を確認してください。",
        ]),
      );
      return {
        status: "VALIDATION",
        error: "入力に不備があります。表示された項目を確認してください。",
        fields,
      };
    }
    if (error && typeof error === "object" && "code" in error && error.code === "P2002")
      return {
        status: "VALIDATION",
        error: "同じ名称・コードの設定が既にあります。最新の一覧を確認してください。",
      };
    return {
      status: "ERROR",
      error:
        error instanceof Error &&
        error.constructor === Error &&
        /[ぁ-んァ-ン一-龠]/.test(error.message)
          ? error.message
          : "設定を保存できませんでした。入力を保持しています。接続と最新の設定を確認してください。",
    };
  }
}
