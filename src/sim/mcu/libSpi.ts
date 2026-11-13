// The SPI library (SPI, SPISettings) on the board's bus, and the SD library on top of it: a microSD card's files
// as the Arduino SD library (Uno, Nano) or the ESP32 core's SD library sees them. The two differ where they do
// on the real boards: the AVR's library takes 8.3 names only, stores them in upper case and opens FILE_WRITE at
// the end of the file; the ESP32's takes long names, wants paths that start with "/", truncates with
// FILE_WRITE ("w") and appends with FILE_APPEND ("a"). Every block the card reads or writes takes its time on the
// bus (sdcard.ts), so a sketch that logs to a card runs as slowly as it would.

import type { Pos } from "./ast";
import { BOOL, VOID } from "./ctypes";
import { bytesOf, cstr, text, type C, type Ctx } from "./ir";
import { argCount, burn, decay, def, dict, method, numEv, pointee, ptrEv, sumCost, type LibClass, type LibFn, type LibMethod } from "./libBase";
import { printMethods } from "./libPrint";
import { readBytes, writeBytes } from "./mem";
import { BLOCK, SD_TIMING, SdCard, shortName, type SdNode } from "./sdcard";
import type { Ptr, SpiPort } from "./vm";

const esp = (ctx: Ctx) => ctx.hal.arch === "esp32";


function bus(ctx: Ctx): SpiPort {
  const s = ctx.hal.spi;
  if (!s) throw new Error("this board has no SPI bus");
  return s;
}

/** SPI_MODEn: the bit values of the AVR's SPCR (0, 4, 8, 12); 0 to 3 on the ESP32 */
const modeOf = (ctx: Ctx, v: number) => (esp(ctx) ? v & 3 : (v >> 2) & 3);

// ---------- SPISettings ----------

interface SpiSettingsObj {
  kind: "SPISettings";
  hz: number;
  msb: boolean;
  mode: number;
}

const defaultSettings = (): SpiSettingsObj => ({ kind: "SPISettings", hz: 4_000_000, msb: true, mode: 0 });

/** SPISettings(clock, bitOrder, dataMode), as a declaration or a temporary */
const makeSettings: LibFn = (args, ctx, pos) => {
  if (args.length !== 0 && args.length !== 3) argCount("SPISettings", 3, 3, args.length, ctx, pos);
  const t = { k: "class" as const, name: "SPISettings" };
  if (!args.length) return { t, ev: defaultSettings, cost: 4, pos };
  const H = numEv(args[0], ctx.T.ulong, ctx, "SPISettings()");
  const O = numEv(args[1], ctx.T.uchar, ctx, "SPISettings()");
  const M = numEv(args[2], ctx.T.uchar, ctx, "SPISettings()");
  return { t, ev: (f) => ({ kind: "SPISettings", hz: H(f) as number, msb: (O(f) as number) !== 0, mode: modeOf(ctx, M(f) as number) }) satisfies SpiSettingsObj, cost: sumCost(args) + 20, pos };
};

export const spiSettingsFn = makeSettings;

export const spiSettingsClass: LibClass = { construct: makeSettings, make: defaultSettings, methods: dict<LibMethod>({}) };

// ---------- SPI ----------

/** transfer(buf, count): the buffer goes out and what comes back takes its place */
const transferBuf: LibFn = (args, ctx, pos) => {
  const P = ptrEv(decay(args[0]), ctx, "SPI.transfer()");
  const N = numEv(args[1], ctx.T.sizeT, ctx, "SPI.transfer()");
  const el = pointee(args[0]);
  return {
    t: VOID,
    ev: (f) => {
      const p = P(f) as Ptr | null;
      if (!p) return ctx.hal.fault("SPI.transfer() on a NULL buffer: on the chip this sends and overwrites whatever is at address 0", "firmware", 0);
      const n = N(f) as number;
      writeBytes(p, el, bus(ctx).transfer(readBytes(p, el, n, ctx.abi)), ctx.abi);
    },
    cost: sumCost(args) + 20,
    pos,
  };
};

const wideTransfer = (bits: 16 | 32) =>
  def(`SPI.transfer${bits}`, ["ulong"], "ulong", 20, ([v], ctx) => {
    const s = bus(ctx);
    const n = bits / 8;
    const bytes = Array.from({ length: n }, (_, i) => (v >>> (8 * (s.msbFirst ? n - 1 - i : i))) & 255);
    const got = s.transfer(bytes);
    let r = 0;
    got.forEach((b, i) => (r += b * 2 ** (8 * (s.msbFirst ? n - 1 - i : i))));
    return bits === 16 ? r & 0xffff : r >>> 0;
  });

