import { redirect } from "next/navigation";
export default async function PreviousListingReturn({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  redirect(`/sales/listings/${(await params).id}`);
}
