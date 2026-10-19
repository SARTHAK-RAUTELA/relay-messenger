"use client";

import { useEffect, useState } from "react";
import { copy } from "@/client/copy";
import { ApiFailure } from "@/client/api";
import { useMessenger } from "./context";

const errorText = (e: unknown) => (e instanceof ApiFailure ? e.message : copy.loadFailed);

/** Profile name, password change and account deletion. */
export function SettingsDialog(props: { onClose(): void }) {
  const m = useMessenger();
  const [name, setName] = useState(m.me?.displayName ?? "");
  const [email, setEmail] = useState(m.myEmail ?? "");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [deletePw, setDeletePw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ ok: true, text: ok });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={copy.settings}>
      <div className="modal" style={{ overflowY: "auto" }}>
        <h2>{copy.settings}</h2>
        <section>
          <h3>{copy.profile}</h3>
          <input type="text" aria-label={copy.displayName} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          <button className="primary" disabled={busy || !name.trim() || name.trim() === m.me?.displayName} onClick={() => run(() => m.updateProfile(name), copy.nameSaved)}>
            {copy.saveName}
          </button>
        </section>
        <section>
          <h3>{copy.email}</h3>
          {!m.myEmail && <p className="hint">{copy.addEmailHint}</p>}
          <input type="email" aria-label={copy.email} value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          <button
            className="ghost"
            disabled={busy || !email.trim() || email.trim() === m.myEmail}
            onClick={() => run(() => m.updateEmail(email), copy.emailSaved)}
          >
            {copy.saveEmail}
          </button>
        </section>
        <section>
          <h3>{copy.changePassword}</h3>
          <input type="password" aria-label={copy.currentPassword} placeholder={copy.currentPassword} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          <input type="password" aria-label={copy.newPassword} placeholder={copy.newPassword} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
          <button
            className="ghost"
            disabled={busy || !current || !next}
            onClick={() =>
              run(async () => {
                await m.changePassword(current, next);
                setCurrent("");
                setNext("");
              }, copy.passwordChanged)
            }
          >
            {copy.changePassword}
          </button>
        </section>
        <section>
          <h3>{copy.deleteAccount}</h3>
          <p className="hint">{copy.deleteAccountHint}</p>
          <input type="password" aria-label={copy.password} placeholder={copy.password} value={deletePw} onChange={(e) => setDeletePw(e.target.value)} autoComplete="current-password" />
          <button className="danger" disabled={busy || !deletePw} onClick={() => run(() => m.deleteAccount(deletePw))}>
            {copy.deleteAccountConfirm}
          </button>
        </section>
        {msg && (
          <div className={msg.ok ? "ok" : "error"} role={msg.ok ? "status" : "alert"}>
            {msg.text}
          </div>
        )}
        <div className="actions">
          <button className="ghost" onClick={props.onClose}>
            {copy.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Shows the key fingerprint of a secret chat for out-of-band comparison. */
export function SecretKeyDialog(props: { peerId: number; onClose(): void }) {
  const m = useMessenger();
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void m.secretFingerprint(props.peerId).then((c) => live && setCode(c ?? "—"));
    return () => {
      live = false;
    };
  }, [m, props.peerId]);
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label={copy.secretKey}>
      <div className="modal">
        <h2>{copy.secretKey}</h2>
        <div className="fingerprint" data-testid="fingerprint">
          {code ?? <span className="spinner" />}
        </div>
        <p className="hint">{copy.secretKeyHint}</p>
        <div className="actions">
          <button className="ghost" onClick={props.onClose}>
            {copy.close}
          </button>
        </div>
      </div>
    </div>
  );
}
