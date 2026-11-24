import { createHash } from "node:crypto";

// Stable identifiers let a rolled-back batch simulation refer to the same rows
// as the later, independently committed sales. No database sequence is reserved.
export function saleRecordId(requestKey: string, part: string) {
  const hex = createHash("sha1")
    .update(`buppancho:sale:${requestKey}:${part}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}
