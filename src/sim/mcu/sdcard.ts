// A microSD card on the SPI bus, as the SD library sees it: a FAT file system of files and folders, read and
// written a 512-byte block at a time. Each block command takes its time on the bus at the SPI clock, plus the
// card's own: a read waits for the card to fetch the block, a write for it to program the block, and now and
// then a write waits much longer while the card does its housekeeping (a new allocation unit). Typical figures
// for an SDHC card in SPI mode; a slow or worn card is slower.

import type { SpiDevice, SpiPort } from "./vm";

/** typical SDHC timings in SPI mode */
export const SD_TIMING = {
  /** power-up to ready: the card leaves its idle state after ACMD41 has been sent for this long */
  initMs: 80,
  /** SD.begin() with no card answering: the library retries CMD0 until its 2 s timeout */
  noCardMs: 2000,
  /** from a read command to the block's data token */
  readLatencyUs: 250,
  /** programming a written block */
  writeBusyUs: 700,
  /** the occasional long write: the card erasing and remapping when a write starts a new allocation unit */
  longBusyMs: 25,
  /** blocks between long writes (a 64 KB allocation unit) */
  longEvery: 128,
};

export const BLOCK = 512;

export interface SdNode {
  /** the name as the card stores it: 8.3 and upper case for the AVR's SD library, as given for the ESP32's */
  name: string;
  dir: boolean;
  data: number[];
  kids: Map<string, SdNode>;
  /** the first block of its data, for the block cache */
  base: number;
  /** seconds of simulated time it was last written */
  written: number;
}

export interface SdFileReport {
  path: string;
  bytes: number;
  /** its text, when it is text (cut to 4 KB) */
  text?: string;
}

const newNode = (name: string, dir: boolean, base: number): SdNode => ({ name, dir, data: [], kids: new Map(), base, written: 0 });

/** A microSD card, as the module it sits in wires it to a chip-select pin. */
export class SdCard implements SpiDevice {
  readonly kind = "sd";
  maxHz = 25e6;
  modes = [0, 3];
  root = newNode("/", true, 0);
  /** a card is in the slot */
  inserted = true;
  /** the module has power */
  powered: () => boolean = () => true;
  /** blocks read and written over the run */
  reads = 0;
  writes = 0;
  /** the block in the library's 512-byte cache, and whether it holds a change not yet written */
  cacheBlock = -1;
  cacheDirty = false;
  private nextBase = 1 << 12;
  private sinceLong = 0;

  constructor(
    public name: string,
    /** bytes the card holds */
    public capacity = 16 * 2 ** 30,
    /** FAT16 or FAT32 the Arduino SD library can read; a card left in exFAT (as 64 GB and larger come) it cannot */
    public format: "FAT16" | "FAT32" | "exFAT" = capacity > 2 ** 31 ? "FAT32" : "FAT16",
  ) {}

  /** blocks a cluster holds: 32 KB clusters, as cards of this size are formatted */
  get clusterBlocks() {
    return 64;
  }

  transfer(): number {
    // the SD library talks to the card a block at a time (block()), not byte by byte
    return 0xff;
  }

  ready(): boolean {
    return this.inserted && this.powered();
  }

  used(): number {
    let n = 0;
    const walk = (d: SdNode) => {
      for (const k of d.kids.values()) {
        n += Math.ceil(Math.max(1, k.data.length) / (BLOCK * this.clusterBlocks)) * BLOCK * this.clusterBlocks;
        if (k.dir) walk(k);
      }
    };
    walk(this.root);
    return n;
  }

  /** a new node's place on the card */
  allocate(name: string, dir: boolean): SdNode {
    const n = newNode(name, dir, this.nextBase);
    // room for its data to grow before the next file's blocks
    this.nextBase += 1 << 16;
    return n;
  }

  // ---------- block commands on the bus ----------

  /** read a block into the cache (writing out the cached one first if it changed) */
  readBlock(spi: SpiPort, cs: number, block: number) {
    if (this.cacheBlock === block) return;
    this.flushCache(spi, cs);
    this.reads++;
    const arg = [(block >>> 24) & 255, (block >>> 16) & 255, (block >>> 8) & 255, block & 255];
    // CMD17, its response, the wait for the data token, the block and its CRC
    spi.traffic(cs, [0x51, ...arg], [0x00, 0xfe], 6 + 2 + BLOCK + 2, SD_TIMING.readLatencyUs);
    this.cacheBlock = block;
    this.cacheDirty = false;
  }

  /** start a block the file is about to fill from its start: no need to read it first */
  freshBlock(spi: SpiPort, cs: number, block: number) {
    if (this.cacheBlock === block) return;
    this.flushCache(spi, cs);
    this.cacheBlock = block;
    this.cacheDirty = false;
  }

  /** write the cached block if it changed */
  flushCache(spi: SpiPort, cs: number) {
    if (!this.cacheDirty || this.cacheBlock < 0) return;
    this.writeBlock(spi, cs, this.cacheBlock);
    this.cacheDirty = false;
  }

  writeBlock(spi: SpiPort, cs: number, block: number) {
    this.writes++;
    let busyUs = SD_TIMING.writeBusyUs;
    if (++this.sinceLong >= SD_TIMING.longEvery) {
      this.sinceLong = 0;
      busyUs += SD_TIMING.longBusyMs * 1000;
    }
    const arg = [(block >>> 24) & 255, (block >>> 16) & 255, (block >>> 8) & 255, block & 255];
    // CMD24, its response, the start token, the block and its CRC, the data response, then busy while it programs
    spi.traffic(cs, [0x58, ...arg, 0xfe], [0x00, 0x05], 6 + 2 + 1 + BLOCK + 2 + 1, busyUs);
  }

  /** what is on the card, for the run's results */
  report(): SdFileReport[] {
    const out: SdFileReport[] = [];
    const walk = (d: SdNode, at: string) => {
      for (const k of d.kids.values()) {
        const path = `${at}/${k.name}`;
        if (k.dir) {
          out.push({ path: path + "/", bytes: 0 });
          walk(k, path);
          continue;
        }
        const printable = k.data.every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
        out.push({ path, bytes: k.data.length, ...(printable ? { text: String.fromCharCode(...k.data.slice(0, 4096)) } : {}) });
      }
    };
    walk(this.root, "");
    return out;
  }
}

/** The 8.3 name the AVR's SD library stores a name as, or null when it is not one (it has no long names). */
export function shortName(name: string): string | null {
  if (!name || name === "." || name === "..") return null;
  const dot = name.lastIndexOf(".");
  const base = dot < 0 ? name : name.slice(0, dot);
  const ext = dot < 0 ? "" : name.slice(dot + 1);
  if (!base || base.length > 8 || ext.length > 3 || (dot >= 0 && !ext)) return null;
  if (/[^A-Za-z0-9!#$%&'()\-@^_`{}~]/.test(base + ext)) return null;
  return (ext ? `${base}.${ext}` : base).toUpperCase();
}
