// Accounts: the sign-in dialog, the Account settings tab, the Claude key on the
// account, and the small sync indicators on the projects page and top bar.
// None of this shows when Kerf runs without a server.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode, type SVGProps } from "react";
import { api } from "../cloud/api";
import { closeAuth, openAuth, refreshAccount, requestReset, resetPassword, signIn, signOut, signUp, useAccount, type AuthMode } from "../cloud/account";
import { keepOnThisDevice, keepWaitingLocal, setAutoUpload, syncNow, uploadToAccount, useSync } from "../cloud/sync";
import { closeSettings, confirmDialog, go, openSettings, toast } from "../app/ui";
import { useProject } from "../app/project";
import { forgetApiKey, getApiKey, keyHint, validateKeyFormat } from "../persist/vault";
import { Modal, Toggle, timeAgo, useTick } from "./common";
import { Icon } from "./icons";
import "../styles/account.css";

// ---------- small pieces ----------

function I({ size = 16, children, ...rest }: SVGProps<SVGSVGElement> & { size?: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}
export const CloudIcon = (p: { size?: number }) => (
  <I {...p}>
    <path d="M7 18h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.3 9.2 4.5 4.5 0 0 0 7 18z" />
  </I>
);
const UserIcon = (p: { size?: number }) => (
  <I {...p}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0 1 16 0" />
  </I>
);
const DeviceIcon = (p: { size?: number }) => (
  <I {...p}>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </I>
);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const initials = (name: string, email: string) => {
  const src = name.trim() || email.split("@")[0];
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
};
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));

function Avatar({ name, email, size = 28 }: { name: string; email: string; size?: number }) {
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden="true">
      {initials(name, email)}
    </span>
  );
}

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="acct-section">
      <div className="row" style={{ alignItems: "baseline" }}>
        <div className="section-label" style={{ marginTop: 0 }}>
          {title}
        </div>
        <div className="grow" />
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A labelled field; the label points at the first input inside it. */
function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="acct-field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <span className="help">{hint}</span>}
    </div>
  );
}

/** Rough guidance while typing a new password; the server has the final say. */
function PasswordMeter({ value }: { value: string }) {
  const n = value.length;
  const words = value.trim().split(/\s+/).filter(Boolean).length;
  const score = n === 0 ? 0 : n < 12 ? 1 : n < 16 && words < 3 ? 2 : n < 20 ? 3 : 4;
  const label = ["", "too short", "ok", "good", "strong"][score];
  return (
    <div className="pw-meter" aria-live="polite">
      <div className="bars">
        {[1, 2, 3, 4].map((i) => (
          <motion.span key={i} animate={{ opacity: score >= i ? 1 : 0.18, scaleX: score >= i ? 1 : 0.92 }} className={`s${score}`} />
        ))}
      </div>
      <span className="mono dim">{n ? `${n} chars · ${label}` : "12+ characters. A few unrelated words work well."}</span>
    </div>
  );
}

// ---------- sign in / sign up dialog ----------

const TITLES: Record<AuthMode, string> = { signin: "Sign in to Kerf", signup: "Create your Kerf account", forgot: "Reset your password", reset: "Choose a new password" };

