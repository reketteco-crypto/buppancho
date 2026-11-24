/** Only an internal money list can be used as a mutation return destination. */
export function moneyReturnHref(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\/money(?:\?[^#]*)?$/.test(value)) return undefined;
  const url = new URL(value, "http://money.local");
  const params = new URLSearchParams();
  for (const key of ["tab", "from", "to", "account", "page", "cursor", "open"]) {
    const item = url.searchParams.get(key);
    if (item !== null) params.set(key, item);
  }
  return `/money${params.size ? `?${params}` : ""}`;
}

export function moneyDisplayScope(c: {
  workspaceId: string;
  businessUnitId: string;
  reportingEntityId: string;
  operatorId: string;
  fiscalYear: { year: number };
}) {
  return `${c.workspaceId}:${c.businessUnitId}:${c.reportingEntityId}:${c.operatorId}:${c.fiscalYear.year}`;
}
