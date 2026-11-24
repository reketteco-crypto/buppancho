/** Dates without an offset in the exporter are local Japanese times. */
export function salesHistoryDate(value: string): string {
  const match =
    /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!match) return "";
  const [, day, hour, minute, second, offset] = match;
  const midnight = new Date(`${day}T00:00:00Z`);
  if (
    !Number.isFinite(midnight.getTime()) ||
    midnight.toISOString().slice(0, 10) !== day ||
    (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59))
  )
    return "";
  if (!offset) return day!;
  const instant = new Date(value.trim().replace(" ", "T"));
  return Number.isFinite(instant.getTime())
    ? new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Asia/Tokyo",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(instant)
    : "";
}
