"use server";

import {
  lockMasterDomain,
  assertMasterVersion,
  assertMasterCanDeactivate,
  assertNewMasterVersion,
} from "@/lib/settings/master-version";
import { masterAction, type MasterResult } from "@/lib/settings/master-result";

import { lockInventoryDomain } from "@/lib/inventory/domain-lock";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { assertTrustedOrigin } from "@/lib/auth/origin";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import {
  ABSOLUTE_SESSION_MS,
  IDLE_SESSION_MS,
  SESSION_COOKIE,
  requireSession,
} from "@/lib/auth/session";
import { createSessionToken, hashSessionToken, normalizeLoginName } from "@/lib/auth/token";
import { formDataToSetupInput } from "@/lib/validation/setup";
import { writeAudit } from "@/lib/audit/write";

export type ActionState = { error?: string; success?: string };

const genericLoginError = "ユーザー名またはパスワードを確認してください。";

export async function loginAction(_state: ActionState, formData: FormData): Promise<ActionState> {
  await assertTrustedOrigin();
  const parsed = z
    .object({ loginName: z.string().trim().min(1), password: z.string().min(1) })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success) return { error: genericLoginError };

  const db = getDb();
  const normalizedName = normalizeLoginName(parsed.data.loginName);
  const now = new Date();
  let loginLookup;
  try {
    const [throttle, account] = await Promise.all([
      db.authLoginThrottle.findUnique({ where: { normalizedName } }),
      db.userAccount.findFirst({
        where: { normalizedName },
        include: { workspace: true },
      }),
    ]);
    loginLookup = { throttle, account };
  } catch {
    // Do not expose database availability or account existence through login responses.
    console.error("ログイン用データベースに接続できません。");
    return { error: genericLoginError };
  }
  const { throttle, account } = loginLookup;
  if (throttle?.blockedUntil && throttle.blockedUntil > now) {
    return { error: "ログイン試行が一時的に制限されています。15分後に再試行してください。" };
  }
  const passwordMatches = account
    ? await verifyPassword(account.passwordHash, parsed.data.password)
    : (await hashPassword(parsed.data.password)) && false;

  if (!account || !account.active || !passwordMatches) {
    await db.$executeRaw`
      INSERT INTO auth_login_throttle
        (normalized_name, failure_count, window_started_at, blocked_until, updated_at)
      VALUES (${normalizedName}, 1, ${now}, NULL, ${now})
      ON CONFLICT (normalized_name) DO UPDATE SET
        failure_count = CASE
          WHEN auth_login_throttle.window_started_at > ${new Date(now.getTime() - 15 * 60 * 1_000)}
          THEN auth_login_throttle.failure_count + 1 ELSE 1 END,
        window_started_at = CASE
          WHEN auth_login_throttle.window_started_at > ${new Date(now.getTime() - 15 * 60 * 1_000)}
          THEN auth_login_throttle.window_started_at ELSE ${now} END,
        blocked_until = CASE
          WHEN (CASE WHEN auth_login_throttle.window_started_at > ${new Date(now.getTime() - 15 * 60 * 1_000)}
                THEN auth_login_throttle.failure_count + 1 ELSE 1 END) >= 5
          THEN ${new Date(now.getTime() + 15 * 60 * 1_000)}::timestamptz
          ELSE NULL::timestamptz END,
        updated_at = ${now}
    `;
    return { error: genericLoginError };
  }

  const token = createSessionToken();
  const expiresAt = new Date(now.getTime() + IDLE_SESSION_MS);
  const absoluteExpiresAt = new Date(now.getTime() + ABSOLUTE_SESSION_MS);
  const defaultAssignment = account.workspace.setupCompletedAt
    ? await db.businessUnitAssignment.findFirst({
        where: {
          businessUnit: { workspaceId: account.workspaceId, active: true },
          fiscalYearProfile: { reportingEntity: { workspaceId: account.workspaceId } },
        },
        orderBy: [{ fiscalYearProfile: { year: "desc" } }, { createdAt: "asc" }],
        select: {
          businessUnitId: true,
          defaultOperatorId: true,
          fiscalYearProfile: { select: { year: true } },
        },
      })
    : null;
  const assignedOperator = defaultAssignment?.defaultOperatorId
    ? await db.operator.findFirst({
        where: {
          id: defaultAssignment.defaultOperatorId,
          workspaceId: account.workspaceId,
          active: true,
        },
        select: { id: true },
      })
    : null;
  const fallbackOperator =
    assignedOperator ??
    (account.workspace.setupCompletedAt
      ? await db.operator.findFirst({
          where: { workspaceId: account.workspaceId, active: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      : null);
  await db.$transaction(async (tx) => {
    await tx.authLoginThrottle.deleteMany({ where: { normalizedName } });
    await tx.userAccount.update({ where: { id: account.id }, data: { lastLoginAt: now } });
    const session = await tx.authSession.create({
      data: {
        userAccountId: account.id,
        tokenHash: hashSessionToken(token),
        activeOperatorId: fallbackOperator?.id ?? null,
        activeBusinessUnitId: defaultAssignment?.businessUnitId ?? null,
        selectedYear: defaultAssignment?.fiscalYearProfile.year ?? null,
        expiresAt,
        absoluteExpiresAt,
      },
    });
    await writeAudit(tx, {
      workspaceId: account.workspaceId,
      userAccountId: account.id,
      action: "auth.login",
      entityType: "auth_session",
      entityId: session.id,
    });
  });

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: absoluteExpiresAt,
  });
  redirect(account.workspace.setupCompletedAt ? "/" : "/setup");
}

