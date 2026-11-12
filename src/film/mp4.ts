// A small MP4 (ISO BMFF) writer for the film maker: one video track (H.264
// or VP9) and an optional audio track (AAC or Opus), with the index (moov)
// before the media data so a player or upload starts at once. Samples come
// from WebCodecs encoders in decode order; the file is built as a Blob of
// parts, so a long film never needs one huge buffer.

export type VideoCodec = "avc" | "vp9";
export type AudioCodec = "aac" | "opus";

export interface Mp4Sample {
  data: Uint8Array;
  /** presentation time in the track's timescale */
  pts: number;
  /** in the track's timescale */
  duration: number;
  key: boolean;
}

export interface Mp4VideoTrack {
  codec: VideoCodec;
  width: number;
  height: number;
  /** ticks per second */
  timescale: number;
  /** avcC record for H.264 (WebCodecs decoderConfig.description); for VP9 the codec string's numbers */
  config: Uint8Array | null;
  /** the codec string, e.g. avc1.640028 or vp09.00.40.08 */
  codecString: string;
  samples: Mp4Sample[];
}

export interface Mp4AudioTrack {
  codec: AudioCodec;
  sampleRate: number;
  channels: number;
  /** AudioSpecificConfig for AAC; OpusHead (from WebCodecs) or nothing for Opus */
  config: Uint8Array | null;
  samples: Mp4Sample[];
}

// ---------- byte writing ----------

