import { previewWorkflowValuationAction } from "@/app/sales/workflow-actions";
export async function POST(request: Request) {
  const body = await request.text();
  if (body.length > 250000)
    return Response.json({ error: "入力が大きすぎます。", code: "VALIDATION" }, { status: 400 });
  try {
    return Response.json(await previewWorkflowValuationAction(JSON.parse(body)), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json(
      {
        error: "影響を確認できませんでした。入力を保持し、再確認してください。",
        code: "VALIDATION",
      },
      { status: 400 },
    );
  }
}