export async function logoutAction(): Promise<void> {
  await assertTrustedOrigin();
  const session = await requireSession();
  const db = getDb();
  await db.$transaction(async (tx) => {
    await tx.authSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
    await writeAudit(tx, {
      workspaceId: session.userAccount.workspaceId,
      userAccountId: session.userAccountId,
      operatorId: session.activeOperatorId,
      action: "auth.logout",
      entityType: "auth_session",
      entityId: session.id,
    });
  });
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function initialSetupAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertTrustedOrigin();
  const session = await requireSession();
  let input;
  try {
    input = formDataToSetupInput(formData);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return { error: error.issues[0]?.message ?? "初期設定の入力を確認してください。" };
    }
    return { error: error instanceof Error ? error.message : "初期設定の入力を確認してください。" };
  }
  const db = getDb();
  const workspaceId = session.userAccount.workspaceId;
  const startDate = new Date(`${input.year}-01-01T00:00:00.000Z`);
  const endDate = new Date(`${input.year}-12-31T00:00:00.000Z`);

  try {
    await db.$transaction(
      async (tx) => {
        const currentWorkspace = await tx.workspace.findUnique({ where: { id: workspaceId } });
        if (!currentWorkspace || currentWorkspace.setupCompletedAt) {
          throw new Error("初期設定はすでに完了しています。");
        }
        const workspace = await tx.workspace.update({
          where: { id: workspaceId },
          data: { name: input.workspaceName },
        });
        const operators = new Map<string, { id: string; displayName: string }>();
        for (const item of input.operators) {
          const created = await tx.operator.create({
            data: { workspaceId, displayName: item.displayName },
            select: { id: true, displayName: true },
          });
          operators.set(item.key, created);
        }
        const entities = new Map<string, { id: string; displayName: string }>();
        for (const item of input.reportingEntities) {
          const created = await tx.reportingEntity.create({
            data: { workspaceId, displayName: item.displayName },
            select: { id: true, displayName: true },
          });
          entities.set(item.key, created);
        }
        const fiscalProfiles = new Map<string, { id: string }>();
        for (const item of input.fiscalYearProfiles) {
          const entity = entities.get(item.reportingEntityKey);
          if (!entity) throw new Error("年度設定の申告主体が見つかりません。");
          const created = await tx.fiscalYearProfile.create({
            data: {
              reportingEntityId: entity.id,
              year: input.year,
              filingMethod: item.filingMethod,
              consumptionTaxStatus: item.consumptionTaxStatus,
              blueDeductionTarget:
                item.filingMethod === "WHITE" ? "NONE" : item.blueDeductionTarget,
              inventoryValuationMethod: item.inventoryValuationMethod,
              inventoryValuationMethodNote: item.inventoryValuationMethodNote || null,
              startDate,
              endDate,
            },
            select: { id: true },
          });
          fiscalProfiles.set(item.reportingEntityKey, created);
        }
        const units: Array<{ id: string; name: string; defaultOperatorId: string }> = [];
        for (const item of input.businessUnits) {
          const operator = operators.get(item.defaultOperatorKey);
          const fiscal = fiscalProfiles.get(item.reportingEntityKey);
          if (!operator || !fiscal) throw new Error("販売部門の年度別割当を確認してください。");
          const unit = await tx.businessUnit.create({
            data: { workspaceId, code: item.code, name: item.name, color: item.color },
            select: { id: true, name: true },
          });
          await tx.businessUnitAssignment.create({
            data: {
              businessUnitId: unit.id,
              fiscalYearProfileId: fiscal.id,
              defaultOperatorId: operator.id,
              effectiveFrom: startDate,
              effectiveTo: endDate,
            },
          });
          units.push({ id: unit.id, name: unit.name, defaultOperatorId: operator.id });
        }
        await tx.salesChannel.createMany({
          data: [
            { workspaceId, name: "メルカリ", type: "MERCARI" },
            { workspaceId, name: "ラクマ", type: "RAKUMA" },
            { workspaceId, name: "Yahoo!フリマ", type: "YAHOO_FLEAMARKET" },
            { workspaceId, name: "メルカリShops", type: "MERCARI_SHOPS" },
            { workspaceId, name: "その他", type: "OTHER" },
          ],
          skipDuplicates: true,
        });
        await tx.workspace.update({
          where: { id: workspaceId },
          data: { setupCompletedAt: new Date() },
        });
        const firstUnit = units[0];
        if (!firstUnit) throw new Error("販売部門を1件以上登録してください。");
        await tx.authSession.update({
          where: { id: session.id },
          data: {
            activeOperatorId: firstUnit.defaultOperatorId,
            activeBusinessUnitId: firstUnit.id,
            selectedYear: input.year,
          },
        });
        await writeAudit(tx, {
          workspaceId,
          userAccountId: session.userAccountId,
          operatorId: firstUnit.defaultOperatorId,
          action: "workspace.initial_setup",
          entityType: "workspace",
          entityId: workspace.id,
          after: {
            year: input.year,
            operators: [...operators.values()].map((item) => item.displayName),
            reportingEntities: [...entities.values()].map((item) => item.displayName),
            businessUnits: units.map((item) => item.name),
          },
        });
      },
      { isolationLevel: "Serializable" },
    );
  } catch (error) {
    console.error("初期設定を保存できませんでした。", error);
    return { error: error instanceof Error ? error.message : "初期設定を保存できませんでした。" };
  }
  redirect("/");
}