export function AuthDialog() {
  const auth = useAccount((s) => s.auth);
  const info = useAccount((s) => s.info);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (!auth) return;
    setMode(auth.mode);
    if (auth.email) setEmail(auth.email);
    setPassword("");
    setError("");
    setSent(false);
  }, [auth]);

  const switchTo = (m: AuthMode) => {
    setMode(m);
    setError("");
    setSent(false);
    setPassword("");
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (mode === "signin") await signIn(email, password);
      else if (mode === "signup") await signUp(email, password, name);
      else if (mode === "forgot") {
        await requestReset(email);
        setSent(true);
      } else if (mode === "reset") await resetPassword(auth?.token ?? "", password);
      setPassword("");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };

  const signup = info?.server.signup ?? "open";
  return (
    <Modal open={!!auth} onClose={closeAuth} title={TITLES[mode]} icon={mode === "signin" || mode === "signup" ? <UserIcon size={16} /> : <Icon.Key size={16} />} width={440}>
      <div className="modal-body">
        <AnimatePresence mode="wait" initial={false}>
          <motion.form key={mode} onSubmit={submit} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.16 }} className="auth-form" noValidate>
            {mode === "signin" && <p className="muted">Your projects, their history and your Claude key follow you to any browser you sign in on.</p>}
            {mode === "signup" && signup === "closed" && <div className="notice warn">This Kerf server is not taking new sign-ups. Ask whoever runs it to create an account for you.</div>}
            {mode === "signup" && signup === "allowlist" && <p className="muted">This server takes sign-ups from invited email addresses.</p>}
            {mode === "forgot" && !info?.server.mail && <div className="notice warn">This server can't send email. Ask whoever runs it to reset your password.</div>}
            {mode === "forgot" && sent && (
              <div className="notice">
                <div className="t">Check your email</div>
                <div className="d">If there's an account for {email}, a reset link is on its way. It works for one hour.</div>
              </div>
            )}

            {mode === "signup" && signup !== "closed" && (
              <Field label="Name (optional)">
                {(id) => (
                  <input id={id} className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />
                )}
              </Field>
            )}
            {mode !== "reset" && !(mode === "signup" && signup === "closed") && !(mode === "forgot" && (sent || !info?.server.mail)) && (
              <Field label="Email">
                {(id) => (
                  <input id={id} className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus={!email} required maxLength={254} />
                )}
              </Field>
            )}
            {(mode === "signin" || mode === "reset" || (mode === "signup" && signup !== "closed")) && (
              <Field label={mode === "signin" ? "Password" : "New password"}>
                {(id) => (
                  <>
                    <div className="pw-wrap">
                      <input
                        id={id}
                        className="input"
                        type={show ? "text" : "password"}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        autoComplete={mode === "signin" ? "current-password" : "new-password"}
                        autoFocus={!!email || mode === "reset"}
                        required
                        maxLength={256}
                      />
                      <button type="button" className="icon-btn sm" onClick={() => setShow(!show)} aria-label={show ? "Hide password" : "Show password"}>
                        {show ? <Icon.EyeOff size={14} /> : <Icon.Eye size={14} />}
                      </button>
                    </div>
                    {mode !== "signin" && <PasswordMeter value={password} />}
                  </>
                )}
              </Field>
            )}

            {error && (
              <motion.div className="err-text" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} role="alert">
                {error}
              </motion.div>
            )}

            {!(mode === "signup" && signup === "closed") && !(mode === "forgot" && (sent || !info?.server.mail)) && (
              <button className="btn primary lg auth-submit" type="submit" disabled={busy}>
                {busy && <span className="spinner" />}
                {mode === "signin" ? "Sign in" : mode === "signup" ? "Create account" : mode === "forgot" ? "Send reset link" : "Set password and sign in"}
              </button>
            )}

            {mode === "signup" && signup !== "closed" && (
              <p className="help" style={{ marginTop: 10 }}>
                Creating an account means accepting the draft{" "}
                <a href="#" onClick={(e) => (e.preventDefault(), closeAuth(), go({ name: "legal", doc: "terms", back: "home" }))}>
                  Terms
                </a>{" "}
                and{" "}
                <a href="#" onClick={(e) => (e.preventDefault(), closeAuth(), go({ name: "legal", doc: "privacy", back: "home" }))}>
                  Privacy notice
                </a>
                . Your password is stored only as a salted hash.
              </p>
            )}

            <div className="auth-links">
              {mode === "signin" && (
                <>
                  <button type="button" className="link" onClick={() => switchTo("forgot")}>
                    Forgot password?
                  </button>
                  {signup !== "closed" && (
                    <button type="button" className="link" onClick={() => switchTo("signup")}>
                      Create an account
                    </button>
                  )}
                </>
              )}
              {mode !== "signin" && (
                <button type="button" className="link" onClick={() => switchTo("signin")}>
                  Back to sign in
                </button>
              )}
            </div>
          </motion.form>
        </AnimatePresence>
      </div>
    </Modal>
  );
}

// ---------- header button and indicators ----------

const SYNC_LABEL = { off: "not syncing", idle: "synced", syncing: "syncing…", offline: "offline", error: "sync problem" } as const;

function syncColor(state: keyof typeof SYNC_LABEL) {
  return state === "idle" ? "var(--pass)" : state === "syncing" ? "var(--accent-2)" : state === "error" ? "var(--fail)" : "var(--warn)";
}

