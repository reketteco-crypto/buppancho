import { z } from "zod";
import { getCurrentSession } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { requestResult } from "@/lib/sales/request-store";
import {
  cancelWorkflowRequestAction,
  resumeWorkflowRequestAction,
} from "@/app/sales/workflow-actions";
import { workflowContextSchema } from "@/lib/validation/workflow";
const headers = { "Cache-Control": "no-store" };
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getCurrentSession();
  if (!session?.activeOperatorId || !session.activeBusinessUnitId)
    return Response.json(
      { status: "UNKNOWN", error: "再ログインして元の入力者・部門で結果を確認してください。" },
      { status: 401, headers },
    );
  try {
    const id = z.uuid().parse((await params).id);
    const db = getDb();
    const workspaceId = session.userAccount.workspaceId;
    const [operator, unit] = await Promise.all([
      db.operator.findFirst({ where: { id: session.activeOperatorId, workspaceId, active: true } }),
      db.businessUnit.findFirst({
        where: { id: session.activeBusinessUnitId, workspaceId, active: true },
      }),
    ]);
    if (!operator || !unit) throw new Error("Inactive input context");
    const result = await requestResult(
      db,
      {
        workspaceId: session.userAccount.workspaceId,
        businessUnitId: session.activeBusinessUnitId,
        operatorId: session.activeOperatorId,
        userAccountId: session.userAccountId,
        year: session.selectedYear ?? 0,
        reportingEntityId: "",
      },
      id,
    );
    return Response.json({ ...result, saved: result.status === "APPLIED" }, { headers });
  } catch {
    return Response.json(
      {
        status: "UNKNOWN",
        error: "保存結果を参照できません。元の入力者・部門と通信を確認してください。",
      },
      { status: 403, headers },
    );
  }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = z.uuid().parse((await params).id),
      body = await request.text();
    if (body.length > 2000) throw new Error();
    const input = z
      .object({ mode: z.enum(["cancel", "resume"]), context: workflowContextSchema })
      .parse(JSON.parse(body));
    const result = await (
      input.mode === "cancel" ? cancelWorkflowRequestAction : resumeWorkflowRequestAction
    )(id, input.context);
    return Response.json(result, { headers });
  } catch {
    return Response.json(
      {
        status: "UNKNOWN",
        error: "保存状態をまだ確認できません。接続と入力先を確認してください。",
      },
      { status: 400, headers },
    );
  }
}
