// Kerf accounts, when the app is served by a Kerf server. Without a server
// (a static host, or `npm run dev` on its own) this stays "none" and Kerf works
// exactly as before: everything in this browser, the key in this browser.

import { create } from "zustand";
import { api, ApiError, probeSession, type SessionInfo } from "./api";
import { TERMS_VERSION } from "../app/settings";
import { toast } from "../app/ui";

export type AccountStatus = "checking" | "none" | "unreachable" | "signed-out" | "signed-in";
export type AuthMode = "signin" | "signup" | "forgot" | "reset";

interface AccountState {
  status: AccountStatus;
  info: SessionInfo | null;
  /** the sign-in dialog, when open */
  auth: { mode: AuthMode; token?: string; email?: string } | null;
}

export const useAccount = create<AccountState>(() => ({ status: "checking", info: null, auth: null }));
const set = useAccount.setState;
const get = useAccount.getState;

// remembered between visits so an offline start knows a server and an account exist
const MEMO = "kerf.account.v1";
interface Memo {
  server: boolean;
  userId?: string;
  email?: string;
}
function readMemo(): Memo {
  try {
    const m = JSON.parse(localStorage.getItem(MEMO) ?? "{}") as Partial<Memo>;
    return { server: m.server === true, userId: typeof m.userId === "string" ? m.userId : undefined, email: typeof m.email === "string" ? m.email : undefined };
  } catch {
    return { server: false };
  }
}
function writeMemo(m: Memo) {
  try {
    localStorage.setItem(MEMO, JSON.stringify(m));
  } catch {
    /* storage blocked */
  }
}

/** The signed-in user's id, or the last one seen when the server can't be reached right now. */
export function accountUserId(): string | null {
  const s = get();
  if (s.status === "signed-in") return s.info?.user?.id ?? null;
  if (s.status === "unreachable") return readMemo().userId ?? null;
  return null;
}

export const serverAvailable = () => {
  const s = get().status;
  return s === "signed-in" || s === "signed-out";
};

/** Whether chat should go through the server, using the key on the account or a shared one. */
export const claudeViaAccount = () => get().status === "signed-in" && !!get().info?.claude?.source;

function apply(info: SessionInfo) {
  set({ info, status: info.user ? "signed-in" : "signed-out" });
  writeMemo(info.user ? { server: true, userId: info.user.id, email: info.user.email } : { server: true });
}

export async function refreshAccount(): Promise<void> {
  const r = await probeSession();
  if (r.kind === "server") apply(r.info);
  else if (r.kind === "none") {
    set({ status: "none", info: null });
    writeMemo({ server: false });
  } else set({ status: readMemo().server ? "unreachable" : "none" });
}

/** At start-up: find the server, then act on a link opened from an email (#verify=… or #reset=…). */
export async function initAccount() {
  await refreshAccount();
  const m = /^#(verify|reset)=([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
  if (!m) return;
  // the token never stays in the address bar or history
  history.replaceState(null, "", location.pathname + location.search);
  if (!serverAvailable()) return;
  if (m[1] === "reset") {
    set({ auth: { mode: "reset", token: m[2] } });
    return;
  }
  try {
    await api("POST", "/auth/verify", { token: m[2] });
    toast({ kind: "success", title: "Email confirmed", detail: "Thanks. Password resets will go to this address." });
    await refreshAccount();
  } catch (e) {
    toast({ kind: "error", title: "Could not confirm your email", detail: e instanceof Error ? e.message : String(e) }, 9000);
  }
}

// a few listeners that react to sign-in and sign-out (sync, the chat); registered at start-up
type Hook = { signedIn?: (userId: string) => void | Promise<void>; beforeSignOut?: (removeLocal: boolean) => Promise<void> };
const hooks: Hook[] = [];
export const onAccount = (h: Hook) => hooks.push(h);

async function afterSignIn() {
  await refreshAccount();
  const id = get().info?.user?.id;
  if (id) for (const h of hooks) await h.signedIn?.(id);
  set({ auth: null });
}

export async function signIn(email: string, password: string) {
  await api("POST", "/auth/login", { email, password });
  await afterSignIn();
}

export async function signUp(email: string, password: string, name: string) {
  await api("POST", "/auth/signup", { email, password, name, termsVersion: TERMS_VERSION });
  await afterSignIn();
  toast({ kind: "success", title: "Account created", detail: get().info?.server.mail ? "We sent you an email to confirm your address." : "Your projects and Claude key can now follow you to any device." });
}

export async function resetPassword(token: string, password: string) {
  await api("POST", "/auth/reset", { token, password });
  await afterSignIn();
  toast({ kind: "success", title: "Password changed", detail: "You're signed in. Other devices were signed out." });
}

export async function requestReset(email: string) {
  await api("POST", "/auth/request-reset", { email });
}

/** Signs out. With removeLocal, this browser's copies of the account's projects go too (they stay in the account). */
export async function signOut(removeLocal: boolean) {
  for (const h of hooks) await h.beforeSignOut?.(removeLocal);
  try {
    await api("POST", "/auth/logout");
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 0)) throw e;
  }
  set({ status: "signed-out", info: get().info ? { ...get().info!, user: null, claude: null } : null });
  writeMemo({ server: true });
}

export const openAuth = (mode: AuthMode = "signin", email?: string) => set({ auth: { mode, email } });
export const closeAuth = () => set({ auth: null });

/** A 401 from the server means the session ended (expired, or signed out elsewhere). */
export function sessionEnded() {
  if (get().status !== "signed-in") return;
  void refreshAccount().then(() => {
    if (get().status === "signed-out") toast({ kind: "warn", title: "You were signed out", detail: "Sign in again to keep syncing. Your work is safe in this browser.", action: { label: "Sign in", run: () => openAuth("signin", readMemo().email) } }, 12000);
  });
}