/** The account entry point on the projects page. */
export function AccountButton() {
  const status = useAccount((s) => s.status);
  const user = useAccount((s) => s.info?.user);
  const sync = useSync((s) => s.state);
  if (status === "none" || status === "checking") return null;
  if (status === "signed-out")
    return (
      <button className="btn ghost" onClick={() => openAuth("signin")}>
        <UserIcon size={14} /> Sign in
      </button>
    );
  if (status === "unreachable")
    return (
      <button className="btn ghost" onClick={() => openSettings("account")} data-tip="Can't reach the Kerf server. Your work is saved here and syncs when it's back.">
        <span className="dot" style={{ background: "var(--warn)" }} /> offline
      </button>
    );
  return (
    <button className="acct-chip" onClick={() => openSettings("account")} aria-label="Account" data-tip={`${user?.email} · ${SYNC_LABEL[sync]}`}>
      <Avatar name={user?.name ?? ""} email={user?.email ?? ""} size={24} />
      <span className="acct-chip-name">{user?.name || user?.email}</span>
      <motion.span className="dot" animate={{ background: syncColor(sync), opacity: sync === "syncing" ? [1, 0.35, 1] : 1 }} transition={sync === "syncing" ? { repeat: Infinity, duration: 1 } : { duration: 0.3 }} />
    </button>
  );
}

/** Next to the save state in a project: is this project in the account, and is it up to date. */
export function SyncBadge() {
  const status = useAccount((s) => s.status);
  const id = useProject((s) => s.current?.id);
  const cloud = useSync((s) => (id ? s.cloud.includes(id) : false));
  const state = useSync((s) => s.state);
  useTick();
  const last = useSync((s) => s.lastSync);
  if (status !== "signed-in" && status !== "unreachable") return null;
  if (!cloud)
    return (
      <div className="save-state narrow-hide sync-badge" data-tip="This project is only in this browser. Add it to your account from its menu on the projects page.">
        <DeviceIcon size={12} /> this device
      </div>
    );
  const shown = status === "unreachable" ? "offline" : state;
  return (
    <div className="save-state narrow-hide sync-badge" data-tip={shown === "idle" && last ? `In your account · checked ${timeAgo(last)}` : shown === "error" ? useSync.getState().message : "In your account"}>
      <motion.span style={{ display: "inline-flex", color: syncColor(shown) }} animate={shown === "syncing" ? { y: [0, -1.5, 0] } : { y: 0 }} transition={shown === "syncing" ? { repeat: Infinity, duration: 0.9 } : undefined}>
        <CloudIcon size={13} />
      </motion.span>
      {SYNC_LABEL[shown]}
    </div>
  );
}

/** A cloud mark on project cards that are kept in the account. */
export function CloudTag({ id }: { id: string }) {
  const on = useSync((s) => s.cloud.includes(id));
  const signedIn = useAccount((s) => s.status === "signed-in" || s.status === "unreachable");
  if (!signedIn || !on) return null;
  return (
    <span className="cloud-tag" data-tip="In your account">
      <CloudIcon size={12} />
    </span>
  );
}

/** Project-card menu entries for moving a project in or out of the account. */
export function useCloudActions(id: string) {
  const signedIn = useAccount((s) => s.status === "signed-in");
  const on = useSync((s) => s.cloud.includes(id));
  if (!signedIn) return null;
  return on
    ? {
        inAccount: true,
        label: "Keep on this device only",
        run: async () => {
          if (await confirmDialog({ title: "Remove from your account?", body: "This browser keeps its copy. The account copy and its history are deleted, and other devices remove theirs.", confirm: "Remove from account", danger: true })) keepOnThisDevice([id]);
        },
      }
    : { inAccount: false, label: "Add to my account", run: () => uploadToAccount([id]) };
}

