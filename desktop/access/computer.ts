// This computer's code: a hash of the ID the operating system gives the
// machine (Windows' MachineGuid, a Mac's hardware UUID, Linux's machine-id),
// so the sign-in server can lock an account to one computer without learning
// anything else about it. Reinstalling Windows changes it; the owner can then
// move the account in Settings → Account.

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 80 bits as 16 Crockford base32 characters. */
function base32(bytes: Uint8Array): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The code for a machine ID: what the server stores and the person can read out. */
export function codeFor(machineId: string): string {
  return base32(createHash("sha256").update("kerf-computer-v1\n" + machineId.trim().toLowerCase()).digest().subarray(0, 10));
}

/** XXXX-XXXX-XXXX-XXXX */
export const formatCode = (code: string) => code.match(/.{1,4}/g)?.join("-") ?? code;

/** A code as typed or pasted (any case, dashes, O for 0, I or L for 1), or null. */
export function normalizeCode(input: string): string | null {
  const c = input.toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(c) ? c : null;
}

function readOs(platform: NodeJS.Platform): string | null {
  try {
    if (platform === "win32") {
      const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
      const out = execFileSync(reg, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid", "/reg:64"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
      return /MachineGuid\s+REG_SZ\s+([0-9a-f-]{20,})/i.exec(out)?.[1] ?? null;
    }
    if (platform === "darwin") {
      const out = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], { encoding: "utf8", timeout: 5000 });
      return /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? null;
    }
    for (const f of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) if (existsSync(f)) return readFileSync(f, "utf8").trim() || null;
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * This computer's code. When the system won't give its ID, Kerf makes one and
 * keeps it in its own folder (a copied profile would carry it along, so this
 * is only a fallback).
 */
export function thisComputer(dir: string, platform = process.platform): { code: string; fromOs: boolean } {
  const os = readOs(platform);
  if (os) return { code: codeFor(os), fromOs: true };
  const file = join(dir, "computer-id");
  let id = "";
  try {
    id = readFileSync(file, "utf8").trim();
  } catch {
    /* first time */
  }
  if (!/^[0-9a-f]{32}$/.test(id)) {
    id = randomBytes(16).toString("hex");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, id + "\n");
  }
  return { code: codeFor("kerf-local:" + id), fromOs: false };
}
