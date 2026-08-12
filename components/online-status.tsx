"use client";

import { useEffect, useState } from "react";

export function OnlineStatus() {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const refresh = () => setOnline(navigator.onLine);
    refresh();
    window.addEventListener("online", refresh);
    window.addEventListener("offline", refresh);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("offline", refresh);
    };
  }, []);
  return (
    <span className="online-state" role="status">
      <span className={`online-dot ${online ? "" : "offline"}`} />
      {online ? "オンライン" : "オフライン（更新不可）"}
    </span>
  );
}
