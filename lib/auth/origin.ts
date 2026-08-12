import { headers } from "next/headers";
import { getServerEnv } from "@/lib/env";

export async function assertTrustedOrigin(): Promise<void> {
  const requestHeaders = await headers();
  const origin = requestHeaders.get("origin");
  if (!origin) return;

  const originHost = new URL(origin).host;
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const configured = (getServerEnv().ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (originHost !== host && !configured.includes(originHost)) {
    throw new Error("許可されていない送信元です。");
  }
}
