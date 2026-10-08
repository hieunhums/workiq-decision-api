"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./ui.module.css";

type Me = {
  configured: boolean;
  cli: boolean;
  mode: "user" | "cli" | "none";
  name: string | null;
  username: string | null;
};

function initials(name: string): string {
  const parts = name.split(/[\s.@]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

/**
 * Whose Work IQ answers: the person signed in with Microsoft, or the Work IQ
 * CLI on the machine serving the page. Shown top right, like Microsoft's own
 * account menus.
 */
export function Account() {
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe(null));
    // A failed sign-in comes back as ?signin=<reason>. Shown once, then
    // dropped from the address bar.
    const url = new URL(window.location.href);
    const reason = url.searchParams.get("signin");
    if (reason) {
      setProblem(
        reason === "unavailable"
          ? "Sign-in is not set up on this server. Set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET."
          : reason,
      );
      setOpen(true);
      url.searchParams.delete("signin");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) =>
      event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const signOut = async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.reload();
  };

  const user = me?.mode === "user";
  const label = user
    ? (me?.name ?? "Signed in")
    : me?.mode === "cli"
      ? "This Mac"
      : "Sign in";

  return (
    <div className={styles.account} ref={box}>
      <button
        className={styles.accountButton}
        data-mode={me?.mode ?? "none"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Whose Work IQ answers"
      >
        <span className={styles.avatar}>
          {user
            ? initials(me?.name ?? "")
            : me?.mode === "cli"
              ? "\u2318"
              : "?"}
        </span>
        <span className={styles.accountLabel}>{label}</span>
      </button>

      {open && (
        <div className={styles.accountMenu} role="menu">
          <div className={styles.accountHead}>Answering as</div>

          {user ? (
            <div className={styles.accountItem} data-on="true" data-mode="user">
              <span className={styles.avatar}>{initials(me?.name ?? "")}</span>
              <span>
                <strong>{me?.name}</strong>
                <small>{me?.username}</small>
                <small>
                  Your own Work IQ, through Microsoft Graph and the Work IQ
                  service
                </small>
              </span>
            </div>
          ) : me?.cli ? (
            <div className={styles.accountItem} data-on="true">
              <span className={styles.avatar}>{"\u2318"}</span>
              <span>
                <strong>This Mac</strong>
                <small>The Work IQ CLI, as whoever signed in to it here</small>
              </span>
            </div>
          ) : (
            <div className={styles.accountItem}>
              <span>
                <strong>Nobody yet</strong>
                <small>Sign in to ask about your work</small>
              </span>
            </div>
          )}

          {problem && <p className={styles.accountProblem}>{problem}</p>}

          <div className={styles.accountActions}>
            {user ? (
              <button
                role="menuitem"
                className={styles.accountAction}
                onClick={signOut}
              >
                Sign out{me?.cli ? ", back to this Mac" : ""}
              </button>
            ) : (
              <a
                role="menuitem"
                className={styles.accountAction}
                data-primary="true"
                href="/api/auth/login"
                aria-disabled={!me?.configured}
                title={
                  me?.configured
                    ? undefined
                    : "Set ENTRA_CLIENT_ID and ENTRA_CLIENT_SECRET to enable"
                }
              >
                <MicrosoftMark />
                Sign in with Microsoft
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function MicrosoftMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
