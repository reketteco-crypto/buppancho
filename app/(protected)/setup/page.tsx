import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth/session";
import { SetupForm } from "@/components/forms/setup-form";

export default async function SetupPage() {
  const session = await requireSession();
  if (session.userAccount.workspace.setupCompletedAt) redirect("/");
  return <SetupForm initialWorkspaceName={session.userAccount.workspace.name} />;
}