export async function updateContextAction(formData: FormData): Promise<void> {
  await assertTrustedOrigin();
  const session = await requireSession();
  const parsed = z
    .object({
      operatorId: z.string().uuid(),
      businessUnitId: z.string().uuid(),
      year: z.coerce.number().int().min(2000).max(2200),
    })
    .parse(Object.fromEntries(formData));
  const db = getDb();
  const workspaceId = session.userAccount.workspaceId;
  const [operator, assignment] = await Promise.all([
    db.operator.findFirst({ where: { id: parsed.operatorId, workspaceId, active: true } }),
    db.businessUnitAssignment.findFirst({
      where: {
        businessUnitId: parsed.businessUnitId,
        businessUnit: { workspaceId, active: true },
        fiscalYearProfile: { year: parsed.year, reportingEntity: { workspaceId } },
      },
    }),
  ]);
  if (!operator || !assignment)
    throw new Error("選択した年度では入力者または販売部門を使用できません。");
  await db.authSession.update({
    where: { id: session.id },
    data: {
      activeOperatorId: operator.id,
      activeBusinessUnitId: assignment.businessUnitId,
      selectedYear: parsed.year,
    },
  });
  revalidatePath("/", "layout");
}

export async function updateWorkspaceAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const name = z.string().trim().min(1).max(100).parse(formData.get("name"));
    const db = getDb();
    const before = session.userAccount.workspace.name;
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      await assertMasterVersion(
        tx,
        session.userAccount.workspaceId,
        "workspace",
        session.userAccount.workspaceId,
        formData.get("revision"),
      );
      await tx.workspace.update({ where: { id: session.userAccount.workspaceId }, data: { name } });
      await writeAudit(tx, {
        workspaceId: session.userAccount.workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "workspace.update",
        entityType: "workspace",
        entityId: session.userAccount.workspaceId,
        before: { name: before },
        after: { name },
      });
    });
    revalidatePath("/settings/workspace");
  });
}