export const spiObject: Record<string, LibFn> = dict<LibFn>({
  // the SPI object passed to another library (SD.begin(cs, SPI))
  "@value": (_args, _ctx, pos) => ({ t: { k: "class", name: "SPIClass" }, ev: () => ({ kind: "SPIClass" }), cost: 0, pos }),
  begin: (args, ctx, pos) => {
    if (args.length && !esp(ctx)) argCount("SPI.begin", 0, 0, args.length, ctx, pos);
    if (args.length > 4) argCount("SPI.begin", 0, 4, args.length, ctx, pos);
    const pins = args.map((a) => numEv(a, ctx.T.int, ctx, "SPI.begin()"));
    return {
      t: VOID,
      ev: (f) => {
        const p = bus(ctx).pins;
        const want = pins.map((P) => P(f) as number);
        const named = p ? [p.sck, p.miso, p.mosi, p.ss] : [];
        if (want.some((w, i) => w >= 0 && w !== named[i]))
          ctx.hal.fault(`SPI.begin(${want.join(", ")}): the simulation wires SPI devices to the board's own SPI pins (SCK ${named[0]}, MISO ${named[1]}, MOSI ${named[2]}), so devices on other pins are not on its bus`, "firmware", 0);
        bus(ctx).begin();
      },
      cost: sumCost(args) + 120,
      pos,
    };
  },
  end: def("SPI.end", [], "void", 20, (_v, ctx) => bus(ctx).end()),
  beginTransaction: (args, ctx, pos) => {
    if (args.length !== 1) argCount("SPI.beginTransaction", 1, 1, args.length, ctx, pos);
    const a = args[0];
    const t = a.t.k === "class" ? a.t : null;
    if (!t || t.name !== "SPISettings") ctx.error("SPI.beginTransaction() takes an SPISettings, like SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0))", pos);
    const S = a.lv ? a.lv.get : a.ev;
    return {
      t: VOID,
      ev: (f) => {
        const s = S(f) as SpiSettingsObj;
        bus(ctx).settings(s.hz, s.msb, s.mode);
      },
      cost: sumCost(args) + 30,
      pos,
    };
  },
  endTransaction: def("SPI.endTransaction", [], "void", 10, () => undefined),
  transfer: (args, ctx, pos) => {
    if (args.length === 2) return transferBuf(args, ctx, pos);
    if (args.length !== 1) argCount("SPI.transfer", 1, 2, args.length, ctx, pos);
    const V = numEv(args[0], ctx.T.uchar, ctx, "SPI.transfer()");
    return { t: ctx.T.uchar, ev: (f) => bus(ctx).transfer([V(f) as number])[0], cost: sumCost(args) + 10, pos };
  },
  transfer16: wideTransfer(16),
  transfer32: wideTransfer(32),
  write: def("SPI.write", ["u8"], "void", 10, ([v], ctx) => void bus(ctx).transfer([v])),
  write16: def("SPI.write16", ["uint"], "void", 12, ([v], ctx) => void bus(ctx).transfer([(v >> 8) & 255, v & 255])),
  writeBytes: def("SPI.writeBytes", ["ptr", "size"], "void", 20, ([p, n], ctx) => {
    if (p) bus(ctx).transfer(readBytes(p as Ptr, ctx.T.uchar, n, ctx.abi));
  }),
  transferBytes: def("SPI.transferBytes", ["ptr", "ptr", "size"], "void", 20, ([o, i, n], ctx) => {
    if (!o) return;
    const got = bus(ctx).transfer(readBytes(o as Ptr, ctx.T.uchar, n, ctx.abi));
    if (i) writeBytes(i as Ptr, ctx.T.uchar, got, ctx.abi);
  }),
  setBitOrder: def("SPI.setBitOrder", ["u8"], "void", 10, ([o], ctx) => {
    const s = bus(ctx);
    s.settings(s.hz, o !== 0, s.mode);
  }),
  setDataMode: def("SPI.setDataMode", ["u8"], "void", 10, ([m], ctx) => {
    const s = bus(ctx);
    s.settings(s.hz, s.msbFirst, modeOf(ctx, m));
  }),
  setClockDivider: def("SPI.setClockDivider", ["ulong"], "void", 10, ([d], ctx) => bus(ctx).divider(d)),
  setFrequency: def("SPI.setFrequency", ["ulong"], "void", 10, ([hz], ctx) => {
    const s = bus(ctx);
    s.settings(hz, s.msbFirst, s.mode);
  }),
  setHwCs: def("SPI.setHwCs", ["bool"], "void", 10, ([on], ctx) => {
    if (on) ctx.hal.fault("SPI.setHwCs(true): the simulation does not drive SS by hardware; drive the chip-select pin with digitalWrite()", "firmware", 0);
  }),
  usingInterrupt: def("SPI.usingInterrupt", ["u8"], "void", 4, () => undefined),
  notUsingInterrupt: def("SPI.notUsingInterrupt", ["u8"], "void", 4, () => undefined),
});

