"use client";

import { useActionState } from "react";
import { changePasswordAction, type ActionState } from "@/app/actions";

export function PasswordForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(changePasswordAction, {});
  return (
    <form action={action} className="stack">
      <label className="field">
        <span>現在のパスワード</span>
        <input type="password" name="currentPassword" autoComplete="current-password" required />
      </label>
      <label className="field">
        <span>新しいパスワード（12文字以上）</span>
        <input
          type="password"
          name="newPassword"
          minLength={12}
          autoComplete="new-password"
          required
        />
      </label>
      {state.error ? (
        <p className="message error" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="message success" role="status">
          {state.success}
        </p>
      ) : null}
      <button className="button" disabled={pending}>
        {pending ? "変更しています…" : "パスワードを変更"}
      </button>
    </form>
  );
}
