"use client";

import { useEffect, useRef, useState, type ComponentProps, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { HydratedForm } from "./hydrated-form";
import type { MasterResult } from "@/lib/settings/master-result";
import { createClientUuid } from "@/lib/client-uuid";

type Action = (data: FormData) => Promise<MasterResult>;
export function MasterForm({
  action,
  alternateActions,
  children,
  ...props
}: Omit<ComponentProps<"form">, "action" | "onSubmit"> & {
  action: Action;
  alternateActions?: Record<string, Action>;
}) {
  const router = useRouter();
  const heading = useRef<HTMLHeadingElement>(null);
  const [result, setResult] = useState<MasterResult>();
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const [local, setLocal] = useState<{ name: string; label: string; value: string }[]>([]);
  useEffect(() => {
    const form = heading.current?.closest("form");
    if (result?.error) heading.current?.focus();
    const cleanups: (() => void)[] = [];
    for (const [name, message] of Object.entries(result?.fields ?? {})) {
      const control = form?.elements.namedItem(name);
      if (!(control instanceof HTMLElement)) continue;
      const previousInvalid = control.getAttribute("aria-invalid");
      const previousDescription = control.getAttribute("aria-describedby");
      const error = document.createElement("span");
      error.className = "field-error";
      error.id = `master-error-${createClientUuid()}`;
      error.textContent = message;
      const field = control.closest(".field");
      if (field?.tagName === "LABEL") field.after(error);
      else (field ?? control.parentElement)?.append(error);
      control.setAttribute("aria-invalid", "true");
      control.setAttribute(
        "aria-describedby",
        [previousDescription, error.id].filter(Boolean).join(" "),
      );
      cleanups.push(() => {
        error.remove();
        if (previousInvalid === null) control.removeAttribute("aria-invalid");
        else control.setAttribute("aria-invalid", previousInvalid);
        if (previousDescription === null) control.removeAttribute("aria-describedby");
        else control.setAttribute("aria-describedby", previousDescription);
      });
    }
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [result]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const form = event.currentTarget;
    const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const data = new FormData(form, button);
    const selected = button?.dataset.masterAction
      ? alternateActions?.[button.dataset.masterAction]
      : action;
    const plan = Array.from(form.elements)
      .filter(
        (node): node is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
          (node instanceof HTMLInputElement ||
            node instanceof HTMLSelectElement ||
            node instanceof HTMLTextAreaElement) &&
          node.type !== "hidden" &&
          !!node.name,
      )
      .map((node) => ({
        name: node.name,
        label:
          node.getAttribute("aria-label") ??
          node.closest("label")?.querySelector("span")?.textContent ??
          node.name,
        value:
          node instanceof HTMLInputElement && node.type === "checkbox"
            ? node.checked
              ? "有効・確認済み"
              : "無効・未選択"
            : node instanceof HTMLSelectElement
              ? (node.selectedOptions[0]?.textContent ?? "未選択")
              : node.value,
      }));
    setLocal(plan);
    setPending(true);
    setResult(undefined);
    try {
      if (!selected) throw new Error("操作を確認してください。");
      const next = await selected(data);
      setResult(next);
      if (next.status === "SAVED") router.refresh();
      else requestAnimationFrame(() => heading.current?.focus());
    } catch {
      setResult({
        status: "ERROR",
        error:
          "保存結果を確認できません。入力を保持しています。最新の設定を別画面で確認し、保存済みか分からない間は再送しないでください。",
      });
      requestAnimationFrame(() => heading.current?.focus());
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  }
  return (
    <HydratedForm {...props} onSubmit={(event) => void submit(event)}>
      {result?.error && (
        <section className="message error" role="alert" style={{ gridColumn: "1 / -1" }}>
          <h3 ref={heading} tabIndex={-1}>
            設定を確認してください
          </h3>
          <p>{result.error}</p>
          {Object.entries(result.fields ?? {}).map(([name, message]) => (
            <p key={name}>
              <button
                type="button"
                className="button secondary"
                onClick={(event) => {
                  const form = event.currentTarget.closest("form");
                  const control = form?.elements.namedItem(name);
                  if (control instanceof HTMLElement) control.focus();
                }}
              >
                {local.find((row) => row.name === name)?.label ?? "入力項目"}：{message}
              </button>
            </p>
          ))}
          {result.status === "CONFLICT" && (
            <>
              <details>
                <summary>保存されなかった手元の入力</summary>
                {local.map((row, i) => (
                  <p key={i}>
                    {row.label}：{row.value || "未入力"}
                  </p>
                ))}
              </details>
              <p>下の入力は保持しています。読み直す前に変更内容を確認してください。</p>
              <button
                type="button"
                className="button secondary"
                onClick={() => window.location.reload()}
              >
                最新の設定を読み直す
              </button>
            </>
          )}
        </section>
      )}
      {result?.status === "SAVED" && <p role="status">設定を保存しました。</p>}
      <fieldset
        disabled={pending}
        className="plain-fieldset"
        style={{ minWidth: 0, border: 0, padding: 0, margin: 0, display: "contents" }}
      >
        {children}
      </fieldset>
    </HydratedForm>
  );
}