export async function updateOperatorAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({ id: z.string().uuid(), displayName: z.string().trim().min(1).max(50) })
      .parse(Object.fromEntries(formData));
    const db = getDb();
    const existing = await db.operator.findFirst({
      where: { id: parsed.id, workspaceId: session.userAccount.workspaceId },
    });
    if (!existing) throw new Error("入力者が見つかりません。");
    const active = formData.get("active") === "on";
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      await assertMasterVersion(
        tx,
        session.userAccount.workspaceId,
        "operator",
        existing.id,
        formData.get("revision"),
      );
      if (!active) await assertMasterCanDeactivate(tx, "operator", existing.id);
      await tx.operator.update({
        where: { id: existing.id },
        data: { displayName: parsed.displayName, active },
      });
      await writeAudit(tx, {
        workspaceId: session.userAccount.workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "operator.update",
        entityType: "operator",
        entityId: existing.id,
        before: { displayName: existing.displayName, active: existing.active },
        after: { displayName: parsed.displayName, active },
      });
    });
    revalidatePath("/settings/operators");
  });
}

export async function createOperatorAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const displayName = z.string().trim().min(1).max(50).parse(formData.get("displayName"));
    const created = await getDb().$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      const row = await tx.operator.create({
        data: { workspaceId: session.userAccount.workspaceId, displayName },
      });
      await writeAudit(tx, {
        workspaceId: session.userAccount.workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "operator.create",
        entityType: "operator",
        entityId: row.id,
        after: { displayName },
      });
      return row;
    });
    void created;
    revalidatePath("/settings/operators");
    revalidatePath("/", "layout");
  });
}

export async function updateReportingEntityAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({ id: z.string().uuid(), displayName: z.string().trim().min(1).max(50) })
      .parse(Object.fromEntries(formData));
    const db = getDb();
    const existing = await db.reportingEntity.findFirst({
      where: { id: parsed.id, workspaceId: session.userAccount.workspaceId },
    });
    if (!existing) throw new Error("申告主体が見つかりません。");
    const active = formData.get("active") === "on";
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      await assertMasterVersion(
        tx,
        session.userAccount.workspaceId,
        "reporting_entity",
        existing.id,
        formData.get("revision"),
      );
      if (!active) await assertMasterCanDeactivate(tx, "reporting_entity", existing.id);
      await tx.reportingEntity.update({
        where: { id: existing.id },
        data: { displayName: parsed.displayName, active },
      });
      await writeAudit(tx, {
        workspaceId: session.userAccount.workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "reporting_entity.update",
        entityType: "reporting_entity",
        entityId: existing.id,
        before: { displayName: existing.displayName, active: existing.active },
        after: { displayName: parsed.displayName, active },
      });
    });
    revalidatePath("/settings/reporting-entities");
  });
}

export async function createReportingEntityAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const displayName = z.string().trim().min(1).max(50).parse(formData.get("displayName"));
    await getDb().$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      const row = await tx.reportingEntity.create({
        data: { workspaceId: session.userAccount.workspaceId, displayName },
      });
      await writeAudit(tx, {
        workspaceId: session.userAccount.workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "reporting_entity.create",
        entityType: "reporting_entity",
        entityId: row.id,
        after: { displayName },
      });
    });
    revalidatePath("/settings/reporting-entities");
  });
}

