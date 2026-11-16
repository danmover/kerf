// Settings → Account in the desktop app: who is signed in on this computer,
// and for the owner (signed in on the PC that holds the owner key), the
// people who may use Kerf: add them, give them a new password, move their
// account to a new computer, switch them off. desktop/access/ does the work.

import { useCallback, useEffect, useState } from "react";
import { confirmDialog, toast } from "../app/ui";
import { desktop, type AccessInfo, type AccessOwnerOp, type AccessOwnerResult, type AccessUser } from "../app/desktop";
import { Toggle, timeAgo } from "./common";
import { Icon } from "./icons";

const day = (ts: number) => new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
/** a computer code, as Kerf shows it at the foot of the sign-in window */
const code = (c: string) => c.match(/.{1,4}/g)?.join("-") ?? c;

/** The desktop sign-in, or `children` (the server account) when nobody signed in, as in the smoke test. */
export function DesktopAccess({ children }: { children: React.ReactNode }) {
  const access = desktop()?.access;
  const [info, setInfo] = useState<AccessInfo | null | undefined>(undefined);
  useEffect(() => {
    void access?.info().then(setInfo, () => setInfo(null));
  }, [access]);
  if (!access || info === null) return <>{children}</>;
  if (info === undefined)
    return (
      <div className="row dim">
        <span className="spinner" /> Checking who's signed in…
      </div>
    );
  const signOut = async () => {
    const ok = await confirmDialog({ title: "Sign out of Kerf?", body: "Kerf closes and shows the sign-in window. Your projects are saved and stay with your account on this computer.", confirm: "Sign out" });
    if (ok) await access.signOut();
  };
  return (
    <>
      <div className="section-label" style={{ marginTop: 0 }}>
        Signed in
      </div>
      <div className="setting" style={{ alignItems: "center" }}>
        <span className="da-avatar" aria-hidden="true">
          {info.user.slice(0, 1).toUpperCase()}
        </span>
        <div className="grow">
          <div className="t">
            {info.user} {info.role === "owner" && <span className="chip accent">owner</span>}
          </div>
          <div className="d">
            This account is locked to this computer, <span className="mono">{info.computer}</span>. Its projects, chats and settings are kept apart from {info.others ? "the other accounts" : "any other account"} on this computer.
          </div>
        </div>
        <button className="btn" onClick={() => void signOut()}>
          <Icon.Unlock size={14} /> Sign out
        </button>
      </div>
      {info.offline && (
        <div className="setting">
          <span className="dot warn" style={{ marginTop: 6 }} />
          <div className="grow">
            <div className="t">Started offline</div>
            <div className="d">Kerf couldn't reach its sign-in server, so it started on your saved sign-in, which lasts until {day(info.until)}. Connect to the internet before then.</div>
          </div>
        </div>
      )}
      <div className="setting">
        <div className="grow">
          <div className="t">Stay signed in</div>
          <div className="d">Open Kerf straight away on this computer, without the sign-in window. Kerf still checks with the sign-in server that your account is allowed here.</div>
        </div>
        <Toggle on={info.stay} label="Stay signed in" onChange={(on) => void access.setStay(on).then((i) => i && setInfo(i))} />
      </div>
      {info.owner && <People me={info.user} />}
    </>
  );
}

/** What to send a person so they can sign in. */
function message(user: string, password: string) {
  return `Here's your sign-in for Kerf.\n\nUsername: ${user}\nPassword: ${password}\n\nInstall Kerf and sign in on the computer you'll use it on. The account locks to the first computer it signs in on.`;
}

