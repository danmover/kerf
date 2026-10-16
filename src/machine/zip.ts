// A small ZIP writer with no dependencies: STORE method (no compression),
// CRC-32, UTF-8 file names. Enough for build packs, which are mostly text
// and STL files that every unzip tool reads.

export interface ZipEntry {
  path: string;
  data: string | Uint8Array | ArrayBuffer;
}

let CRC_TABLE: Uint32Array | undefined;

function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

export function crc32(data: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = t[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS date and time fields for the headers. */
function dosTime(d: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

const bytesOf = (d: ZipEntry["data"]): Uint8Array => (typeof d === "string" ? new TextEncoder().encode(d) : d instanceof Uint8Array ? d : new Uint8Array(d));

/** Clean a path for the archive: forward slashes, no leading slash, no "..". */
function cleanPath(p: string): string {
  return p
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
}

/** Builds a ZIP archive. Later entries with the same path replace earlier ones. */
export function zip(entries: ZipEntry[], date = new Date()): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const { time, date: day } = dosTime(date);
  const byPath = new Map<string, Uint8Array>();
  for (const e of entries) {
    const p = cleanPath(e.path);
    if (p) byPath.set(p, bytesOf(e.data));
  }
  const files = [...byPath].map(([path, data]) => ({ name: enc.encode(path), data, crc: crc32(data), offset: 0 }));
  if (files.length > 0xffff) throw new Error("Too many files for a ZIP archive without ZIP64");
  let size = 22;
  for (const f of files) size += 30 + f.name.length + f.data.length + 46 + f.name.length;
  if (size > 0xffffffff) throw new Error("The archive is larger than 4 GB");
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let o = 0;
  const u16 = (v: number) => {
    dv.setUint16(o, v, true);
    o += 2;
  };
  const u32 = (v: number) => {
    dv.setUint32(o, v >>> 0, true);
    o += 4;
  };
  const UTF8 = 1 << 11;
  for (const f of files) {
    f.offset = o;
    u32(0x04034b50); // local file header
    u16(20); // version needed
    u16(UTF8);
    u16(0); // STORE
    u16(time);
    u16(day);
    u32(f.crc);
    u32(f.data.length);
    u32(f.data.length);
    u16(f.name.length);
    u16(0);
    out.set(f.name, o);
    o += f.name.length;
    out.set(f.data, o);
    o += f.data.length;
  }
  const cdStart = o;
  for (const f of files) {
    u32(0x02014b50); // central directory header
    u16(20 | (3 << 8)); // made by: version 2.0, Unix
    u16(20);
    u16(UTF8);
    u16(0);
    u16(time);
    u16(day);
    u32(f.crc);
    u32(f.data.length);
    u32(f.data.length);
    u16(f.name.length);
    u16(0); // extra
    u16(0); // comment
    u16(0); // disk
    u16(0); // internal attributes
    u32((0o100644 << 16) >>> 0); // external attributes: regular file, rw-r--r--
    u32(f.offset);
    out.set(f.name, o);
    o += f.name.length;
  }
  const cdSize = o - cdStart;
  u32(0x06054b50); // end of central directory
  u16(0);
  u16(0);
  u16(files.length);
  u16(files.length);
  u32(cdSize);
  u32(cdStart);
  u16(0);
  return out;
}