export async function updateBusinessUnitAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(1).max(80),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .parse(Object.fromEntries(formData));
    const db = getDb();
    const workspaceId = session.userAccount.workspaceId;
    const existing = await db.businessUnit.findFirst({ where: { id: parsed.id, workspaceId } });
    if (!existing) throw new Error("販売部門が見つかりません。");
    const active = formData.get("active") === "on";
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, workspaceId);
      await assertMasterVersion(
        tx,
        workspaceId,
        "business_unit",
        existing.id,
        formData.get("revision"),
      );
      await tx.businessUnit.update({
        where: { id: existing.id },
        data: { name: parsed.name, color: parsed.color, active },
      });
      if (!active) {
        await tx.authSession.updateMany({
          where: { activeBusinessUnitId: existing.id },
          data: { activeBusinessUnitId: null },
        });
      }
      await writeAudit(tx, {
        workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "business_unit.update",
        entityType: "business_unit",
        entityId: existing.id,
        before: { name: existing.name, color: existing.color, active: existing.active },
        after: { name: parsed.name, color: parsed.color, active },
      });
    });
    revalidatePath("/settings/business-units");
    revalidatePath("/", "layout");
  });
}

export async function createBusinessUnitAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({
        code: z
          .string()
          .trim()
          .min(1)
          .max(40)
          .regex(/^[A-Z0-9_]+$/),
        name: z.string().trim().min(1).max(80),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .parse(Object.fromEntries(formData));
    await getDb().$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      const row = await tx.businessUnit.create({
        data: { workspaceId: session.userAccount.workspaceId, ...parsed },
      });
      await writeAudit(tx, {
        workspaceId: session.userAccount.workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "business_unit.create",
        entityType: "business_unit",
        entityId: row.id,
        after: parsed,
      });
    });
    revalidatePath("/settings/business-units");
    revalidatePath("/", "layout");
  });
}

export async function saveFiscalYearProfileAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({
        year: z.coerce.number().int().min(2000).max(2200),
        reportingEntityId: z.string().uuid(),
        filingMethod: z.enum(["BLUE", "WHITE"]),
        consumptionTaxStatus: z.enum(["EXEMPT", "TAXABLE", "INVOICE_REGISTERED"]),
        blueDeductionTarget: z.enum(["NONE", "DEDUCTION_100K", "DEDUCTION_550K", "DEDUCTION_650K"]),
        inventoryValuationMethod: z.enum([
          "SPECIFIC",
          "LAST_PURCHASE_COST",
          "GROSS_AVERAGE",
          "OTHER",
        ]),
        inventoryValuationMethodNote: z.string().trim().max(200).optional(),
      })
      .parse(Object.fromEntries(formData));
    if (parsed.filingMethod === "WHITE" && parsed.blueDeductionTarget !== "NONE")
      throw new Error("白色申告の控除目標は「なし」にしてください。");
    if (parsed.inventoryValuationMethod === "OTHER" && !parsed.inventoryValuationMethodNote)
      throw new Error("その他の評価方法を入力してください。");
    const db = getDb();
    const workspaceId = session.userAccount.workspaceId;
    const entity = await db.reportingEntity.findFirst({
      where: { id: parsed.reportingEntityId, workspaceId, active: true },
    });
    if (!entity) throw new Error("申告主体が見つかりません。");
    const startDate = new Date(`${parsed.year}-01-01T00:00:00.000Z`);
    const endDate = new Date(`${parsed.year}-12-31T00:00:00.000Z`);
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, workspaceId);
      if (
        !(await tx.reportingEntity.findFirst({
          where: { id: entity.id, workspaceId, active: true },
        }))
      )
        throw new Error("申告主体の状態が変わりました。最新の設定を確認してください。");
      for (const unit of await tx.businessUnit.findMany({
        where: { workspaceId },
        orderBy: { id: "asc" },
      }))
        await lockInventoryDomain(tx, unit.id);
      const existing = await tx.fiscalYearProfile.findUnique({
        where: { reportingEntityId_year: { reportingEntityId: entity.id, year: parsed.year } },
      });
      if (existing)
        await assertMasterVersion(
          tx,
          workspaceId,
          "fiscal_year_profile",
          existing.id,
          formData.get("revision"),
        );
      else assertNewMasterVersion(formData.get("revision"));
      if (existing?.status === "LOCKED") throw new Error("ロック済み年度は変更できません。");
      if (existing?.status === "CLOSING" && formData.get("confirmClosing") !== "on") {
        throw new Error("決算処理中の年度を変更するには確認が必要です。");
      }
      const fiscal = await tx.fiscalYearProfile.upsert({
        where: { reportingEntityId_year: { reportingEntityId: entity.id, year: parsed.year } },
        create: {
          reportingEntityId: entity.id,
          year: parsed.year,
          filingMethod: parsed.filingMethod,
          consumptionTaxStatus: parsed.consumptionTaxStatus,
          blueDeductionTarget: parsed.blueDeductionTarget,
          inventoryValuationMethod: parsed.inventoryValuationMethod,
          inventoryValuationMethodNote: parsed.inventoryValuationMethodNote || null,
          startDate,
          endDate,
        },
        update: {
          filingMethod: parsed.filingMethod,
          consumptionTaxStatus: parsed.consumptionTaxStatus,
          blueDeductionTarget: parsed.blueDeductionTarget,
          inventoryValuationMethod: parsed.inventoryValuationMethod,
          inventoryValuationMethodNote: parsed.inventoryValuationMethodNote || null,
        },
      });
      await writeAudit(tx, {
        workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: existing ? "fiscal_year.update" : "fiscal_year.create",
        entityType: "fiscal_year_profile",
        entityId: fiscal.id,
        before: existing
          ? {
              year: existing.year,
              filingMethod: existing.filingMethod,
              consumptionTaxStatus: existing.consumptionTaxStatus,
              blueDeductionTarget: existing.blueDeductionTarget,
              inventoryValuationMethod: existing.inventoryValuationMethod,
              inventoryValuationMethodNote: existing.inventoryValuationMethodNote,
              status: existing.status,
            }
          : undefined,
        after: { ...parsed, reportingEntityId: entity.id },
      });
    });
    revalidatePath("/settings/fiscal-years");
    revalidatePath("/", "layout");
  });
}

export async function saveBusinessUnitAssignmentAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({
        year: z.coerce.number().int().min(2000).max(2200),
        businessUnitId: z.string().uuid(),
        fiscalYearProfileId: z.string().uuid(),
        defaultOperatorId: z.string().uuid(),
      })
      .parse(Object.fromEntries(formData));
    const db = getDb();
    const workspaceId = session.userAccount.workspaceId;
    const [unit, fiscal, operator] = await Promise.all([
      db.businessUnit.findFirst({
        where: { id: parsed.businessUnitId, workspaceId, active: true },
      }),
      db.fiscalYearProfile.findFirst({
        where: {
          id: parsed.fiscalYearProfileId,
          year: parsed.year,
          reportingEntity: { workspaceId, active: true },
        },
      }),
      db.operator.findFirst({ where: { id: parsed.defaultOperatorId, workspaceId, active: true } }),
    ]);
    if (!unit || !fiscal || !operator) throw new Error("年度別割当の選択内容を確認してください。");
    if (fiscal.status === "LOCKED") throw new Error("ロック済み年度へ割当を変更できません。");
    if (fiscal.status === "CLOSING" && formData.get("confirmClosing") !== "on") {
      throw new Error("決算処理中の年度を変更するには確認が必要です。");
    }
    const startDate = new Date(`${parsed.year}-01-01T00:00:00.000Z`);
    const endDate = new Date(`${parsed.year}-12-31T00:00:00.000Z`);
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, workspaceId);
      if (
        !(await tx.businessUnit.findFirst({ where: { id: unit.id, workspaceId, active: true } })) ||
        !(await tx.operator.findFirst({ where: { id: operator.id, workspaceId, active: true } }))
      )
        throw new Error("入力者・部門の状態が変わりました。最新の設定を確認してください。");
      await lockInventoryDomain(tx, unit.id);
      const currentFiscal = await tx.fiscalYearProfile.findUniqueOrThrow({
        where: { id: fiscal.id },
      });
      if (currentFiscal.status === "LOCKED")
        throw new Error("ロック済み年度の割当は変更できません。");
      const existing = await tx.businessUnitAssignment.findFirst({
        where: {
          businessUnitId: unit.id,
          effectiveFrom: { lte: endDate },
          effectiveTo: { gte: startDate },
        },
        include: { fiscalYearProfile: true },
      });
      if (existing)
        await assertMasterVersion(
          tx,
          workspaceId,
          "business_unit_assignment",
          existing.id,
          formData.get("revision"),
        );
      else assertNewMasterVersion(formData.get("revision"));
      const versions = z
        .record(z.string(), z.number().int().nonnegative())
        .parse(JSON.parse(String(formData.get("fiscalVersions") ?? "{}")));
      await assertMasterVersion(
        tx,
        workspaceId,
        "fiscal_year_profile",
        fiscal.id,
        versions[fiscal.id]?.toString() ?? null,
      );
      if (existing?.fiscalYearProfile.status === "LOCKED") {
        throw new Error("ロック済み年度の割当は変更できません。");
      }
      const assignment = existing
        ? await tx.businessUnitAssignment.update({
            where: { id: existing.id },
            data: {
              fiscalYearProfileId: fiscal.id,
              defaultOperatorId: operator.id,
              effectiveFrom: startDate,
              effectiveTo: endDate,
            },
          })
        : await tx.businessUnitAssignment.create({
            data: {
              businessUnitId: unit.id,
              fiscalYearProfileId: fiscal.id,
              defaultOperatorId: operator.id,
              effectiveFrom: startDate,
              effectiveTo: endDate,
            },
          });
      await writeAudit(tx, {
        workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: existing ? "business_unit_assignment.update" : "business_unit_assignment.create",
        entityType: "business_unit_assignment",
        entityId: assignment.id,
        before: existing
          ? {
              fiscalYearProfileId: existing.fiscalYearProfileId,
              defaultOperatorId: existing.defaultOperatorId,
            }
          : undefined,
        after: {
          year: parsed.year,
          businessUnitId: unit.id,
          reportingEntityId: fiscal.reportingEntityId,
          defaultOperatorId: operator.id,
        },
      });
    });
    revalidatePath("/settings/fiscal-years");
    revalidatePath("/", "layout");
  });
}

