import { redirect } from "next/navigation";

export default function LegacyDomesticPurchasePage() {
  redirect("/purchases/new");
}
