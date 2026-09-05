import { redirect } from "next/navigation";

export default function LegacyUsedPurchasePage() {
  redirect("/purchases/new");
}
