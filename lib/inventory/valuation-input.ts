/** Receipt versions are rechecked by the executor, not by the stock preview hash.
 * Business record versions, dates, quantities and draft contents remain in the hash.
 * The durable request hash still includes every field, including draftRevision.
 */
export function valuationBusinessInput(input: object) {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key]) => !["idempotencyKey", "valuationFingerprint", "draftRevision"].includes(key),
    ),
  );
}
