"use client";

import { useEffect, useState } from "react";
import { Messenger } from "@/client/messenger";
import { copy } from "@/client/copy";
import { MessengerContext, useMessenger } from "./context";
import { Sidebar } from "./Sidebar";
import { Conversation } from "./Conversation";
import { Logo } from "./Logo";

function createBrowserMessenger(): Messenger {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return new Messenger({
    baseUrl: "",
    wsUrl: `${proto}//${window.location.host}/ws`,
    fetch: (input, init) => window.fetch(input, init),
    openSocket: (url) => new WebSocket(url) as never,
    storage: window.localStorage,
  });
}

export function RelayApp() {
  const [m, setM] = useState<Messenger | null>(null);
  useEffect(() => {
    const inst = createBrowserMessenger();
    setM(inst);
    void inst.start().catch(() => undefined);
    // BR-READ-2 focus gate (+ OD-8: hidden tab closes it).
    const open = () => {
      if (!document.hidden) inst.setFocusGate(true);
    };
    const close = () => inst.setFocusGate(false);
    const vis = () => (document.hidden ? close() : undefined);
    window.addEventListener("blur", close);
    window.addEventListener("focus", open);
    window.addEventListener("mousemove", open);
    window.addEventListener("touchstart", open);
    document.addEventListener("visibilitychange", vis);
    return () => {
      window.removeEventListener("blur", close);
      window.removeEventListener("focus", open);
      window.removeEventListener("mousemove", open);
      window.removeEventListener("touchstart", open);
      document.removeEventListener("visibilitychange", vis);
      inst.stop();
    };
  }, []);
  if (!m) return null;
  return (
    <MessengerContext.Provider value={m}>
      <Shell />
    </MessengerContext.Provider>
  );
}

export function Shell() {
  const m = useMessenger();
  if (m.phase === "boot") return <div className="auth" />;
  if (m.phase === "signedOut") return <AuthScreen />;
  const banner = m.resetting
    ? copy.resetting
    : m.syncing
      ? copy.updating
      : m.connection === "connecting"
        ? copy.connecting
        : m.connection === "offline"
          ? copy.reconnecting
          : null;
  return (
    <div className={`app${m.openPeerId != null ? " has-open" : ""}`}>
      {banner && (
        <div className="banner" role="status">
          {banner}
        </div>
      )}
      <Sidebar />
      <Conversation />
      <Toasts />
    </div>
  );
}

function Toasts() {
  const m = useMessenger();
  useEffect(() => {
    if (m.notices.length === 0) return;
    const first = m.notices[0];
    const t = setTimeout(() => m.dismissNotice(first.id), 3500);
    return () => clearTimeout(t);
  }, [m.notices, m]);
  return (
    <div className="toasts" aria-live="polite">
      {m.notices.map((n) => (
        <div className="toast" key={n.id} onClick={() => m.dismissNotice(n.id)}>
          {n.text}
        </div>
      ))}
    </div>
  );
}

export function AuthScreen() {
  const m = useMessenger();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await m.login(username, password);
      else await m.register(username, displayName, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth">
      <form className="auth-card" onSubmit={submit}>
        <h1>
          <Logo size={34} /> {copy.product}
        </h1>
        <p style={{ margin: 0, color: "var(--ink-soft)" }}>{copy.tagline}</p>
        <label>
          {copy.username}
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
        </label>
        {mode === "up" && (
          <label>
            {copy.displayName}
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
          </label>
        )}
        <label>
          {copy.password}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "in" ? "current-password" : "new-password"}
            required
          />
        </label>
        {error && <div className="error" role="alert">{error}</div>}
        <button className="primary" disabled={busy}>
          {mode === "in" ? copy.signIn : copy.register}
        </button>
        <button type="button" className="link" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? copy.switchToRegister : copy.switchToSignIn}
        </button>
      </form>
    </main>
  );
}
