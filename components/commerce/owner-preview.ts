"use client";
import { useState, useEffect } from "react";
export function useOwnerPreview(values: object, enabled: boolean) {
  const key = JSON.stringify(values),
    [result, setResult] = useState<{
      key: string;
      plan?: {
        fingerprint: string;
        allocations: {
          sourceTransactionId: string;
          amountJpy: string;
          name: string;
          date: string;
        }[];
      };
      error?: string;
    }>(),
    [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const abort = new AbortController(),
      timer = setTimeout(() => {
        void (async () => {
          try {
            const response = await fetch("/api/commerce", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                action: "owner-preview",
                kind: "MONEY_RECORD",
                payload: JSON.parse(key),
              }),
              signal: abort.signal,
            });
            const data = await response.json();
            if (!abort.signal.aborted) setResult({ key, plan: data.ownerPlan, error: data.error });
          } catch {
            if (!abort.signal.aborted)
              setResult({ key, error: "充当内訳を確認できません。入力は保持しています。" });
          }
        })();
      }, 350);
    return () => {
      abort.abort();
      clearTimeout(timer);
    };
  }, [key, enabled, tick]);
  return {
    plan: enabled && result?.key === key ? result.plan : undefined,
    error: enabled && result?.key === key ? result.error : undefined,
    refresh: () => setTick((n) => n + 1),
  };
}
