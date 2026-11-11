// The film maker's MP4 writer: the boxes nest and add up, the index points at
// each sample's bytes, and the H.264 level fits the frame size and rate.

import { describe, expect, it } from "vitest";
import { avcCodecs, avcLevel, buildMp4, dOps, type Mp4Sample } from "../src/film/mp4";

interface Box {
  type: string;
  start: number;
  size: number;
  body: number;
  kids: Box[];
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "edts"]);

function parse(b: Uint8Array, start = 0, end = b.length): Box[] {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const out: Box[] = [];
  let at = start;
  while (at < end) {
    let size = v.getUint32(at);
    const type = String.fromCharCode(...b.subarray(at + 4, at + 8));
    let body = at + 8;
    if (size === 1) {
      size = Number(v.getBigUint64(at + 8));
      body = at + 16;
    }
    expect(size).toBeGreaterThanOrEqual(8);
    expect(at + size).toBeLessThanOrEqual(end);
    out.push({ type, start: at, size, body, kids: CONTAINERS.has(type) ? parse(b, body, at + size) : [] });
    at += size;
  }
  return out;
}

const find = (bs: Box[], path: string[]): Box | undefined => {
  let cur: Box | undefined;
  let list = bs;
  for (const p of path) {
    cur = list.find((x) => x.type === p);
    if (!cur) return undefined;
    list = cur.kids;
  }
  return cur;
};
const findAll = (bs: Box[], type: string): Box[] => bs.flatMap((b) => (b.type === type ? [b] : findAll(b.kids, type)));

const join = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const sample = (n: number, fill: number, pts: number, duration: number, key: boolean): Mp4Sample => ({ data: new Uint8Array(n).fill(fill), pts, duration, key });

describe("MP4 writer", () => {
  const avcC = new Uint8Array([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4, 0x67, 0x64, 0, 0x28, 1, 0, 4, 0x68, 0xee, 0x3c, 0x80]);
  const video = { codec: "avc" as const, width: 1920, height: 1080, timescale: 90000, config: avcC, codecString: "avc1.640028", samples: Array.from({ length: 75 }, (_, i) => sample(100 + i, i + 1, i * 3000, 3000, i % 60 === 0)) };
  const audio = { codec: "aac" as const, sampleRate: 48000, channels: 2, config: new Uint8Array([0x11, 0x90]), samples: Array.from({ length: 120 }, (_, i) => sample(20 + (i % 7), 200, i * 1024, 1024, true)) };

  it("writes ftyp, then the index, then the media, with every box's size adding up", () => {
    const file = join(buildMp4(video, audio));
    const top = parse(file);
    expect(top.map((b) => b.type)).toEqual(["ftyp", "moov", "mdat"]);
    expect(findAll(top, "trak").length).toBe(2);
    expect(find(top, ["moov", "trak", "mdia", "minf", "stbl", "stsd"])).toBeTruthy();
    const mdat = top[2];
    const sizes = [...video.samples, ...audio.samples].reduce((s, x) => s + x.data.length, 0);
    expect(mdat.size).toBe(8 + sizes);
  });

  it("points the chunk offsets at each track's samples, in order", () => {
    const file = join(buildMp4(video, audio));
    const top = parse(file);
    const v = new DataView(file.buffer);
    const traks = findAll(top, "trak");
    traks.forEach((trak, ti) => {
      const samples = ti === 0 ? video.samples : audio.samples;
      const stco = findAll([trak], "stco")[0];
      const stsc = findAll([trak], "stsc")[0];
      const n = v.getUint32(stco.body + 4);
      const offsets = Array.from({ length: n }, (_, i) => v.getUint32(stco.body + 8 + i * 4));
      // samples per chunk from stsc's runs
      const runs = v.getUint32(stsc.body + 4);
      const entries = Array.from({ length: runs }, (_, i) => [v.getUint32(stsc.body + 8 + i * 12), v.getUint32(stsc.body + 12 + i * 12)]);
      let s = 0;
      for (let c = 0; c < n; c++) {
        const per = entries.filter((e) => e[0] <= c + 1).pop()![1];
        let at = offsets[c];
        for (let k = 0; k < per; k++, s++) {
          const d = samples[s].data;
          expect(file.subarray(at, at + d.length)).toEqual(d);
          at += d.length;
        }
      }
      expect(s).toBe(samples.length);
    });
  });

  it("marks only the key frames as sync samples and sums the durations", () => {
    const file = join(buildMp4(video, null));
    const top = parse(file);
    const v = new DataView(file.buffer);
    const stss = findAll(top, "stss")[0];
    expect(v.getUint32(stss.body + 4)).toBe(2);
    expect([v.getUint32(stss.body + 8), v.getUint32(stss.body + 12)]).toEqual([1, 61]);
    const mdhd = findAll(top, "mdhd")[0];
    expect(v.getUint32(mdhd.body + 12)).toBe(90000);
    expect(v.getUint32(mdhd.body + 16)).toBe(75 * 3000);
    const mvhd = find(top, ["moov", "mvhd"])!;
    // 75 frames at 30 fps in milliseconds
    expect(v.getUint32(mvhd.body + 16)).toBe(2500);
    expect(findAll(top, "trak").length).toBe(1);
    expect(findAll(top, "ctts").length).toBe(0);
  });

  it("writes an Opus track's dOps from the encoder's OpusHead", () => {
    const head = new Uint8Array([...[..."OpusHead"].map((c) => c.charCodeAt(0)), 1, 2, 0x38, 0x01, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    const box = dOps(head, 2, 48000);
    const v = new DataView(box.buffer);
    expect(String.fromCharCode(...box.subarray(4, 8))).toBe("dOps");
    expect(box[9]).toBe(2);
    expect(v.getUint16(10)).toBe(312);
    expect(v.getUint32(12)).toBe(48000);
    const file = join(buildMp4(video, { codec: "opus", sampleRate: 48000, channels: 2, config: head, samples: audio.samples.map((s, i) => ({ ...s, pts: i * 960, duration: 960 })) }));
    expect(findAll(parse(file), "stsd").length).toBe(2);
    expect(String.fromCharCode(...file).includes("Opus")).toBe(true);
  });

  it("picks an H.264 level that fits the frame size and rate", () => {
    expect(avcLevel(1280, 720, 30)).toBe(31);
    expect(avcLevel(1920, 1080, 30)).toBe(40);
    expect(avcLevel(1080, 1920, 30)).toBe(40);
    expect(avcLevel(1920, 1080, 60)).toBe(42);
    expect(avcLevel(2560, 1440, 30)).toBe(50);
    expect(avcLevel(3840, 2160, 30)).toBe(51);
    expect(avcLevel(3840, 2160, 60)).toBe(52);
    expect(avcCodecs(1920, 1080, 30)[0]).toBe("avc1.640028");
  });
});