class Bytes {
  private buf = new Uint8Array(256);
  len = 0;
  private grow(n: number) {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v: number) {
    this.grow(1);
    this.buf[this.len++] = v & 0xff;
    return this;
  }
  u16(v: number) {
    return this.u8(v >>> 8).u8(v);
  }
  u24(v: number) {
    return this.u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  u32(v: number) {
    return this.u8(v >>> 24).u8(v >>> 16).u8(v >>> 8).u8(v);
  }
  i32(v: number) {
    return this.u32(v >>> 0);
  }
  u64(v: number) {
    const hi = Math.floor(v / 2 ** 32);
    return this.u32(hi).u32(v - hi * 2 ** 32);
  }
  str(s: string) {
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    return this;
  }
  bytes(b: Uint8Array) {
    this.grow(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }
  zeros(n: number) {
    this.grow(n);
    this.buf.fill(0, this.len, this.len + n);
    this.len += n;
    return this;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/** A box: size, four-letter type, then its body. */
function box(type: string, ...body: (Uint8Array | null | undefined)[]): Uint8Array {
  const parts = body.filter((b): b is Uint8Array => !!b);
  const size = 8 + parts.reduce((s, b) => s + b.length, 0);
  const w = new Bytes().u32(size).str(type);
  for (const p of parts) w.bytes(p);
  return w.done();
}

/** A full box: version and flags before the body. */
function fullBox(type: string, version: number, flags: number, body: Uint8Array, ...children: Uint8Array[]): Uint8Array {
  return box(type, new Bytes().u8(version).u24(flags).bytes(body).done(), ...children);
}

const UNITY = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000];

function matrix(w: Bytes) {
  for (const v of UNITY) w.u32(v);
  return w;
}

// ---------- sample tables ----------

/** Samples grouped into chunks of about `span` ticks each, so audio and video interleave in the media data. */
function chunk(samples: Mp4Sample[], span: number): { first: number; count: number }[] {
  const out: { first: number; count: number }[] = [];
  let i = 0;
  while (i < samples.length) {
    const start = i;
    const t0 = samples[i].pts;
    i++;
    while (i < samples.length && samples[i].pts - t0 < span) i++;
    out.push({ first: start, count: i - start });
  }
  return out;
}

function stts(samples: Mp4Sample[]): Uint8Array {
  const runs: [number, number][] = [];
  for (const s of samples) {
    const last = runs[runs.length - 1];
    if (last && last[1] === s.duration) last[0]++;
    else runs.push([1, s.duration]);
  }
  const w = new Bytes().u32(runs.length);
  for (const [n, d] of runs) w.u32(n).u32(d);
  return fullBox("stts", 0, 0, w.done());
}

/** Composition offsets, only when presentation order differs from decode order (B-frames). */
function ctts(samples: Mp4Sample[]): Uint8Array | null {
  let dts = samples[0]?.pts ?? 0;
  const offs: number[] = [];
  for (const s of samples) {
    offs.push(s.pts - dts);
    dts += s.duration;
  }
  if (offs.every((o) => o === 0)) return null;
  const runs: [number, number][] = [];
  for (const o of offs) {
    const last = runs[runs.length - 1];
    if (last && last[1] === o) last[0]++;
    else runs.push([1, o]);
  }
  const w = new Bytes().u32(runs.length);
  for (const [n, o] of runs) w.u32(n).i32(o);
  // version 1: offsets may be negative
  return fullBox("ctts", 1, 0, w.done());
}

function stss(samples: Mp4Sample[]): Uint8Array | null {
  const keys = samples.map((s, i) => (s.key ? i + 1 : 0)).filter((n) => n > 0);
  if (keys.length === samples.length) return null;
  const w = new Bytes().u32(keys.length);
  for (const k of keys) w.u32(k);
  return fullBox("stss", 0, 0, w.done());
}

function stsc(chunks: { count: number }[]): Uint8Array {
  const runs: [number, number][] = [];
  chunks.forEach((c, i) => {
    const last = runs[runs.length - 1];
    if (!last || last[1] !== c.count) runs.push([i + 1, c.count]);
  });
  const w = new Bytes().u32(runs.length);
  for (const [first, n] of runs) w.u32(first).u32(n).u32(1);
  return fullBox("stsc", 0, 0, w.done());
}

function stsz(samples: Mp4Sample[]): Uint8Array {
  const w = new Bytes().u32(0).u32(samples.length);
  for (const s of samples) w.u32(s.data.length);
  return fullBox("stsz", 0, 0, w.done());
}

function stco(offsets: number[], big: boolean): Uint8Array {
  const w = new Bytes().u32(offsets.length);
  for (const o of offsets) (big ? w.u64(o) : w.u32(o));
  return fullBox(big ? "co64" : "stco", 0, 0, w.done());
}

// ---------- sample descriptions ----------

function visualEntry(type: string, t: Mp4VideoTrack, ...children: Uint8Array[]): Uint8Array {
  const w = new Bytes()
    .zeros(6)
    .u16(1) // data reference index
    .zeros(16) // pre-defined and reserved
    .u16(t.width)
    .u16(t.height)
    .u32(0x00480000) // 72 dpi
    .u32(0x00480000)
    .u32(0)
    .u16(1); // one frame per sample
  const name = "Kerf";
  w.u8(name.length).str(name).zeros(31 - name.length);
  w.u16(0x0018).u16(0xffff);
  return box(type, w.done(), ...children);
}

/** vpcC from a vp09 codec string: profile, level, bit depth and colour. */
function vpcC(codecString: string): Uint8Array {
  const n = codecString.split(".").slice(1).map((s) => parseInt(s, 10));
  const [profile = 0, level = 40, depth = 8, chroma = 1, primaries = 1, transfer = 1, matrixC = 1, full = 0] = n;
  const w = new Bytes()
    .u8(profile)
    .u8(level)
    .u8(((depth & 0xf) << 4) | ((chroma & 0x7) << 1) | (full & 1))
    .u8(primaries)
    .u8(transfer)
    .u8(matrixC)
    .u16(0);
  return fullBox("vpcC", 1, 0, w.done());
}

function videoStsd(t: Mp4VideoTrack): Uint8Array {
  let entry: Uint8Array;
  if (t.codec === "avc") {
    if (!t.config) throw new Error("H.264 needs its avcC record");
    // no colr box: the colour the encoder wrote in the stream itself is the one players should use
    entry = visualEntry("avc1", t, box("avcC", t.config));
  } else entry = visualEntry("vp09", t, vpcC(t.codecString));
  return fullBox("stsd", 0, 0, new Bytes().u32(1).done(), entry);
}

function descriptor(tag: number, body: Uint8Array): Uint8Array {
  // sizes in the four-byte form (0x80 continuation bytes), which every reader takes
  const n = body.length;
  return new Bytes()
    .u8(tag)
    .u8(0x80 | ((n >>> 21) & 0x7f))
    .u8(0x80 | ((n >>> 14) & 0x7f))
    .u8(0x80 | ((n >>> 7) & 0x7f))
    .u8(n & 0x7f)
    .bytes(body)
    .done();
}

/** AAC LC AudioSpecificConfig for a rate and channel count (used when the encoder gives none). */
export function aacConfig(sampleRate: number, channels: number): Uint8Array {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
  const fi = Math.max(0, rates.indexOf(sampleRate));
  const v = (2 << 11) | (fi << 7) | (channels << 3);
  return new Uint8Array([v >>> 8, v & 0xff]);
}

function esds(t: Mp4AudioTrack, bitrate: number): Uint8Array {
  const asc = t.config ?? aacConfig(t.sampleRate, t.channels);
  const dsi = descriptor(0x05, asc);
  const dcd = descriptor(0x04, new Bytes().u8(0x40).u8(0x15).u24(0).u32(bitrate).u32(bitrate).bytes(dsi).done());
  const sl = descriptor(0x06, new Uint8Array([0x02]));
  const es = descriptor(0x03, new Bytes().u16(1).u8(0).bytes(dcd).bytes(sl).done());
  return fullBox("esds", 0, 0, es);
}

/** dOps (big-endian) from WebCodecs' OpusHead (little-endian), or a stereo default. */
export function dOps(head: Uint8Array | null, channels: number, sampleRate: number): Uint8Array {
  let ch = channels;
  let preSkip = 312;
  let rate = sampleRate;
  let gain = 0;
  let family = 0;
  let mapping: Uint8Array | null = null;
  if (head && head.length >= 19 && String.fromCharCode(...head.subarray(0, 8)) === "OpusHead") {
    const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
    ch = head[9];
    preSkip = v.getUint16(10, true);
    rate = v.getUint32(12, true);
    gain = v.getInt16(16, true);
    family = head[18];
    if (family !== 0 && head.length >= 21 + ch) mapping = head.subarray(19, 21 + ch);
  }
  const w = new Bytes().u8(0).u8(ch).u16(preSkip).u32(rate).u16(gain & 0xffff).u8(family);
  if (mapping) w.bytes(mapping);
  return box("dOps", w.done());
}

function audioStsd(t: Mp4AudioTrack, bitrate: number): Uint8Array {
  const w = new Bytes()
    .zeros(6)
    .u16(1)
    .zeros(8)
    .u16(t.channels)
    .u16(16)
    .zeros(4)
    .u32((t.codec === "opus" ? 48000 : t.sampleRate) * 65536);
  const entry = t.codec === "aac" ? box("mp4a", w.done(), esds(t, bitrate)) : box("Opus", w.done(), dOps(t.config, t.channels, t.sampleRate));
  return fullBox("stsd", 0, 0, new Bytes().u32(1).done(), entry);
}

// ---------- tracks ----------

interface TrackOut {
  id: number;
  kind: "video" | "audio";
  timescale: number;
  duration: number;
  samples: Mp4Sample[];
  chunks: { first: number; count: number }[];
  stsd: Uint8Array;
  width: number;
  height: number;
}

function trak(t: TrackOut, movieScale: number, offsets: number[], big: boolean): Uint8Array {
  const movieDur = Math.round((t.duration * movieScale) / t.timescale);
  const tkhd = new Bytes()
    .u32(0)
    .u32(0)
    .u32(t.id)
    .u32(0)
    .u32(movieDur)
    .zeros(8)
    .u16(0)
    .u16(t.kind === "audio" ? 1 : 0) // alternate group
    .u16(t.kind === "audio" ? 0x0100 : 0)
    .u16(0);
  matrix(tkhd).u32(t.width * 65536).u32(t.height * 65536);
  const mdhd = new Bytes().u32(0).u32(0).u32(t.timescale).u32(t.duration).u16(0x55c4).u16(0); // language "und"
  const handler = t.kind === "video" ? "vide" : "soun";
  const hname = t.kind === "video" ? "Kerf video" : "Kerf sound";
  const hdlr = new Bytes().u32(0).str(handler).zeros(12).str(hname).u8(0);
  const mediaHeader = t.kind === "video" ? fullBox("vmhd", 0, 1, new Bytes().zeros(8).done()) : fullBox("smhd", 0, 0, new Bytes().zeros(4).done());
  const dinf = box("dinf", fullBox("dref", 0, 0, new Bytes().u32(1).done(), fullBox("url ", 0, 1, new Uint8Array(0))));
  const stbl = box("stbl", t.stsd, stts(t.samples), t.kind === "video" ? ctts(t.samples) : null, t.kind === "video" ? stss(t.samples) : null, stsc(t.chunks), stsz(t.samples), stco(offsets, big));
  // starts at zero: an edit list keeps players from shifting a track that has composition offsets
  const first = t.samples[0]?.pts ?? 0;
  const edts = first !== 0 ? box("edts", fullBox("elst", 0, 0, new Bytes().u32(1).u32(movieDur).u32(first).u16(1).u16(0).done())) : null;
  return box("trak", fullBox("tkhd", 0, 3, tkhd.done()), edts, box("mdia", fullBox("mdhd", 0, 0, mdhd.done()), fullBox("hdlr", 0, 0, hdlr.done()), box("minf", mediaHeader, dinf, stbl)));
}

function moov(tracks: TrackOut[], offsets: number[][], big: boolean): Uint8Array {
  const movieScale = 1000;
  const dur = Math.max(...tracks.map((t) => Math.round((t.duration * movieScale) / t.timescale)));
  const mvhd = new Bytes().u32(0).u32(0).u32(movieScale).u32(dur).u32(0x00010000).u16(0x0100).zeros(10);
  matrix(mvhd).zeros(24).u32(tracks.length + 1);
  return box("moov", fullBox("mvhd", 0, 0, mvhd.done()), ...tracks.map((t, i) => trak(t, movieScale, offsets[i], big)));
}

/**
 * The finished file. Video and audio chunks are interleaved about every half
 * second; `audioBitrate` only fills in the AAC header's bitrate fields.
 */
export function writeMp4(video: Mp4VideoTrack, audio: Mp4AudioTrack | null, audioBitrate = 160000): Blob {
  const parts = buildMp4(video, audio, audioBitrate);
  return new Blob(parts as BlobPart[], { type: "video/mp4" });
}

/** The file as its parts in order (ftyp, moov, the mdat header, then the samples), for writeMp4 and tests. */
export function buildMp4(video: Mp4VideoTrack, audio: Mp4AudioTrack | null, audioBitrate = 160000): Uint8Array[] {
  if (!video.samples.length) throw new Error("The film has no frames");
  const tracks: TrackOut[] = [];
  const vDur = video.samples.reduce((s, x) => s + x.duration, 0);
  tracks.push({ id: 1, kind: "video", timescale: video.timescale, duration: vDur, samples: video.samples, chunks: chunk(video.samples, video.timescale / 2), stsd: videoStsd(video), width: video.width, height: video.height });
  if (audio?.samples.length) {
    const aDur = audio.samples.reduce((s, x) => s + x.duration, 0);
    tracks.push({ id: 2, kind: "audio", timescale: audio.sampleRate, duration: aDur, samples: audio.samples, chunks: chunk(audio.samples, audio.sampleRate / 2), stsd: audioStsd(audio, audioBitrate), width: 0, height: 0 });
  }
  // the order chunks go in the media data: by start time, video first on a tie
  const order: { track: number; chunk: number; at: number }[] = [];
  tracks.forEach((t, ti) => t.chunks.forEach((c, ci) => order.push({ track: ti, chunk: ci, at: t.samples[c.first].pts / t.timescale })));
  order.sort((a, b) => a.at - b.at || a.track - b.track);
  const sizes = tracks.map((t) => t.chunks.map((c) => t.samples.slice(c.first, c.first + c.count).reduce((s, x) => s + x.data.length, 0)));
  const mdatBody = sizes.flat().reduce((s, n) => s + n, 0);
  const big = mdatBody + 16 > 0xffffffff;
  const ftyp = box("ftyp", new Bytes().str("isom").u32(0x200).str("isom").str("iso2").str(video.codec === "avc" ? "avc1" : "vp09").str("mp41").done());
  // the index's size doesn't depend on the offsets' values, so write it once to measure
  const moovSize = moov(tracks, tracks.map((t) => t.chunks.map(() => 0)), big).length;
  const head = big ? 16 : 8;
  let at = ftyp.length + moovSize + head;
  const offsets = tracks.map((t) => t.chunks.map(() => 0));
  for (const o of order) {
    offsets[o.track][o.chunk] = at;
    at += sizes[o.track][o.chunk];
  }
  const index = moov(tracks, offsets, big);
  if (index.length !== moovSize) throw new Error("MP4 index size changed while writing");
  const mdatHead = big ? new Bytes().u32(1).str("mdat").u64(mdatBody + 16).done() : new Bytes().u32(mdatBody + 8).str("mdat").done();
  const out: Uint8Array[] = [ftyp, index, mdatHead];
  for (const o of order) {
    const t = tracks[o.track];
    const c = t.chunks[o.chunk];
    for (let i = c.first; i < c.first + c.count; i++) out.push(t.samples[i].data);
  }
  return out;
}

/** H.264 level for a frame size and rate: the smallest whose frame size and macroblock rate cover it. */
export function avcLevel(width: number, height: number, fps: number): number {
  const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const rate = mbs * fps;
  const side = Math.max(Math.ceil(width / 16), Math.ceil(height / 16));
  const levels: [number, number, number][] = [
    [31, 3600, 108000],
    [32, 5120, 216000],
    [40, 8192, 245760],
    [42, 8704, 522240],
    [50, 22080, 589824],
    [51, 36864, 983040],
    [52, 36864, 2073600],
  ];
  for (const [lv, fs, mbps] of levels) if (mbs <= fs && rate <= mbps && side * side <= fs * 8) return lv;
  return 52;
}

/** High profile codec strings to try for a size and rate, the fitting level first. */
export function avcCodecs(width: number, height: number, fps: number): string[] {
  const lv = avcLevel(width, height, fps);
  const all = [31, 32, 40, 42, 50, 51, 52].filter((l) => l >= lv);
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return [...all.map((l) => `avc1.6400${hex(l)}`), ...all.map((l) => `avc1.4d00${hex(l)}`), ...all.map((l) => `avc1.42e0${hex(l)}`)];
}
