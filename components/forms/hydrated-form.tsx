"use client";

import { useSyncExternalStore, type ComponentProps } from "react";

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

// Controlled fields must not accept input before React can retain their changes.
export function HydratedForm({ children, ...props }: ComponentProps<"form">) {
  const ready = useSyncExternalStore(subscribe, clientReady, serverReady);
  return (
    <form {...props} aria-busy={!ready}>
      <fieldset
        disabled={!ready}
        className={props.className?.includes("context-form") ? "context-form" : "form-stack"}
        style={{ border: 0, padding: 0, margin: 0, minWidth: 0, gridColumn: "1 / -1" }}
      >
        {children}
      </fieldset>
    </form>
  );
}