function People({ me }: { me: string }) {
  const access = desktop()!.access!;
  const [users, setUsers] = useState<AccessUser[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [made, setMade] = useState<{ user: string; password: string; fresh: boolean } | null>(null);

  const run = useCallback(
    async (op: AccessOwnerOp, label: string): Promise<AccessOwnerResult> => {
      setBusy(label);
      try {
        const r = await access.owner(op);
        if (!r.ok) setError(r.message);
        else {
          setError("");
          if (r.users) setUsers(r.users);
          else if (r.user) setUsers((list) => (list ? (list.some((u) => u.user === r.user!.user) ? list.map((u) => (u.user === r.user!.user ? r.user! : u)) : [...list, r.user!]) : [r.user!]));
          else if (op.op === "delete") setUsers((list) => list?.filter((u) => u.user !== op.user) ?? null);
        }
        return r;
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        setError(message);
        return { ok: false, message };
      } finally {
        setBusy("");
      }
    },
    [access],
  );

  useEffect(() => {
    void run({ op: "list" }, "list");
  }, [run]);

  return (
    <>
      <div className="section-label row" style={{ justifyContent: "space-between" }}>
        <span>People who can use Kerf</span>
        <button className="btn ghost sm" onClick={() => void run({ op: "list" }, "list")} disabled={!!busy} aria-label="Refresh the list">
          <Icon.Refresh size={13} />
        </button>
      </div>
      <div className="d" style={{ color: "var(--text-3)", fontSize: 12.5, marginBottom: 10 }}>
        Each account locks to the first computer it signs in on. If someone gets a new computer, move their account and it locks to the next one they sign in on. Changes reach a running Kerf within a few hours, and at its next start.
      </div>
      <AddPerson
        busy={busy === "add"}
        onAdd={async (user, password, note) => {
          const r = await run({ op: "create", user, password: password || undefined, note }, "add");
          if (r.ok && r.password) setMade({ user: user.toLowerCase(), password: r.password, fresh: true });
          return r.ok;
        }}
      />
      {made && <Made {...made} onClose={() => setMade(null)} />}
      {error && (
        <div className="da-error" role="alert">
          <Icon.Alert size={13} /> {error}
        </div>
      )}
      {users === null && !error && (
        <div className="row dim" style={{ padding: "10px 0" }}>
          <span className="spinner" /> Loading accounts…
        </div>
      )}
      <div className="da-people">
        {users?.map((u) => (
          <Person
            key={u.user}
            u={u}
            me={u.user === me}
            busy={busy.startsWith(u.user + ":")}
            run={(op, what) => run(op, `${u.user}:${what}`)}
            onPassword={(password) => setMade({ user: u.user, password, fresh: false })}
          />
        ))}
      </div>
    </>
  );
}

function AddPerson({ busy, onAdd }: { busy: boolean; onAdd: (user: string, password: string, note: string) => Promise<boolean> }) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const ok = /^[a-z0-9][a-z0-9._-]{1,31}$/.test(user.trim().toLowerCase());
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ok || busy) return;
    if (await onAdd(user.trim(), password, note.trim())) {
      setUser("");
      setPassword("");
      setNote("");
    }
  };
  return (
    <form className="da-add" onSubmit={(e) => void submit(e)}>
      <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder="username" aria-label="Username" autoCapitalize="none" spellCheck={false} maxLength={32} />
      <input className="input" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="password, or blank" aria-label="Password, or leave blank for Kerf to make one" maxLength={200} />
      <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="who it's for (optional)" aria-label="Who it's for" maxLength={200} />
      <button className="btn primary" type="submit" disabled={!ok || busy}>
        {busy ? <span className="spinner" /> : <Icon.Plus size={14} />} Add
      </button>
    </form>
  );
}

function Made({ user, password, fresh, onClose }: { user: string; password: string; fresh: boolean; onClose: () => void }) {
  const text = message(user, password);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ kind: "success", title: "Copied", detail: `Send it to ${user} in a private message.` });
    } catch {
      toast({ kind: "warn", title: "Couldn't copy", detail: "Select the text and copy it instead." });
    }
  };
  return (
    <div className="da-made">
      <div className="t">
        <Icon.Check size={14} /> {fresh ? `${user} can now use Kerf` : `New password for ${user}`}
      </div>
      <div className="d">Kerf doesn't keep passwords, so send this now. {fresh ? "" : "The old password stops working straight away."}</div>
      <pre className="mono">{text}</pre>
      <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
        <button className="btn" onClick={onClose}>
          Done
        </button>
        <button className="btn primary" onClick={() => void copy()}>
          <Icon.Copy size={14} /> Copy message
        </button>
      </div>
    </div>
  );
}

