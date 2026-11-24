export type ImportCandidate = {
  adapterId: string;
  kind: "PURCHASE" | "DELIVERY" | "COST";
  fileName: string;
  digest: string;
  reference?: string;
  date?: string;
  currency?: string;
  exchangeRate?: string;
  lines: { name: string; quantity?: number; amount?: string; sourceReference?: string }[];
  charges: { name: string; amount?: string; currency: string }[];
  unresolved: string[];
};
export type Sheet = { name: string; rows: string[][] };
export function amountText(value: string | undefined): string | undefined {
  const clean = (value || "").replace(/[¥￥,，\s円元]/g, "");
  return /^(0|[1-9]\d*)(\.\d+)?$/.test(clean) ? clean : undefined;
}
export function quantityText(value: string | undefined) {
  const v = amountText(value);
  if (!v || !/^\d+$/.test(v)) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= 1000000 ? n : undefined;
}
export function dateText(value: string | undefined) {
  const v = (value || "")
    .trim()
    .replace(/[年月/.]/g, "-")
    .replace(/日/g, "");
  const match = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return undefined;
  const iso = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}
