import { redirect } from "next/navigation";
export default function PreviousSkuEntry() {
  redirect("/products/skus/new");
}
