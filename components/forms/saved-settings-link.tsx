"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SavedSettingsLink({
  href,
  returnTo,
  prepare,
  resume,
  children,
}: {
  href: string;
  returnTo: string;
  prepare: () => Promise<number>;
  resume: () => void;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const target = `${href}?returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <>
      <Link
        href={target}
        aria-disabled={pending}
        onClick={async (event) => {
          event.preventDefault();
          if (pending) return;
          const fieldset = event.currentTarget.closest("form")?.querySelector("fieldset");
          const wasDisabled = fieldset?.disabled ?? false;
          if (fieldset) fieldset.disabled = true;
          setPending(true);
          setError("");
          try {
            await prepare();
            router.push(target);
          } catch {
            if (fieldset) fieldset.disabled = wasDisabled;
            resume();
            setPending(false);
            setError(
              "途中保存を確認できません。入力を保持しています。保存結果を確認してから設定へ進んでください。",
            );
          }
        }}
      >
        {pending ? "入力を保存しています…" : children}
      </Link>
      {error && (
        <span role="alert" className="field-error">
          {error}
        </span>
      )}
    </>
  );
}
