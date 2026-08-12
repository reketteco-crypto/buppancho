import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { hashSessionToken } from "@/lib/auth/token";

export const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-buppancho_session" : "buppancho_session";
export const IDLE_SESSION_MS = 24 * 60 * 60 * 1_000;
export const ABSOLUTE_SESSION_MS = 30 * 24 * 60 * 60 * 1_000;

export async function getCurrentSession() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const db = getDb();
  const now = new Date();
  const session = await db.authSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      userAccount: { include: { workspace: true } },
      activeOperator: true,
      activeBusinessUnit: true,
    },
  });

  if (
    !session ||
    session.revokedAt ||
    !session.userAccount.active ||
    session.expiresAt <= now ||
    session.absoluteExpiresAt <= now
  ) {
    return null;
  }

  if (now.getTime() - session.lastSeenAt.getTime() > 5 * 60 * 1_000) {
    const expiresAt = new Date(
      Math.min(now.getTime() + IDLE_SESSION_MS, session.absoluteExpiresAt.getTime()),
    );
    await db.authSession.update({
      where: { id: session.id },
      data: { lastSeenAt: now, expiresAt },
    });
  }
  return session;
}

export async function requireSession() {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session;
}
