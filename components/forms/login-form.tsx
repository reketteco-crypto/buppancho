"use client";

import { useActionState } from "react";
import { loginAction, type ActionState } from "@/app/actions";

const initialState: ActionState = {};

export function LoginForm() {
  const [state, action, pending] = useActionState(loginAction, initialState);
  return (
    <form action={action} className="stack">
      <label className="field">
        <span>ユーザー名</span>
        <input name="loginName" autoComplete="username" required autoFocus />
      </label>
      <label className="field">
        <span>パスワード</span>
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state.error ? (
        <p className="message error" role="alert">
          {state.error}
        </p>
      ) : null}
      <button className="button" disabled={pending} type="submit">
        {pending ? "確認しています…" : "ログイン"}
      </button>
    </form>
  );
}
