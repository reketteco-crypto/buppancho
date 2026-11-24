export function settingsReturnPath(value: string | undefined) {
  return typeof value === "string" &&
    /^\/(?:sales\/(?:listings\/new|new|batch)|purchases\/new)\?draft=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      value,
    )
    ? value
    : null;
}

export function withInputReturn(href: string, returnTo?: string) {
  const safe = settingsReturnPath(returnTo);
  return safe
    ? `${href}${href.includes("?") ? "&" : "?"}returnTo=${encodeURIComponent(safe)}`
    : href;
}
