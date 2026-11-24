"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function ContextHelp({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details className="context-help">
      <summary>{title}</summary>
      <div>{children}</div>
    </details>
  );
}

/** Native selection keeps platform keyboard support; search is local to this field. */
export function SearchSelect({
  label,
  accessibleLabel,
  value,
  options,
  onChange,
  disabled,
  required,
  placeholder = "選択してください",
  id,
  name,
  limit = 50,
}: {
  label: string;
  accessibleLabel?: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  id?: string;
  name?: string;
  limit?: number;
}) {
  const generatedId = useId();
  const controlId = id ?? generatedId;
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const matches = options.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const candidates = matches.slice(0, limit);
  const selected = options.find((option) => option.id === value);
  const visible =
    selected && !candidates.some((option) => option.id === value)
      ? [selected, ...candidates]
      : candidates;
  return (
    <div className="field search-select">
      <label htmlFor={controlId}>{label}</label>
      <div className="search-select-control">
        <select
          id={controlId}
          name={name}
          aria-label={accessibleLabel}
          value={value}
          disabled={disabled}
          required={required}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">{placeholder}</option>
          {visible.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="commerce-text-button"
          disabled={disabled}
          aria-label={`${accessibleLabel ?? label}を検索`}
          aria-expanded={searching}
          aria-controls={`${controlId}-search`}
          onClick={() => setSearching(!searching)}
        >
          検索
        </button>
      </div>
      {searching && (
        <div className="search-select-search" id={`${controlId}-search`}>
          <input
            autoFocus
            aria-label={`${accessibleLabel ?? label}の検索語`}
            placeholder="名称・コードで絞り込む"
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                document.getElementById(controlId)?.focus();
              }
              if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                setSearching(false);
                document.getElementById(controlId)?.focus();
              }
            }}
          />
          <small>
            {matches.length
              ? `${matches.length}件${matches.length > limit ? `・先頭${limit}件を表示` : ""}`
              : "候補がありません。検索語を変えてください。"}
            。選択済みの値は保持します。
          </small>
        </div>
      )}
    </div>
  );
}

export function FieldErrors({ fields }: { fields: Record<string, string> }) {
  const root = useRef<HTMLDivElement>(null);
  const prefix = useId();
  const [targets, setTargets] = useState<{ field: string; container: Element }[]>([]);
  useEffect(() => {
    const form = root.current?.closest("form");
    if (!form) return;
    const controls = Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input,select,textarea",
      ),
    );
    const next: { field: string; container: Element }[] = [];
    const restore: (() => void)[] = [];
    for (const [index, field] of Object.keys(fields).entries()) {
      const control = controls.find(
        (element) => element.name === field || element.dataset.field === field,
      );
      if (!control) continue;
      const invalid = control.getAttribute("aria-invalid"),
        described = control.getAttribute("aria-describedby");
      const originalLabel = control.getAttribute("aria-label");
      // Keep the accessible field name stable when an inline error is added to a label.
      if (originalLabel === null && control.closest("label.field")) {
        const copy = control.closest("label.field")!.cloneNode(true) as HTMLElement;
        copy
          .querySelectorAll("input,select,textarea,button,.field-error")
          .forEach((node) => node.remove());
        control.setAttribute("aria-label", copy.textContent?.trim() || field);
      }
      control.setAttribute("aria-invalid", "true");
      control.setAttribute("aria-describedby", `${described ?? ""} ${prefix}-${index}`.trim());
      const container = control.closest(".field");
      if (container) next.push({ field, container });
      restore.push(() => {
        if (invalid === null) control.removeAttribute("aria-invalid");
        else control.setAttribute("aria-invalid", invalid);
        if (described === null) control.removeAttribute("aria-describedby");
        else control.setAttribute("aria-describedby", described);
        if (originalLabel === null) control.removeAttribute("aria-label");
        else control.setAttribute("aria-label", originalLabel);
      });
    }
    const frame = requestAnimationFrame(() => setTargets(next));
    return () => {
      cancelAnimationFrame(frame);
      restore.forEach((undo) => undo());
    };
  }, [fields, prefix]);
  return (
    <div ref={root} className="field-error-summary">
      <ul>
        {Object.entries(fields).map(([field, message]) => (
          <li key={field}>
            {targets.some((target) => target.field === field) ? (
              <button
                type="button"
                className="commerce-text-button error-link"
                onClick={() => focusField(root.current?.closest("form") ?? null, field)}
              >
                {message}
              </button>
            ) : (
              message
            )}
          </li>
        ))}
      </ul>
      {targets.map(
        ({ field, container }) =>
          fields[field] &&
          createPortal(
            <span className="field-error" id={`${prefix}-${Object.keys(fields).indexOf(field)}`}>
              {fields[field]}
            </span>,
            container,
            field,
          ),
      )}
    </div>
  );
}

export function focusField(form: HTMLFormElement | null, field: string) {
  if (!form) return;
  const controls = Array.from(
    form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    ),
  );
  const target = controls.find(
    (element) => element.name === field || element.id === field || element.dataset.field === field,
  );
  if (!target) return;
  let ancestor = target.parentElement;
  while (ancestor && ancestor !== form) {
    if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
    ancestor = ancestor.parentElement;
  }
  target.focus();
  target.scrollIntoView({ block: "center", behavior: "smooth" });
}

/** Save only a draft before leaving; never retries a business confirmation. */
export function useDraftNavigation(dirty: boolean, flush: () => Promise<boolean | number>) {
  const approved = useRef(false);
  const permittedForms = useRef(new WeakSet<HTMLFormElement>());
  const allowNavigation = useCallback(() => {
    approved.current = true;
  }, []);
  useEffect(() => {
    if (!dirty) return;
    approved.current = false;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!approved.current) event.preventDefault();
    };
    const navigate = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor =
        event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, location.href);
      if (
        url.origin !== location.origin ||
        (url.pathname === location.pathname && url.search === location.search)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void flush()
        .then((saved) => {
          if (saved !== false) {
            approved.current = true;
            location.assign(url.href);
          }
        })
        .catch(() => {});
    };
    const switchContext = (event: SubmitEvent) => {
      const form = event.target;
      if (
        !(form instanceof HTMLFormElement) ||
        !form.matches(".context-form") ||
        permittedForms.current.delete(form)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const submitter = event.submitter;
      void flush()
        .then((saved) => {
          if (saved !== false) {
            permittedForms.current.add(form);
            form.requestSubmit(submitter);
          }
        })
        .catch(() => {});
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", navigate, true);
    document.addEventListener("submit", switchContext, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", navigate, true);
      document.removeEventListener("submit", switchContext, true);
    };
  }, [dirty, flush]);
  return allowNavigation;
}
