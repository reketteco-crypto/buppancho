import { redirect } from "next/navigation";
export default async function PreviousSku({ params }: { params: Promise<{ id: string }> }) {
  redirect(`/products/skus/${(await params).id}`);
}
