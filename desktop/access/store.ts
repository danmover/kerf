// The accounts that have signed in on this computer, in Kerf's folder
// (access/accounts.json): each one's latest ticket, a hash for checking its
// password offline, and which Chromium storage partition holds its projects.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LocalAccount {
  user: string;
  role: string;
  /** the latest ticket from the server */
  ticket: string;
  /** for checking the password when the server can't be reached */
  salt: string;
  verifier: string;
  /**
   * The storage partition with this account's projects, chats and settings.
   * "" is the app's default storage: the first account on a computer gets it,
   * along with whatever Kerf had saved there before sign-in existed.
   */
  partition: string;
  added: number;
  lastSignIn: number;
}

export interface AccessFile {
  v: 1;
  accounts: LocalAccount[];
  /** the account that stays signed in on this computer, if any */
  stay: string | null;
  /** the latest time Kerf has seen, so turning the clock back doesn't stretch a ticket */
  latest: number;
}

const empty = (): AccessFile => ({ v: 1, accounts: [], stay: null, latest: 0 });

export class AccessStore {
  readonly dir: string;
  private file: string;
  data: AccessFile;

  constructor(userData: string) {
    this.dir = join(userData, "access");
    this.file = join(this.dir, "accounts.json");
    this.data = this.read();
  }

  private read(): AccessFile {
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8")) as AccessFile;
      if (v?.v !== 1 || !Array.isArray(v.accounts)) return empty();
      return { v: 1, accounts: v.accounts.filter((a) => a && typeof a.user === "string" && typeof a.partition === "string"), stay: typeof v.stay === "string" ? v.stay : null, latest: Number(v.latest) || 0 };
    } catch {
      return empty();
    }
  }

  save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.file);
  }

  get(user: string) {
    return this.data.accounts.find((a) => a.user === user) ?? null;
  }

  /** Now, or the latest time seen if the clock has gone back. */
  now(clock = Date.now()) {
    if (clock > this.data.latest) this.data.latest = clock;
    return this.data.latest;
  }

  /** Keeps a sign-in: a new account gets the default storage if nobody has it yet, else its own. */
  put(a: Omit<LocalAccount, "partition" | "added">, now: number): LocalAccount {
    const old = this.get(a.user);
    if (old) {
      Object.assign(old, a);
      return old;
    }
    const taken = this.data.accounts.some((x) => x.partition === "");
    const added: LocalAccount = { ...a, partition: taken ? `persist:kerf-user-${a.user}` : "", added: now };
    this.data.accounts.push(added);
    return added;
  }

  /** Forget an account's ticket, so it has to sign in with the server again (its projects stay). */
  dropTicket(user: string) {
    const a = this.get(user);
    if (a) a.ticket = "";
    if (this.data.stay === user) this.data.stay = null;
  }
}
