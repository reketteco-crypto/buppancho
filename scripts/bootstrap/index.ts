import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { getDb } from "../../lib/db/client";
import { hashPassword } from "../../lib/auth/password";
import { normalizeLoginName } from "../../lib/auth/token";

async function readSecret(prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function")
    throw new Error("パスワード入力には対話式TTYが必要です。");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (key: string) => {
      if (key === "\u0003") {
        cleanup();
        reject(new Error("中断しました。"));
        return;
      }
      if (key === "\r" || key === "\n") {
        stdout.write("\n");
        cleanup();
        resolve(value);
        return;
      }
      if (key === "\u007f" || key === "\b") {
        value = value.slice(0, -1);
        return;
      }
      if (key >= " ") value += key;
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on("data", onData);
  });
}

async function main() {
  const db = getDb();
  if (await db.workspace.count())
    throw new Error("ワークスペースは既に存在します。bootstrapは再実行できません。");
  const rl = createInterface({ input: stdin, output: stdout });
  const workspaceName = (await rl.question("ワークスペース名 [物販帳]: ")).trim() || "物販帳";
  const loginName = (await rl.question("共通ログイン名: ")).trim();
  rl.close();
  if (!loginName) throw new Error("ログイン名は必須です。");
  const password = await readSecret("パスワード（12文字以上）: ");
  const confirmation = await readSecret("パスワード（確認）: ");
  if (password.length < 12) throw new Error("パスワードは12文字以上にしてください。");
  if (password !== confirmation) throw new Error("パスワードが一致しません。");
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    const workspace = await tx.workspace.create({ data: { name: workspaceName } });
    const account = await tx.userAccount.create({
      data: {
        workspaceId: workspace.id,
        loginName,
        normalizedName: normalizeLoginName(loginName),
        passwordHash,
      },
    });
    await tx.auditLog.create({
      data: {
        workspaceId: workspace.id,
        userAccountId: account.id,
        action: "workspace.bootstrap",
        entityType: "workspace",
        entityId: workspace.id,
        afterJson: { name: workspaceName },
      },
    });
  });
  stdout.write(
    "管理アカウントを作成しました。ログイン後に2026年度の初期設定を完了してください。\n",
  );
  await db.$disconnect();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