/** On the projects page: older local projects that are not in the account yet. */
export function UploadBanner() {
  const waiting = useSync((s) => s.waiting);
  const signedIn = useAccount((s) => s.status === "signed-in");
  return (
    <AnimatePresence>
      {signedIn && waiting > 0 && (
        <motion.div className="upload-banner" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
          <div className="inner">
            <CloudIcon size={16} />
            <div className="grow">
              <b>
                {waiting} project{waiting > 1 ? "s" : ""} in this browser {waiting > 1 ? "aren't" : "isn't"} in your account.
              </b>{" "}
              <span className="muted">Add {waiting > 1 ? "them" : "it"} to open on any device, or keep {waiting > 1 ? "them" : "it"} here only.</span>
            </div>
            <button className="btn sm" onClick={keepWaitingLocal}>
              Keep here
            </button>
            <button className="btn primary sm" onClick={() => uploadToAccount()}>
              Add to account
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- Claude key on the account ----------

/** The API key part of Settings → Claude when a Kerf server is in use. Returns null without a server, so the browser-only form shows. */
export function AccountKeySection({ browserForm }: { browserForm: ReactNode }) {
  const status = useAccount((s) => s.status);
  const claude = useAccount((s) => s.info?.claude);
  const browserKey = getApiKey();
  const [replacing, setReplacing] = useState(false);
  useEffect(() => setReplacing(false), [claude?.account?.hint]);

  if (status === "none" || status === "checking") return null;
  if (status === "signed-out" || status === "unreachable")
    return (
      <>
        {browserForm}
        {status === "signed-out" && (
          <div className="notice" style={{ marginTop: 12 }}>
            <div className="row">
              <CloudIcon size={15} />
              <div className="grow">
                <div className="t">Keep your key on your Kerf account instead</div>
                <div className="d">It's encrypted on the server, never sent back to a browser, and works on every device you sign in on.</div>
              </div>
              <button className="btn sm" onClick={() => openAuth("signin")}>
                Sign in
              </button>
            </div>
          </div>
        )}
      </>
    );

  const account = claude?.account;
  return (
    <div className="key-where">
      {account && !replacing ? (
        <div className="setting" style={{ alignItems: "center" }}>
          <span className="dot pass" />
          <div className="grow">
            <div className="t">
              On your Kerf account <span className="mono dim">sk-ant-…{account.hint}</span>
            </div>
            <div className="d">Encrypted on the server and never sent back to the browser. Chat goes through your Kerf server, which adds the key. Saved {timeAgo(account.savedAt)}.</div>
          </div>
          <button className="btn" onClick={() => setReplacing(true)}>
            Replace
          </button>
          <button
            className="btn danger"
            onClick={async () => {
              if (!(await confirmDialog({ title: "Remove the key from your account?", body: "Chat stops working on every device until you add a key again. Your designs are not affected.", confirm: "Remove key", danger: true }))) return;
              try {
                await api("DELETE", "/claude/key");
                await refreshAccount();
                toast({ kind: "success", title: "Key removed from your account" });
              } catch (e) {
                toast({ kind: "error", title: "Could not remove the key", detail: errText(e) });
              }
            }}
          >
            Remove
          </button>
        </div>
      ) : (
        <>
          {browserKey && !replacing && (
            <div className="setting" style={{ alignItems: "center" }}>
              <span className="dot warn" />
              <div className="grow">
                <div className="t">
                  In this browser <span className="mono dim">{keyHint()}</span>
                </div>
                <div className="d">Move it to your account so it is not kept in the browser and works on your other devices.</div>
              </div>
              <MoveKeyButton keyValue={browserKey} />
            </div>
          )}
          {claude?.shared && !account && (
            <div className="setting">
              <span className="dot pass" />
              <div className="grow">
                <div className="t">Shared key on this server</div>
                <div className="d">
                  Whoever runs this server lets your account use their key: {fmtTokens(claude.shared.usedToday)} of {fmtTokens(claude.shared.dailyTokens)} tokens used today. Add your own key to remove the limit.
                </div>
                <div className="quota">
                  <motion.span initial={{ width: 0 }} animate={{ width: `${Math.min(100, (claude.shared.usedToday / Math.max(1, claude.shared.dailyTokens)) * 100)}%` }} />
                </div>
              </div>
            </div>
          )}
          {(!browserKey || replacing) && <AccountKeyForm onDone={() => setReplacing(false)} />}
          {replacing && (
            <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => setReplacing(false)}>
              Keep the current key
            </button>
          )}
        </>
      )}
    </div>
  );
}

function MoveKeyButton({ keyValue }: { keyValue: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn primary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api("PUT", "/claude/key", { key: keyValue });
          await forgetApiKey();
          await refreshAccount();
          toast({ kind: "success", title: "Key moved to your account", detail: "This browser no longer keeps it." });
        } catch (e) {
          toast({ kind: "error", title: "Could not move the key", detail: errText(e) }, 9000);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="spinner" /> : <CloudIcon size={14} />} Move to account
    </button>
  );
}

function AccountKeyForm({ onDone }: { onDone: () => void }) {
  const [key, setKey] = useState("");
  const [state, setState] = useState({ busy: false, error: "" });
  const save = async () => {
    const problem = validateKeyFormat(key);
    if (problem) return setState({ busy: false, error: problem });
    setState({ busy: true, error: "" });
    try {
      await api("PUT", "/claude/key", { key: key.trim() });
      setKey("");
      await refreshAccount();
      setState({ busy: false, error: "" });
      toast({ kind: "success", title: "Claude connected", detail: "The key is on your account. Chat works on any device you sign in on." });
      onDone();
    } catch (e) {
      setState({ busy: false, error: errText(e) });
    }
  };
  return (
    <div>
      <label className="field-label" htmlFor="account-api-key">
        Claude API key
      </label>
      <div className="row">
        <input id="account-api-key" className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="sk-ant-api03-…" value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} />
        <button className="btn primary" disabled={!key.trim() || state.busy} onClick={() => void save()}>
          {state.busy ? <span className="spinner" /> : <CloudIcon size={14} />} {state.busy ? "Checking" : "Test & save to account"}
        </button>
      </div>
      {state.error && <div className="err-text">{state.error}</div>}
      <div className="help">
        Your Kerf server checks the key with the Claude API, then stores it encrypted. It is never sent back to any browser. Create a key in the{" "}
        <a href="https://platform.claude.com/" target="_blank" rel="noopener noreferrer">
          Claude Console
        </a>
        .
      </div>
    </div>
  );
}

// ---------- the Account settings tab ----------

export function AccountSettings() {
  const status = useAccount((s) => s.status);
  if (status === "checking")
    return (
      <div className="row dim">
        <span className="spinner" /> Checking for a Kerf server…
      </div>
    );
  if (status === "none") return <NoServer />;
  if (status === "unreachable")
    return (
      <div className="acct-empty">
        <CloudIcon size={30} />
        <div className="t">Can't reach your Kerf server</div>
        <div className="d">Everything you do is saved in this browser and will sync when the server is back.</div>
        <button className="btn" onClick={() => void refreshAccount()}>
          <Icon.Refresh size={14} /> Try again
        </button>
      </div>
    );
  if (status === "signed-out") return <SignedOut />;
  return <SignedIn />;
}

function NoServer() {
  return (
    <div className="acct-empty">
      <DeviceIcon size={30} />
      <div className="t">This copy of Kerf runs on its own</div>
      <div className="d">There is no Kerf server behind it, so there are no accounts: projects stay in this browser and your Claude key is used straight from here. When Kerf is served by a Kerf server, you can sign in here to sync projects between devices and keep your key on your account.</div>
    </div>
  );
}

function SignedOut() {
  const signup = useAccount((s) => s.info?.server.signup);
  return (
    <div className="acct-empty">
      <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 300, damping: 20 }} className="acct-hero-icon">
        <CloudIcon size={30} />
      </motion.div>
      <div className="t">Your designs on every device</div>
      <ul className="acct-benefits">
        <li>
          <Icon.Check size={13} /> Projects, version history and chats sync between browsers.
        </li>
        <li>
          <Icon.Check size={13} /> Your Claude key stays encrypted on the server, not in the browser.
        </li>
        <li>
          <Icon.Check size={13} /> Kerf still works offline and catches up when you reconnect.
        </li>
      </ul>
      <div className="row" style={{ justifyContent: "center" }}>
        {signup !== "closed" && (
          <button className="btn" onClick={() => openAuth("signup")}>
            Create account
          </button>
        )}
        <button className="btn primary" onClick={() => openAuth("signin")}>
          Sign in
        </button>
      </div>
    </div>
  );
}

