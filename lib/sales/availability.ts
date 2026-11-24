export type AvailabilityComponent = {
  requiredQuantity: number;
  availableQuantity: number;
};

export function skuAvailability(components: AvailabilityComponent[]): number {
  if (!components.length) return 0;
  return Math.max(
    0,
    Math.min(
      ...components.map(({ requiredQuantity, availableQuantity }) =>
        Math.floor(availableQuantity / requiredQuantity),
      ),
    ),
  );
}

export function listingAvailability(
  listedQuantity: number,
  reservedQuantity: number,
  availableSkuQuantity: number,
): number {
  return Math.max(0, Math.min(listedQuantity - reservedQuantity, availableSkuQuantity));
}

export const listingTransitions: Record<string, readonly string[]> = {
  DRAFT: ["ACTIVE", "ENDED"],
  ACTIVE: ["PAUSED", "SOLD_OUT", "ENDED"],
  PAUSED: ["ACTIVE", "ENDED"],
  SOLD_OUT: ["ACTIVE", "ENDED"],
  ENDED: [],
};

export function canChangeListingStatus(from: string, to: string): boolean {
  return from === to || (listingTransitions[from]?.includes(to) ?? false);
}
