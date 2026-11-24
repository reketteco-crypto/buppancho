import { redirect } from "next/navigation";
export default async function PreviousCompletion({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/sales/listings/${(await params).id}`);
}