export async function copyFiscalYearAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({
        sourceYear: z.coerce.number().int().min(2000).max(2200),
        targetYear: z.coerce.number().int().min(2000).max(2200),
      })
      .parse(Object.fromEntries(formData));
    if (parsed.sourceYear === parsed.targetYear)
      throw new Error("コピー先は別の年度にしてください。");
    const db = getDb();
    const workspaceId = session.userAccount.workspaceId;
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      const targetCount = await tx.fiscalYearProfile.count({
        where: { year: parsed.targetYear, reportingEntity: { workspaceId } },
      });
      if (targetCount > 0) throw new Error("コピー先年度にはすでに設定があります。");
      const sources = await tx.fiscalYearProfile.findMany({
        where: { year: parsed.sourceYear, reportingEntity: { workspaceId } },
        include: { assignments: true },
      });
      if (sources.length === 0) throw new Error("コピー元年度の設定がありません。");
      const startDate = new Date(`${parsed.targetYear}-01-01T00:00:00.000Z`);
      const endDate = new Date(`${parsed.targetYear}-12-31T00:00:00.000Z`);
      for (const source of sources) {
        const target = await tx.fiscalYearProfile.create({
          data: {
            reportingEntityId: source.reportingEntityId,
            year: parsed.targetYear,
            filingMethod: source.filingMethod,
            consumptionTaxStatus: source.consumptionTaxStatus,
            blueDeductionTarget: source.blueDeductionTarget,
            inventoryValuationMethod: source.inventoryValuationMethod,
            inventoryValuationMethodNote: source.inventoryValuationMethodNote,
            startDate,
            endDate,
            status: "OPEN",
          },
        });
        for (const assignment of source.assignments) {
          await tx.businessUnitAssignment.create({
            data: {
              businessUnitId: assignment.businessUnitId,
              fiscalYearProfileId: target.id,
              defaultOperatorId: assignment.defaultOperatorId,
              effectiveFrom: startDate,
              effectiveTo: endDate,
            },
          });
        }
      }
      await writeAudit(tx, {
        workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "fiscal_year.copy",
        entityType: "workspace",
        entityId: workspaceId,
        after: parsed,
      });
    });
    revalidatePath("/settings/fiscal-years");
    revalidatePath("/", "layout");
  });
}