// ---------- SD ----------

interface FileObj {
  kind: "File";
  open: boolean;
  node: SdNode | null;
  parent: SdNode | null;
  /** the path it was opened by, as the sketch gave it */
  path: string;
  pos: number;
  read: boolean;
  write: boolean;
  /** every write goes to the end */
  append: boolean;
  /** a directory's next entry for openNextFile() */
  iter: number;
}

export interface SdState {
  card: SdCard | null;
  cs: number;
  mounted: boolean;
  /** the clock the library runs the card at */
  hz: number;
  open: number;
  maxOpen: number;
}

export const newSdState = (): SdState => ({ card: null, cs: -1, mounted: false, hz: 4e6, open: 0, maxOpen: Infinity });

const closedFile = (): FileObj => ({ kind: "File", open: false, node: null, parent: null, path: "", pos: 0, read: false, write: false, append: false, iter: 0 });

function sdWarn(ctx: Ctx, msg: string) {
  ctx.hal.fault(msg, "firmware", 0);
}

/** run block commands with the card selected, at the library's clock */
function onCard<T>(ctx: Ctx, fn: (card: SdCard, spi: SpiPort, cs: number) => T): T | undefined {
  const st = ctx.lib.sd;
  const card = st.card;
  if (!card || !st.mounted) return undefined;
  const spi = bus(ctx);
  spi.settings(st.hz, true, 0);
  ctx.hal.digitalWrite(st.cs, 0);
  try {
    return fn(card, spi, st.cs);
  } finally {
    ctx.hal.digitalWrite(st.cs, 1);
  }
}

/** a directory's block holding entry i (16 entries of 32 bytes a block) */
const dirBlock = (d: SdNode, i: number) => d.base + Math.floor(Math.max(0, i) / 16);

/** find a name in a directory, reading its blocks up to the entry (or all of them when it is not there) */
function lookup(card: SdCard, spi: SpiPort, cs: number, dir: SdNode, key: string): SdNode | undefined {
  const keys = [...dir.kids.keys()];
  const at = keys.indexOf(key);
  const last = at >= 0 ? at : Math.max(0, keys.length - 1);
  for (let b = 0; b <= Math.floor(last / 16); b++) card.readBlock(spi, cs, dir.base + b);
  return at >= 0 ? dir.kids.get(key) : undefined;
}

