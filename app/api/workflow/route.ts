import { z } from "zod";
import { submitWorkflowAction } from "@/app/sales/workflow-actions";
import { workflowKindSchema } from "@/lib/validation/workflow";
export async function POST(request: Request) {
  try {
    const body = await request.text();
    if (body.length > 250000) throw new Error("入力が大きすぎます。");
    const input = z
      .object({
        kind: workflowKindSchema,
        payload: z.record(z.string(), z.unknown()),
      })
      .parse(JSON.parse(body));
    return Response.json(await submitWorkflowAction(input.kind, input.payload), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        status: "UNKNOWN",
        error: "保存要求を確認できません。保存結果を照会してから再実行してください。",
      },
      { status: 400 },
    );
  }
}
