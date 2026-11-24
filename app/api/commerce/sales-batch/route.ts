import { z } from "zod";
import { assertTrustedOrigin } from "@/lib/auth/origin";
import { requireInventoryContext } from "@/lib/inventory/context";
import { workflowContextSchema } from "@/lib/validation/workflow";
import { requestResult } from "@/lib/sales/request-store";
import { WorkflowError } from "@/lib/sales/workflow-errors";
import {
  forkSalesBatch,
  previewSalesBatch,
  readSalesBatch,
  rememberSalesBatchMapping,
  salesBatchProgress,
  saveSalesBatch,
  saveSalesBatchNext,
} from "@/lib/commerce/sales-batch";
import { revalidatePath } from "next/cache";

const noStore = { "Cache-Control": "no-store" };
export async function POST(request: Request) {
  let saving = false;
  try {
    await assertTrustedOrigin();
    const raw = await request.text();
    if (raw.length > 8000000)
      throw new WorkflowError("VALIDATION", "入力が大きすぎます。CSVを分けてください。");
    const body = z
      .object({
        action: z.enum([
          "fork",
          "read",
          "draft",
          "preview",
          "progress",
          "save",
          "result",
          "cancel",
          "mapping",
        ]),
        context: workflowContextSchema,
        id: z.uuid(),
        revision: z.number().int().min(0).default(0),
        index: z.number().int().min(0).default(0),
        key: z.uuid().optional(),
        data: z.unknown().optional(),
      })
      .parse(JSON.parse(raw));
    const current = await requireInventoryContext();
    const c = {
      workspaceId: current.workspaceId,
      businessUnitId: current.businessUnitId,
      reportingEntityId: current.reportingEntityId,
      operatorId: current.operatorId,
      year: current.fiscalYear.year,
      userAccountId: current.session.userAccountId,
      sessionId: current.session.id,
    };
    const recovery = body.action === "result" || body.action === "cancel";
    if (
      body.context.businessUnitId !== c.businessUnitId ||
      body.context.operatorId !== c.operatorId ||
      (!recovery &&
        (body.context.year !== c.year || body.context.reportingEntityId !== c.reportingEntityId))
    )
      throw new WorkflowError(
        "CONTEXT_CHANGED",
        "入力先が変わりました。入力を保持し、元の部門・年度へ戻してください。",
      );
    if (recovery)
      return Response.json(await requestResult(current.db, c, body.id, body.action === "cancel"), {
        headers: noStore,
      });
    let result: unknown;
    switch (body.action) {
      case "fork":
        saving = true;
        result = await forkSalesBatch(current.db, c, body.id, z.uuid().parse(body.key), body.data);
        break;
      case "read":
        result = await readSalesBatch(current.db, c, body.id);
        break;
      case "draft":
        saving = true;
        result = await saveSalesBatch(
          current.db,
          c,
          body.id,
          body.revision,
          z.uuid().parse(body.key),
          body.data,
        );
        break;
      case "preview":
        result = await previewSalesBatch(current.db, c, body.id, body.revision);
        break;
      case "progress":
        result = await salesBatchProgress(current.db, c, body.id);
        break;
      case "mapping":
        saving = true;
        result = await rememberSalesBatchMapping(
          current.db,
          c,
          body.data,
          z.uuid().parse(body.key),
        );
        break;
      case "save":
        saving = true;
        result = await saveSalesBatchNext(current.db, c, body.id, body.index);
        for (const path of ["/", "/sales", "/inventory", "/products"]) revalidatePath(path);
        break;
    }
    return Response.json({ status: "OK", result }, { headers: noStore });
  } catch (error) {
    if (error instanceof WorkflowError)
      return Response.json(
        { status: "REJECTED", code: error.code, error: error.message },
        { status: 409, headers: noStore },
      );
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return Response.json(
        { status: "REJECTED", error: "入力項目・CSVの内容を確認してください。" },
        { status: 400, headers: noStore },
      );
    return Response.json(
      {
        status: saving ? "UNKNOWN" : "REJECTED",
        error: saving
          ? "保存結果を確認してください。途中保存は同じ内容で再確認し、販売の確定要求は先に照会してください。"
          : "読み取り・確認に失敗しました。入力を保持して再試行してください。",
      },
      { status: 500, headers: noStore },
    );
  }
}