/** the key a name is found by in a directory (FAT names do not care about case), and the name it is stored as */
function nameOf(ctx: Ctx, part: string): { key: string; stored: string } | null {
  if (esp(ctx)) {
    if (!part || part.length > 255 || /[\\:*?"<>|]/.test(part)) return null;
    return { key: part.toUpperCase(), stored: part };
  }
  const s = shortName(part);
  return s ? { key: s, stored: s } : null;
}

/** walk a path to its parent directory and last name; null when a folder on the way is missing or a name is not valid */
function walk(ctx: Ctx, path: string, card: SdCard, spi: SpiPort, cs: number): { parent: SdNode; last: { key: string; stored: string } | null } | null {
  const parts = path.split("/").filter((p) => p.length);
  let dir = card.root;
  for (let i = 0; i < parts.length - 1; i++) {
    const n = nameOf(ctx, parts[i]);
    if (!n) return null;
    const next = lookup(card, spi, cs, dir, n.key);
    if (!next || !next.dir) return null;
    dir = next;
  }
  if (!parts.length) return { parent: dir, last: null };
  const n = nameOf(ctx, parts[parts.length - 1]);
  if (!n) return null;
  return { parent: dir, last: n };
}

/** the path a call names; on the ESP32 it must start with "/" */
function pathArg(ctx: Ctx, p: unknown, what: string): string | null {
  const s = text(cstr(p as Ptr | null));
  if (esp(ctx) && !s.startsWith("/")) {
    sdWarn(ctx, `${what}("${s}"): the ESP32's SD library wants a path that starts with "/" (like "/${s}"), so it fails ("does not start with /")`);
    return null;
  }
  return s;
}

/** the AVR's open() flags, or the ESP32's mode string */
interface OpenMode {
  read: boolean;
  write: boolean;
  create: boolean;
  append: boolean;
  truncate: boolean;
}

function modeOfArg(ctx: Ctx, m: unknown): OpenMode {
  if (typeof m === "number") {
    // O_READ 1, O_WRITE 2, O_APPEND 4, O_CREAT 0x10, O_TRUNC 0x40
    return { read: !!(m & 1), write: !!(m & 2), create: !!(m & 0x10), append: !!(m & 4), truncate: !!(m & 0x40) };
  }
  const s = text(cstr(m as Ptr | null));
  const plus = s.includes("+");
  switch (s[0]) {
    case "w":
      return { read: plus, write: true, create: true, append: false, truncate: true };
    case "a":
      return { read: plus, write: true, create: true, append: true, truncate: false };
    default:
      return { read: true, write: plus, create: false, append: false, truncate: false };
  }
}

function sdOpen(ctx: Ctx, path: string, mode: OpenMode, createEsp = false): FileObj {
  const st = ctx.lib.sd;
  if (!st.mounted) return closedFile();
  if (st.open >= st.maxOpen) {
    sdWarn(ctx, `SD.open(): ${st.maxOpen} files are open already, the most SD.begin() allows (its max_files): close one first`);
    return closedFile();
  }
  const r = onCard(ctx, (card, spi, cs) => {
    const w = walk(ctx, path, card, spi, cs);
    if (!w) return closedFile();
    const { parent, last } = w;
    if (!last) return { ...closedFile(), open: true, node: parent, parent: null, path, read: true };
    let node = lookup(card, spi, cs, parent, last.key);
    if (!node) {
      if (!mode.create && !createEsp) return closedFile();
      node = card.allocate(last.stored, false);
      parent.kids.set(last.key, node);
      // the new entry goes into the directory's block at once
      card.readBlock(spi, cs, dirBlock(parent, parent.kids.size - 1));
      card.cacheDirty = true;
      card.flushCache(spi, cs);
    } else if (node.dir && mode.write) return closedFile();
    if (mode.truncate && node.data.length) {
      node.data = [];
      // the file's clusters go back to the FAT, and its entry says 0 bytes
      card.readBlock(spi, cs, 1 << 10);
      card.cacheDirty = true;
      card.flushCache(spi, cs);
    }
    const f: FileObj = { kind: "File", open: true, node, parent, path, pos: 0, read: mode.read, write: mode.write, append: mode.append, iter: 0 };
    // the AVR library's FILE_WRITE starts at the end
    if (mode.write && (mode.append || !esp(ctx))) f.pos = node.data.length;
    return f;
  });
  const f = r ?? closedFile();
  if (f.open) st.open++;
  return f;
}

/** write into a file at its position, through the library's block cache */
function put(ctx: Ctx, f: FileObj, bytes: number[]): number {
  const node = f.node;
  if (!f.open || !f.write || !node || node.dir || !bytes.length) return 0;
  const done = onCard(ctx, (card, spi, cs) => {
    if (f.append) f.pos = node.data.length;
    let i = 0;
    while (i < bytes.length) {
      const blk = Math.floor(f.pos / BLOCK);
      const off = f.pos % BLOCK;
      const n = Math.min(BLOCK - off, bytes.length - i);
      const fresh = off === 0 && f.pos >= node.data.length;
      // a new cluster: the file's chain in the FAT gets another link (both copies of the FAT)
      if (fresh && blk % card.clusterBlocks === 0) {
        card.readBlock(spi, cs, (1 << 10) + (node.base >> 7));
        card.cacheDirty = true;
        card.flushCache(spi, cs);
        card.writeBlock(spi, cs, (1 << 11) + (node.base >> 7));
      }
      if (fresh) card.freshBlock(spi, cs, node.base + blk);
      else card.readBlock(spi, cs, node.base + blk);
      for (let k = 0; k < n; k++) node.data[f.pos + k] = bytes[i + k] & 255;
      card.cacheDirty = true;
      f.pos += n;
      i += n;
    }
    node.written = ctx.hal.cyc / ctx.hal.fcpu;
    return bytes.length;
  });
  burn(ctx.hal, 20 + bytes.length * 6);
  return done ?? 0;
}

/** write the file's changes and its directory entry (size, date) to the card */
function sync(ctx: Ctx, f: FileObj) {
  if (!f.open || !f.write || !f.node || !f.parent) return;
  const parent = f.parent;
  const node = f.node;
  onCard(ctx, (card, spi, cs) => {
    card.flushCache(spi, cs);
    const idx = [...parent.kids.values()].indexOf(node);
    card.readBlock(spi, cs, dirBlock(parent, idx));
    card.cacheDirty = true;
    card.flushCache(spi, cs);
  });
}

function fileRead(ctx: Ctx, f: FileObj, n: number): number[] {
  const node = f.node;
  if (!f.open || !f.read || !node || node.dir) return [];
  const end = Math.min(node.data.length, f.pos + n);
  if (end <= f.pos) return [];
  const out: number[] = [];
  onCard(ctx, (card, spi, cs) => {
    while (f.pos < end) {
      card.readBlock(spi, cs, node.base + Math.floor(f.pos / BLOCK));
      const stop = Math.min(end, (Math.floor(f.pos / BLOCK) + 1) * BLOCK);
      for (; f.pos < stop; f.pos++) out.push(node.data[f.pos] ?? 0);
    }
  });
  return out;
}

const fileObjOf = (obj: C) => (obj.lv ? obj.lv.get : obj.ev) as (f: unknown[]) => unknown;

const fileMethod = (name: string, params: Parameters<typeof method>[2], ret: Parameters<typeof method>[3], cyc: number, run: (f: FileObj, v: number[], ctx: Ctx) => unknown, defaults: unknown[] = []) =>
  method<FileObj>("File", name, params, ret, cyc, (f, v, ctx) => run(f, v, ctx), defaults);

/** a File as a value of the sketch's (SD.open(), openNextFile()) */
const fileValue = (ev: (f: unknown[]) => FileObj, cost: number, pos: Pos): C => ({ t: { k: "class", name: "File" }, ev, cost, pos });

export const fileClass: LibClass = {
  make: closedFile,
  truthy: (o) => !!(o as FileObj).open,
  methods: dict<LibMethod>({
    ...printMethods("File", (o, bytes, ctx) => put(ctx, o as FileObj, bytes), (obj) => fileObjOf(obj)),
    read: (obj, args, ctx, pos) => {
      if (args.length === 2) {
        const O = fileObjOf(obj);
        const P = ptrEv(decay(args[0]), ctx, "File.read()");
        const N = numEv(args[1], ctx.T.sizeT, ctx, "File.read()");
        const el = pointee(args[0]);
        return {
          t: ctx.T.int,
          ev: (f) => {
            const p = P(f) as Ptr | null;
            const got = fileRead(ctx, O(f) as FileObj, N(f) as number);
            if (p) writeBytes(p, el, got, ctx.abi);
            burn(ctx.hal, 40 + got.length * 4);
            return got.length;
          },
          cost: sumCost(args) + 40,
          pos,
        };
      }
      if (args.length) argCount("File.read", 0, 2, args.length, ctx, pos);
      return fileMethod("read", [], "int", 120, (fo, _v, c) => fileRead(c, fo, 1)[0] ?? -1)(obj, args, ctx, pos);
    },
    peek: fileMethod("peek", [], "int", 100, (fo, _v, c) => {
      const p = fo.pos;
      const b = fileRead(c, fo, 1)[0];
      fo.pos = p;
      return b ?? -1;
    }),
    available: fileMethod("available", [], "int", 40, (fo, _v, c) => {
      if (!fo.open || !fo.node || fo.node.dir || !fo.read) return 0;
      const n = Math.max(0, fo.node.data.length - fo.pos);
      // the AVR's File::available() says at most 0x7FFF
      return esp(c) ? n : Math.min(n, 0x7fff);
    }),
    availableForWrite: fileMethod("availableForWrite", [], "int", 20, (fo) => (fo.open && fo.write ? BLOCK - (fo.pos % BLOCK) : 0)),
    position: fileMethod("position", [], "ulong", 20, (fo) => (fo.open ? fo.pos : 0)),
    size: fileMethod("size", [], "ulong", 20, (fo) => (fo.open && fo.node && !fo.node.dir ? fo.node.data.length : 0)),
    seek: fileMethod("seek", ["ulong"], "bool", 60, (fo, [p]) => {
      if (!fo.open || !fo.node || fo.node.dir || p > fo.node.data.length) return 0;
      fo.pos = p;
      return 1;
    }),
    flush: fileMethod("flush", [], "void", 60, (fo, _v, c) => sync(c, fo)),
    close: fileMethod("close", [], "void", 60, (fo, _v, c) => {
      if (!fo.open) return;
      sync(c, fo);
      fo.open = false;
      c.lib.sd.open = Math.max(0, c.lib.sd.open - 1);
    }),
    isDirectory: fileMethod("isDirectory", [], "bool", 10, (fo) => (fo.open && fo.node?.dir ? 1 : 0)),
    name: fileMethod("name", [], "charp", 10, (fo) => ({ m: [...bytesOf(fo.open && fo.node ? (fo.parent ? fo.node.name : "/") : ""), 0], i: 0, ro: true }) satisfies Ptr),
    path: fileMethod("path", [], "charp", 10, (fo) => ({ m: [...bytesOf(fo.open ? fo.path : ""), 0], i: 0, ro: true }) satisfies Ptr),
    getLastWrite: fileMethod("getLastWrite", [], "ulong", 10, (fo) => Math.floor(fo.node?.written ?? 0)),
    rewindDirectory: fileMethod("rewindDirectory", [], "void", 20, (fo) => {
      fo.iter = 0;
    }),
    openNextFile: (obj, args, ctx, pos) => {
      if (args.length > 1) argCount("File.openNextFile", 0, 1, args.length, ctx, pos);
      const O = fileObjOf(obj);
      return fileValue(
        (f) => {
          const d = O(f) as FileObj;
          if (!d.open || !d.node?.dir) return closedFile();
          const dir = d.node;
          const kids = [...dir.kids.values()];
          if (d.iter >= kids.length) return closedFile();
          const node = kids[d.iter++];
          onCard(ctx, (card, spi, cs) => card.readBlock(spi, cs, dirBlock(dir, d.iter - 1)));
          ctx.lib.sd.open++;
          return { kind: "File", open: true, node, parent: dir, path: `${d.path.replace(/\/$/, "")}/${node.name}`, pos: 0, read: true, write: false, append: false, iter: 0 };
        },
        sumCost(args) + 200,
        pos,
      );
    },
  }),
};

const sdNeedsMount = (ctx: Ctx, what: string): boolean => {
  if (ctx.lib.sd.mounted) return true;
  sdWarn(ctx, `SD.${what}() before SD.begin() worked: there is no card to use, so it fails`);
  return false;
};

function begin(ctx: Ctx, cs: number, hz: number, maxOpen: number): boolean {
  const st = ctx.lib.sd;
  const hal = ctx.hal;
  const spi = bus(ctx);
  st.mounted = false;
  st.cs = cs;
  st.maxOpen = maxOpen;
  spi.begin();
  hal.pinMode(cs, 1);
  hal.digitalWrite(cs, 1);
  // the library wakes the card with 80 clocks at 250 kHz, CS high, before its first command
  hal.spend((80 / 250e3) * hal.fcpu);
  const dev = spi.device(cs) as (SdCard & { kind?: string }) | undefined;
  const card = dev?.kind === "sd" ? dev : null;
  if (!card || !card.ready()) {
    if (!card)
      sdWarn(
        ctx,
        dev
          ? `SD.begin(${cs}): pin ${cs} selects ${dev.name}, not a microSD card module`
          : `SD.begin(${cs}): no microSD card module has its CS on pin ${cs}, so the card never answers and begin() gives up after ${SD_TIMING.noCardMs / 1000} s`,
      );
    else sdWarn(ctx, !card.inserted ? `SD.begin(${cs}): there is no card in ${card.name}, so begin() fails` : `SD.begin(${cs}): ${card.name} has no power, so the card never answers`);
    hal.spend((SD_TIMING.noCardMs * hal.fcpu) / 1000);
    return false;
  }
  // power-up: ACMD41 until the card leaves its idle state, at the slow clock the library starts at
  hal.spend((SD_TIMING.initMs * hal.fcpu) / 1000);
  st.hz = hz;
  st.card = card;
  st.mounted = true;
  // the partition table, the volume's boot sector, and on FAT32 its FSInfo block
  onCard(ctx, (c, s, pin) => {
    c.readBlock(s, pin, 0);
    c.readBlock(s, pin, 8192);
    if (c.format === "FAT32") c.readBlock(s, pin, 8193);
  });
  if (card.format === "exFAT") {
    st.mounted = false;
    sdWarn(ctx, `SD.begin(): the card in ${card.name} is formatted exFAT (as 64 GB and larger cards come); the SD library reads FAT16 and FAT32 only, so begin() fails. Format it FAT32`);
    return false;
  }
  return true;
}

const sdPathOp = (name: string, run: (ctx: Ctx, path: string) => boolean): LibFn =>
  def(`SD.${name}`, ["ptr"], "bool", 200, ([p], ctx) => {
    if (!sdNeedsMount(ctx, name)) return 0;
    const path = pathArg(ctx, p, `SD.${name}`);
    return path !== null && run(ctx, path) ? 1 : 0;
  });

function makeDirs(ctx: Ctx, path: string): boolean {
  return (
    onCard(ctx, (card, spi, cs) => {
      const parts = path.split("/").filter((x) => x);
      let dir = card.root;
      for (const part of parts) {
        const n = nameOf(ctx, part);
        if (!n) return false;
        let next = lookup(card, spi, cs, dir, n.key);
        if (next && !next.dir) return false;
        if (!next) {
          next = card.allocate(n.stored, true);
          dir.kids.set(n.key, next);
          card.readBlock(spi, cs, dirBlock(dir, dir.kids.size - 1));
          card.cacheDirty = true;
          card.flushCache(spi, cs);
          // a new folder's cluster is cleared block by block, so a folder takes a while to make
          for (let b = 0; b < card.clusterBlocks; b++) card.writeBlock(spi, cs, next.base + b);
        }
        dir = next;
      }
      return true;
    }) ?? false
  );
}

export const sdObject: Record<string, LibFn> = dict<LibFn>({
  begin: (args, ctx, pos) => {
    const e = esp(ctx);
    if (args.length > (e ? 6 : 2)) argCount("SD.begin", 0, e ? 6 : 2, args.length, ctx, pos);
    // AVR: begin(), begin(cs), begin(clock, cs); ESP32: begin(ss, spi, frequency, mountpoint, max_files, format_if_empty)
    const kinds = e ? ["int", "spi", "ulong", "ptr", "int", "int"] : args.length === 2 ? ["ulong", "int"] : ["int"];
    const evs = args.map((a, i) => {
      if (kinds[i] === "spi") {
        if (!(a.t.k === "class" && a.t.name === "SPIClass")) ctx.error("SD.begin(ss, spi, ...): the second argument is the SPI bus, like SD.begin(5, SPI)", a.pos);
        return null;
      }
      if (kinds[i] === "ptr") return ptrEv(decay(a), ctx, "SD.begin()");
      return numEv(a, kinds[i] === "ulong" ? ctx.T.ulong : ctx.T.int, ctx, "SD.begin()");
    });
    return {
      t: BOOL,
      ev: (f) => {
        const v = evs.map((x) => (x ? (x(f) as number) : 0));
        const ss = bus(ctx).pins?.ss ?? 10;
        if (e) return begin(ctx, args.length ? v[0] : ss, args.length > 2 ? v[2] : 4e6, args.length > 4 ? v[4] : 5) ? 1 : 0;
        // the AVR's library runs the card at F_CPU/4 (SPI_HALF_SPEED); begin(clock, cs) sets another clock
        if (args.length === 2) return begin(ctx, v[1], v[0], Infinity) ? 1 : 0;
        return begin(ctx, args.length ? v[0] : ss, ctx.hal.fcpu / 4, Infinity) ? 1 : 0;
      },
      cost: sumCost(args) + 400,
      pos,
    };
  },
  end: def("SD.end", [], "void", 40, (_v, ctx) => {
    ctx.lib.sd.mounted = false;
  }),
  open: (args, ctx, pos) => {
    if (args.length < 1 || args.length > 3) argCount("SD.open", 1, esp(ctx) ? 3 : 2, args.length, ctx, pos);
    const P = ptrEv(decay(args[0]), ctx, "SD.open()");
    const m = args[1] ? decay(args[1]) : null;
    const M = m ? (m.t.k === "ptr" ? m.ev : numEv(m, ctx.T.uchar, ctx, "SD.open()")) : null;
    if (m && m.t.k === "ptr" && !esp(ctx)) ctx.error('SD.open(path, mode): on this board the mode is FILE_READ or FILE_WRITE, not a string like "w"', m.pos);
    if (m && m.t.k !== "ptr" && esp(ctx)) ctx.error('SD.open(path, mode): on the ESP32 the mode is FILE_READ, FILE_WRITE or FILE_APPEND ("r", "w", "a")', m.pos);
    const Cr = args[2] ? numEv(args[2], ctx.T.uchar, ctx, "SD.open()") : null;
    return fileValue(
      (f) => {
        if (!sdNeedsMount(ctx, "open")) return closedFile();
        const path = pathArg(ctx, P(f), "SD.open");
        if (path === null) return closedFile();
        const mode = modeOfArg(ctx, M ? M(f) : esp(ctx) ? { m: [...bytesOf("r"), 0], i: 0 } : 1);
        burn(ctx.hal, 300);
        return sdOpen(ctx, path, mode, Cr ? !!Cr(f) : false);
      },
      sumCost(args) + 200,
      pos,
    );
  },
  exists: sdPathOp("exists", (ctx, path) => {
    return (
      onCard(ctx, (card, spi, cs) => {
        const w = walk(ctx, path, card, spi, cs);
        if (!w) return false;
        return !w.last || !!lookup(card, spi, cs, w.parent, w.last.key);
      }) ?? false
    );
  }),
  remove: sdPathOp("remove", (ctx, path) => {
    return (
      onCard(ctx, (card, spi, cs) => {
        const w = walk(ctx, path, card, spi, cs);
        if (!w?.last) return false;
        const node = lookup(card, spi, cs, w.parent, w.last.key);
        if (!node || node.dir) return false;
        const idx = [...w.parent.kids.keys()].indexOf(w.last.key);
        w.parent.kids.delete(w.last.key);
        // its entry is marked deleted and its clusters freed in the FAT
        card.readBlock(spi, cs, dirBlock(w.parent, idx));
        card.cacheDirty = true;
        card.flushCache(spi, cs);
        card.readBlock(spi, cs, (1 << 10) + (node.base >> 7));
        card.cacheDirty = true;
        card.flushCache(spi, cs);
        return true;
      }) ?? false
    );
  }),
  mkdir: sdPathOp("mkdir", (ctx, path) => makeDirs(ctx, path)),
  rmdir: sdPathOp("rmdir", (ctx, path) => {
    return (
      onCard(ctx, (card, spi, cs) => {
        const w = walk(ctx, path, card, spi, cs);
        if (!w?.last) return false;
        const node = lookup(card, spi, cs, w.parent, w.last.key);
        if (!node?.dir || node.kids.size) return false;
        w.parent.kids.delete(w.last.key);
        card.readBlock(spi, cs, dirBlock(w.parent, 0));
        card.cacheDirty = true;
        card.flushCache(spi, cs);
        return true;
      }) ?? false
    );
  }),
  rename: def("SD.rename", ["ptr", "ptr"], "bool", 300, ([a, b], ctx) => {
    if (!esp(ctx)) {
      sdWarn(ctx, "SD.rename(): the Arduino SD library for this board has no rename; copy the file and remove the old one");
      return 0;
    }
    if (!sdNeedsMount(ctx, "rename")) return 0;
    const from = pathArg(ctx, a, "SD.rename");
    const to = pathArg(ctx, b, "SD.rename");
    if (from === null || to === null) return 0;
    return (onCard(ctx, (card, spi, cs) => {
      const w1 = walk(ctx, from, card, spi, cs);
      const w2 = walk(ctx, to, card, spi, cs);
      if (!w1?.last || !w2?.last) return false;
      const node = lookup(card, spi, cs, w1.parent, w1.last.key);
      if (!node || lookup(card, spi, cs, w2.parent, w2.last.key)) return false;
      w1.parent.kids.delete(w1.last.key);
      node.name = w2.last.stored;
      w2.parent.kids.set(w2.last.key, node);
      card.readBlock(spi, cs, dirBlock(w2.parent, w2.parent.kids.size - 1));
      card.cacheDirty = true;
      card.flushCache(spi, cs);
      return true;
    }) ?? false)
      ? 1
      : 0;
  }),
  cardType: def("SD.cardType", [], "u8", 10, (_v, ctx) => {
    const st = ctx.lib.sd;
    // CARD_NONE 0, CARD_SD 2, CARD_SDHC 3
    return !st.mounted || !st.card ? 0 : st.card.capacity > 2 ** 31 ? 3 : 2;
  }),
  cardSize: def("SD.cardSize", [], "double", 10, (_v, ctx) => (ctx.lib.sd.mounted && ctx.lib.sd.card ? ctx.lib.sd.card.capacity : 0)),
  totalBytes: def("SD.totalBytes", [], "double", 10, (_v, ctx) => (ctx.lib.sd.mounted && ctx.lib.sd.card ? Math.floor(ctx.lib.sd.card.capacity * 0.998) : 0)),
  usedBytes: def("SD.usedBytes", [], "double", 10, (_v, ctx) => (ctx.lib.sd.mounted && ctx.lib.sd.card ? ctx.lib.sd.card.used() : 0)),
});

/** the ESP32's fs::FS: SD passed to a function of the sketch's (void listDir(fs::FS &fs, ...)) */
export const fsClass: LibClass = {
  methods: dict<LibMethod>(Object.fromEntries(Object.entries(sdObject).filter(([k]) => !k.startsWith("@")).map(([k, fn]) => [k, ((_obj, args, ctx, pos) => fn(args, ctx, pos)) as LibMethod]))),
};

sdObject["@value"] = (_args, ctx, pos) => {
  if (!esp(ctx)) ctx.error("SD is a library object; call one of its functions, like SD.begin()", pos);
  return { t: { k: "class", name: "fs::FS" }, ev: () => ({ kind: "fs::FS" }), cost: 0, pos };
};