export async function updateFiscalYearStatusAction(formData: FormData): Promise<MasterResult> {
  return masterAction(async () => {
    await assertTrustedOrigin();
    const session = await requireSession();
    const parsed = z
      .object({ id: z.string().uuid(), status: z.enum(["OPEN", "CLOSING", "LOCKED"]) })
      .parse(Object.fromEntries(formData));
    const db = getDb();
    const existing = await db.fiscalYearProfile.findFirst({
      where: { id: parsed.id, reportingEntity: { workspaceId: session.userAccount.workspaceId } },
    });
    if (!existing) throw new Error("年度設定が見つかりません。");
    if (existing.status === "LOCKED" && parsed.status !== "LOCKED") {
      throw new Error("ロック済み年度は解除できません。");
    }
    if (parsed.status === "LOCKED" && existing.status !== "CLOSING") {
      throw new Error("ロックする前に決算処理中へ変更してください。");
    }
    await db.$transaction(async (tx) => {
      await lockMasterDomain(tx, session.userAccount.workspaceId);
      await assertMasterVersion(
        tx,
        session.userAccount.workspaceId,
        "fiscal_year_profile",
        existing.id,
        formData.get("revision"),
      );
      for (const unit of await tx.businessUnit.findMany({
        where: { workspaceId: session.userAccount.workspaceId },
        orderBy: { id: "asc" },
      }))
        await lockInventoryDomain(tx, unit.id);
      const current = await tx.fiscalYearProfile.findUniqueOrThrow({ where: { id: existing.id } });
      if (current.status !== existing.status)
        throw new Error("別操作で年度状態が変更されました。再読み込みしてください。");
      await tx.fiscalYearProfile.update({
        where: { id: existing.id },
        data: { status: parsed.status, lockedAt: parsed.status === "LOCKED" ? new Date() : null },
      });
      await writeAudit(tx, {
        workspaceId: session.userAccount.workspaceId,
        userAccountId: session.userAccountId,
        operatorId: session.activeOperatorId,
        action: "fiscal_year.status.update",
        entityType: "fiscal_year_profile",
        entityId: existing.id,
        before: { status: existing.status, lockedAt: existing.lockedAt },
        after: { status: parsed.status },
      });
    });
    revalidatePath("/settings/fiscal-years");
  });
}

export async function changePasswordAction(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  await assertTrustedOrigin();
  const session = await requireSession();
  const parsed = z
    .object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(12, "新しいパスワードは12文字以上にしてください。").max(200),
    })
    .safeParse(Object.fromEntries(formData));
  if (!parsed.success)
    return { error: parsed.error.issues[0]?.message ?? "入力を確認してください。" };
  if (!(await verifyPassword(session.userAccount.passwordHash, parsed.data.currentPassword))) {
    return { error: "現在のパスワードが一致しません。" };
  }
  const passwordHash = await hashPassword(parsed.data.newPassword);
  const db = getDb();
  await db.$transaction(async (tx) => {
    await tx.userAccount.update({ where: { id: session.userAccountId }, data: { passwordHash } });
    await tx.authSession.updateMany({
      where: { userAccountId: session.userAccountId, id: { not: session.id }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await writeAudit(tx, {
      workspaceId: session.userAccount.workspaceId,
      userAccountId: session.userAccountId,
      operatorId: session.activeOperatorId,
      action: "auth.password_change",
      entityType: "user_account",
      entityId: session.userAccountId,
    });
  });
  return { success: "パスワードを変更し、他のセッションを失効しました。" };
}

export async function revokeOtherSessionsAction(): Promise<void> {
  await assertTrustedOrigin();
  const session = await requireSession();
  await getDb().authSession.updateMany({
    where: { userAccountId: session.userAccountId, id: { not: session.id }, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  revalidatePath("/settings/security");
}
