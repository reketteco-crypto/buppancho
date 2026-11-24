import { CatalogDetail } from "@/components/commerce/catalog-detail";
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ edit?: string; unit?: string }>;
}) {
  const { id } = await params,
    query = await searchParams;
  return <CatalogDetail id={id} kind="SUPPLY_SAVE" {...query} />;
}