function Person({ u, me, busy, run, onPassword }: { u: AccessUser; me: boolean; busy: boolean; run: (op: AccessOwnerOp, what: string) => Promise<AccessOwnerResult>; onPassword: (password: string) => void }) {
  const where = u.computers.length
    ? u.computers.map((c) => `${code(c.c)} since ${day(c.at)}, last signed in ${timeAgo(c.seen)}`).join("; ")
    : "Not signed in yet: it locks to the first computer it signs in on.";
  const move = async () => {
    const ok = await confirmDialog({
      title: `Move ${u.user} to a new computer?`,
      body: `Kerf on ${u.computers.length === 1 ? "their current computer" : "their computers"} stops letting ${u.user} in within a few hours (at once if it restarts), and the account locks to the next computer it signs in on. Their projects stay on the old computer.`,
      confirm: "Move",
    });
    if (ok) await run({ op: "reset", user: u.user }, "reset");
  };
  const newPassword = async () => {
    const ok = await confirmDialog({ title: `Make a new password for ${u.user}?`, body: "Kerf makes one for you to send them. Their old password stops working straight away; a Kerf that is already open stays signed in.", confirm: "Make password" });
    if (!ok) return;
    const r = await run({ op: "password", user: u.user }, "password");
    if (r.ok && r.password) onPassword(r.password);
  };
  const block = async () => {
    if (!u.blocked) {
      const ok = await confirmDialog({ title: `Switch ${u.user} off?`, body: `${u.user} can't sign in any more, and a Kerf they have open signs them out within a few hours. You can switch them back on later.`, confirm: "Switch off", danger: true });
      if (!ok) return;
    }
    await run({ op: "block", user: u.user, blocked: !u.blocked }, "block");
  };
  const remove = async () => {
    const ok = await confirmDialog({ title: `Remove ${u.user}?`, body: `The account is deleted from the sign-in server. ${u.user} can't sign in again unless you add them back. Projects on their computer aren't touched.`, confirm: "Remove", danger: true });
    if (ok) await run({ op: "delete", user: u.user }, "delete");
  };
  return (
    <div className={`da-person ${u.blocked ? "off" : ""}`}>
      <span className="da-avatar sm" aria-hidden="true">
        {u.user.slice(0, 1).toUpperCase()}
      </span>
      <div className="grow">
        <div className="t">
          {u.user}
          {u.role === "owner" && <span className="chip accent">owner</span>}
          {me && <span className="chip">you</span>}
          {u.blocked && <span className="chip fail">switched off</span>}
          {u.note && <span className="da-note">{u.note}</span>}
        </div>
        <div className="d">{where}</div>
      </div>
      <div className="da-actions">
        {busy && <span className="spinner" />}
        <select
          className="input sm"
          value={u.maxComputers}
          disabled={busy}
          onChange={(e) => void run({ op: "limit", user: u.user, maxComputers: Number(e.target.value) }, "limit")}
          aria-label={`Computers ${u.user} may use`}
          data-tip="How many computers this account may be on"
        >
          {[1, 2, 3].map((n) => (
            <option key={n} value={n}>
              {n} computer{n === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        {u.computers.length > 0 && (
          <button className="btn sm" disabled={busy} onClick={() => void move()} data-tip="Unlock it from its computer, so it locks to the next one it signs in on">
            Move
          </button>
        )}
        <button className="btn sm" disabled={busy} onClick={() => void newPassword()}>
          <Icon.Key size={13} /> Password
        </button>
        {!me && (
          <button className={`btn sm ${u.blocked ? "" : "danger"}`} disabled={busy} onClick={() => void block()}>
            {u.blocked ? "Switch on" : "Switch off"}
          </button>
        )}
        {!me && (
          <button className="btn ghost sm" disabled={busy} onClick={() => void remove()} aria-label={`Remove ${u.user}`}>
            <Icon.Trash size={13} />
          </button>
        )}
      </div>
    </div>
  );
}
