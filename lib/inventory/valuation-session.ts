import { AsyncLocalStorage } from "node:async_hooks";

/** Transaction-local simulation state. Never authorizes a different request/context. */
export const valuationSession = new AsyncLocalStorage<{
  preview?: boolean;
  evaluating?: boolean;
  costs?: Map<string, bigint>;
  order?: string;
  requestKey?: string;
}>();
export const historicalPreviewAllowed = () => !!valuationSession.getStore()?.evaluating;
export function plannedMovementCost(key: string, fallback: bigint) {
  const state = valuationSession.getStore();
  return state?.costs?.get(key.replace(state.requestKey ?? "\u0000", "pending")) ?? fallback;
}
export function plannedOperationOrder() {
  return valuationSession.getStore()?.order;
}
export function plannedOutCost(fallback: bigint) {
  const costs = valuationSession.getStore()?.costs;
  return costs ? [...costs.values()].filter((c) => c < 0n).reduce((s, c) => s - c, 0n) : fallback;
}