function SignedIn() {
  const info = useAccount((s) => s.info)!;
  const user = info.user!;
  useTick();
  return (
    <>
      <div className="acct-head">
        <Avatar name={user.name} email={user.email} size={42} />
        <div className="grow">
          <NameEditor name={user.name} />
          <div className="muted mono" style={{ fontSize: 12 }}>
            {user.email}{" "}
            {user.emailVerified ? (
              <span className="chip pass" style={{ marginLeft: 6 }}>
                confirmed
              </span>
            ) : (
              <ResendVerification mail={info.server.mail} />
            )}
          </div>
        </div>
        <SignOutButton />
      </div>
      <SyncSection />
      <UsageSection />
      <SecuritySection />
      <DataSection />
    </>
  );
}

function NameEditor({ name }: { name: string }) {
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  const save = async () => {
    if (value.trim() === name) return;
    try {
      await api("PATCH", "/account", { name: value.trim() });
      await refreshAccount();
    } catch (e) {
      toast({ kind: "error", title: "Could not save your name", detail: errText(e) });
      setValue(name);
    }
  };
  return <input className="name-edit" value={value} placeholder="Add your name" aria-label="Your name" maxLength={80} onChange={(e) => setValue(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

function ResendVerification({ mail }: { mail: boolean }) {
  const [sent, setSent] = useState(false);
  if (!mail) return <span className="chip" style={{ marginLeft: 6 }}>not confirmed</span>;
  return (
    <button
      className="chip warn"
      style={{ marginLeft: 6, cursor: "pointer" }}
      disabled={sent}
      onClick={async () => {
        try {
          await api("POST", "/auth/resend-verification");
          setSent(true);
          toast({ kind: "success", title: "Confirmation email sent" });
        } catch (e) {
          toast({ kind: "error", title: "Could not send the email", detail: errText(e) });
        }
      }}
    >
      {sent ? "email sent" : "confirm email"}
    </button>
  );
}

function SignOutButton() {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (removeLocal: boolean) => {
    setBusy(true);
    try {
      await signOut(removeLocal);
      toast({ kind: "success", title: "Signed out", detail: removeLocal ? "Your account's projects were removed from this browser. They are safe in your account." : "Your projects stay in this browser." });
    } catch (e) {
      toast({ kind: "error", title: "Could not sign out", detail: errText(e) });
    } finally {
      setBusy(false);
      setAsking(false);
    }
  };
  return (
    <div style={{ position: "relative" }}>
      <button className="btn" onClick={() => setAsking(!asking)}>
        Sign out
      </button>
      <AnimatePresence>
        {asking && (
          <motion.div className="signout-pop" initial={{ opacity: 0, y: -4, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -4 }}>
            <div className="t">Sign out of this browser?</div>
            <div className="d">Your account keeps everything. Choose whether this browser keeps a copy.</div>
            <button className="btn primary" disabled={busy} onClick={() => void run(true)}>
              {busy && <span className="spinner" />} Sign out and remove copies
            </button>
            <button className="btn" disabled={busy} onClick={() => void run(false)}>
              Sign out, keep copies here
            </button>
            <div className="help">Remove copies on a shared or public computer.</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SyncSection() {
  const s = useSync();
  const projects = useProject((p) => p.projects);
  const local = projects.filter((p) => !s.cloud.includes(p.id));
  return (
    <Section
      title="Sync"
      aside={
        <button className="btn ghost sm" onClick={() => void syncNow()} disabled={s.state === "syncing"}>
          <Icon.Refresh size={13} /> Sync now
        </button>
      }
    >
      <div className="sync-flow" aria-hidden="true">
        <span className="node">
          <DeviceIcon size={16} />
          <span>this browser</span>
        </span>
        <span className={`wire ${s.state}`}>
          <motion.i animate={s.state === "syncing" ? { x: ["-10%", "110%"] } : { x: "50%" }} transition={s.state === "syncing" ? { repeat: Infinity, duration: 0.9, ease: "easeInOut" } : { duration: 0.3 }} />
        </span>
        <span className="node">
          <CloudIcon size={16} />
          <span>your account</span>
        </span>
      </div>
      <div className="setting">
        <motion.span className="dot" animate={{ background: syncColor(s.state) }} />
        <div className="grow">
          <div className="t">{s.state === "idle" ? "Up to date" : s.state === "syncing" ? "Syncing…" : s.state === "offline" ? "Offline" : s.state === "error" ? "Sync stopped" : "Not syncing"}</div>
          <div className="d">
            {s.state === "error"
              ? s.message
              : s.state === "offline"
                ? "Changes are saved here and will be sent when the server is reachable."
                : `${s.cloud.length} project${s.cloud.length === 1 ? "" : "s"} in your account${s.lastSync ? `, checked ${timeAgo(s.lastSync)}` : ""}. ${local.length ? `${local.length} only in this browser.` : ""}`}
          </div>
        </div>
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Save new projects to my account</div>
          <div className="d">New projects sync automatically. Turn off to decide project by project from its menu on the projects page.</div>
        </div>
        <Toggle on={s.autoUpload} onChange={setAutoUpload} label="Save new projects to my account" />
      </div>
      {s.waiting > 0 && (
        <div className="setting">
          <div className="grow">
            <div className="t">
              {s.waiting} older project{s.waiting > 1 ? "s" : ""} not in your account
            </div>
            <div className="d">They were in this browser before you signed in.</div>
          </div>
          <button className="btn sm" onClick={keepWaitingLocal}>
            Keep here
          </button>
          <button className="btn primary sm" onClick={() => uploadToAccount()}>
            Add to account
          </button>
        </div>
      )}
    </Section>
  );
}

interface UsageRow {
  day: string;
  source: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

function UsageSection() {
  const source = useAccount((s) => s.info?.claude?.source);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  useEffect(() => {
    void api<{ usage: UsageRow[] }>("GET", "/account/usage").then(
      (r) => setRows(r.usage),
      () => setRows([]),
    );
  }, []);
  const days = useMemo(() => {
    const out: { day: string; tokens: number; requests: number }[] = [];
    for (let i = 29; i >= 0; i--) out.push({ day: new Date(Date.now() - i * 864e5).toISOString().slice(0, 10), tokens: 0, requests: 0 });
    for (const r of rows ?? []) {
      const d = out.find((x) => x.day === r.day);
      if (d) {
        d.tokens += r.input_tokens + r.output_tokens + r.cache_write_tokens + r.cache_read_tokens;
        d.requests += r.requests;
      }
    }
    return out;
  }, [rows]);
  const max = Math.max(1, ...days.map((d) => d.tokens));
  const total = rows?.reduce((a, r) => ({ requests: a.requests + r.requests, input: a.input + r.input_tokens + r.cache_write_tokens, output: a.output + r.output_tokens, cached: a.cached + r.cache_read_tokens }), { requests: 0, input: 0, output: 0, cached: 0 });
  return (
    <Section title="Claude through your account · last 30 days" aside={<button className="btn ghost sm" onClick={() => openSettings("ai")}>Key settings</button>}>
      {!source && <div className="help" style={{ marginTop: 0, marginBottom: 8 }}>No key on your account yet. Add one under Claude to chat through your Kerf server.</div>}
      <div className="usage-chart" role="img" aria-label={`Tokens per day for the last 30 days, ${total ? fmtTokens(total.input + total.output + total.cached) : 0} in total`}>
        {days.map((d, i) => (
          <motion.span key={d.day} title={`${d.day}: ${fmtTokens(d.tokens)} tokens, ${d.requests} requests`} initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: i * 0.012, type: "spring", stiffness: 260, damping: 24 }} style={{ height: `${Math.max(d.tokens ? 6 : 2, (d.tokens / max) * 100)}%`, opacity: d.tokens ? 1 : 0.25 }} />
        ))}
      </div>
      {total && (
        <div className="usage-totals mono">
          <span>
            <b>{total.requests}</b> requests
          </span>
          <span>
            <b>{fmtTokens(total.input)}</b> in
          </span>
          <span>
            <b>{fmtTokens(total.output)}</b> out
          </span>
          <span>
            <b>{fmtTokens(total.cached)}</b> cached
          </span>
        </div>
      )}
    </Section>
  );
}

interface SessionRow {
  id: string;
  current: boolean;
  device: string;
  createdAt: number;
  lastSeenAt: number;
  ip: string;
}

const EVENTS: Record<string, string> = {
  signed_up: "Account created",
  signed_in: "Signed in",
  sign_in_failed: "Wrong password entered",
  password_changed: "Password changed",
  password_reset: "Password reset by email",
  reset_requested: "Password reset requested",
  email_confirmed: "Email confirmed",
  claude_key_saved: "Claude key saved",
  claude_key_removed: "Claude key removed",
  signed_out_device: "Signed out a device",
  signed_out_other_devices: "Signed out all other devices",
};

function SecuritySection() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [activity, setActivity] = useState<{ ts: number; event: string; ip: string; detail: string }[]>([]);
  const [showAll, setShowAll] = useState(false);
  const load = () => {
    void api<{ sessions: SessionRow[] }>("GET", "/account/sessions").then((r) => setSessions(r.sessions), () => setSessions([]));
    void api<{ activity: typeof activity }>("GET", "/account/activity").then((r) => setActivity(r.activity), () => undefined);
  };
  useEffect(load, []);
  const revoke = async (body: { id?: string; others?: boolean }) => {
    try {
      await api("POST", "/account/sessions/revoke", body);
      load();
    } catch (e) {
      toast({ kind: "error", title: "Could not sign that device out", detail: errText(e) });
    }
  };
  return (
    <>
      <Section title="Signed-in devices" aside={sessions && sessions.length > 1 ? <button className="btn ghost sm" onClick={() => void revoke({ others: true })}>Sign out all others</button> : undefined}>
        {!sessions ? (
          <div className="row dim">
            <span className="spinner" />
          </div>
        ) : (
          <AnimatePresence initial={false}>
            {sessions.map((s) => (
              <motion.div key={s.id} className="setting" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }}>
                <DeviceIcon size={16} />
                <div className="grow">
                  <div className="t">
                    {s.device} {s.current && <span className="chip accent">this browser</span>}
                  </div>
                  <div className="d mono">
                    active {timeAgo(s.lastSeenAt)} · since {new Date(s.createdAt).toLocaleDateString()} · {s.ip}
                  </div>
                </div>
                {!s.current && (
                  <button className="btn sm" onClick={() => void revoke({ id: s.id })}>
                    Sign out
                  </button>
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </Section>
      <PasswordSection onChanged={load} />
      <Section title="Recent activity">
        <div className="activity">
          {(showAll ? activity : activity.slice(0, 6)).map((a, i) => (
            <div key={i} className={`act ${a.event === "sign_in_failed" ? "warn" : ""}`}>
              <span className="mono dim">{new Date(a.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
              <span>{EVENTS[a.event] ?? a.event}</span>
              <span className="mono dim">{a.ip}</span>
            </div>
          ))}
          {activity.length > 6 && (
            <button className="btn ghost sm" onClick={() => setShowAll(!showAll)}>
              {showAll ? "Show less" : `Show ${activity.length - 6} more`}
            </button>
          )}
        </div>
      </Section>
    </>
  );
}

function PasswordSection({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [state, setState] = useState({ busy: false, error: "" });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setState({ busy: true, error: "" });
    try {
      await api("POST", "/account/password", { current, next });
      setCurrent("");
      setNext("");
      setOpen(false);
      setState({ busy: false, error: "" });
      toast({ kind: "success", title: "Password changed", detail: "Other devices were signed out." });
      onChanged();
    } catch (err) {
      setState({ busy: false, error: errText(err) });
    }
  };
  return (
    <Section title="Password">
      {!open ? (
        <div className="setting">
          <div className="grow">
            <div className="t">Change your password</div>
            <div className="d">Other devices are signed out when you do.</div>
          </div>
          <button className="btn" onClick={() => setOpen(true)}>
            Change
          </button>
        </div>
      ) : (
        <motion.form onSubmit={save} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} className="pw-form">
          <Field label="Current password">
            {(id) => (
              <input id={id} className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus />
            )}
          </Field>
          <Field label="New password">
            {(id) => (
              <>
                <input id={id} className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
                <PasswordMeter value={next} />
              </>
            )}
          </Field>
          {state.error && <div className="err-text">{state.error}</div>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button type="button" className="btn ghost" onClick={() => setOpen(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={state.busy || !current || !next}>
              {state.busy && <span className="spinner" />} Change password
            </button>
          </div>
        </motion.form>
      )}
    </Section>
  );
}

function DataSection() {
  const [deleting, setDeleting] = useState(false);
  const [password, setPassword] = useState("");
  const [state, setState] = useState({ busy: false, error: "" });
  const del = async () => {
    setState({ busy: true, error: "" });
    try {
      await api("POST", "/account/delete", { password });
      closeSettings();
      await signOut(false).catch(() => undefined);
      await refreshAccount();
      toast({ kind: "success", title: "Account deleted", detail: "Everything on the server is gone. Copies in this browser stay until you delete them." }, 9000);
    } catch (e) {
      setState({ busy: false, error: errText(e) });
    }
  };
  return (
    <Section title="Your data">
      <div className="setting">
        <div className="grow">
          <div className="t">Download everything</div>
          <div className="d">One .kerfbackup file with every project in your account and its history. Import it into any copy of Kerf.</div>
        </div>
        <a className="btn" href="/api/projects/export" download>
          <Icon.Download size={14} /> Download
        </a>
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Delete account</div>
          <div className="d">Deletes your account, every project, version and chat in it, and your saved Claude key from the server. This cannot be undone.</div>
        </div>
        {!deleting && (
          <button className="btn danger" onClick={() => setDeleting(true)}>
            <Icon.Trash size={14} /> Delete
          </button>
        )}
      </div>
      {deleting && (
        <motion.div className="danger-box" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
          <Field label="Type your password to confirm">
            {(id) => (
              <input id={id} className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            )}
          </Field>
          {state.error && <div className="err-text">{state.error}</div>}
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn ghost" onClick={() => (setDeleting(false), setPassword(""))}>
              Cancel
            </button>
            <button className="btn danger" disabled={!password || state.busy} onClick={() => void del()}>
              {state.busy && <span className="spinner" />} Delete my account
            </button>
          </div>
        </motion.div>
      )}
    </Section>
  );
}

/** Used by "Clear all data": sign out and drop this browser's account state first. */
export async function signOutForClear() {
  if (useAccount.getState().status === "signed-in") await signOut(true).catch(() => undefined);
  try {
    localStorage.removeItem("kerf.sync.v1");
    localStorage.removeItem("kerf.account.v1");
  } catch {
    /* ignore */
  }
}

