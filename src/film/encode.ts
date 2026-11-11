// Encoding the film with the browser's own video and audio encoders
// (WebCodecs): H.264 where it is there (every current Chrome, Edge and the
// desktop app), VP9 otherwise, with AAC sound or Opus, into an MP4 file.

import { avcCodecs, writeMp4, type AudioCodec, type Mp4Sample, type VideoCodec } from "./mp4";

export interface CodecChoice {
  video: { codec: string; kind: VideoCodec; bitrate: number };
  audio: { codec: string; kind: AudioCodec; bitrate: number } | null;
}

const VIDEO_TIMESCALE = 90000;
export const AUDIO_RATE = 48000;

/** Bits a second for a clean picture: smooth backdrops band at low rates. */
export function videoBitrate(width: number, height: number, fps: number): number {
  return Math.round(Math.min(90e6, Math.max(4e6, width * height * fps * 0.2)));
}

export function canEncode(): boolean {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

/** The best codecs this app can encode at this size and rate. */
export async function chooseCodecs(width: number, height: number, fps: number, sound: boolean): Promise<CodecChoice> {
  if (!canEncode()) throw new Error("This browser can't encode video. Use Kerf's desktop app, or a current Chrome or Edge.");
  const bitrate = videoBitrate(width, height, fps);
  let video: CodecChoice["video"] | null = null;
  for (const codec of avcCodecs(width, height, fps)) {
    const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps, avc: { format: "avc" } }).catch(() => null);
    if (r?.supported) {
      video = { codec, kind: "avc", bitrate };
      break;
    }
  }
  if (!video)
    for (const codec of ["vp09.00.40.08", "vp09.00.50.08", "vp09.00.51.08", "vp09.00.61.08"]) {
      const r = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate: fps }).catch(() => null);
      if (r?.supported) {
        video = { codec, kind: "vp9", bitrate };
        break;
      }
    }
  if (!video) throw new Error(`This app can't encode ${width} × ${height} video at ${fps} frames a second. Try a smaller size.`);
  let audio: CodecChoice["audio"] = null;
  if (sound && typeof AudioEncoder !== "undefined") {
    for (const [codec, kind] of [
      ["mp4a.40.2", "aac"],
      ["opus", "opus"],
    ] as const) {
      const r = await AudioEncoder.isConfigSupported({ codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: 192000 }).catch(() => null);
      if (r?.supported) {
        audio = { codec, kind, bitrate: 192000 };
        break;
      }
    }
  }
  return { video, audio };
}

const copy = (b: AllowSharedBufferSource | undefined): Uint8Array | null => {
  if (!b) return null;
  if (b instanceof ArrayBuffer) return new Uint8Array(b.slice(0));
  const v = b as ArrayBufferView;
  return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
};

/** Frames in, an MP4 out. */
export class FilmEncoder {
  private video: VideoEncoder;
  private audio: AudioEncoder | null = null;
  private vSamples: Mp4Sample[] = [];
  private aSamples: Mp4Sample[] = [];
  private vConfig: Uint8Array | null = null;
  private aConfig: Uint8Array | null = null;
  private failed: Error | null = null;
  private aPts = 0;
  private frames = 0;
  readonly frameTicks: number;

  constructor(
    readonly choice: CodecChoice,
    readonly width: number,
    readonly height: number,
    readonly fps: number,
  ) {
    this.frameTicks = VIDEO_TIMESCALE / fps;
    this.video = new VideoEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !this.vConfig) this.vConfig = copy(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.vSamples.push({ data, pts: Math.round((chunk.timestamp * VIDEO_TIMESCALE) / 1e6), duration: this.frameTicks, key: chunk.type === "key" });
      },
      error: (e) => (this.failed = e instanceof Error ? e : new Error(String(e))),
    });
    const v = choice.video;
    this.video.configure({ codec: v.codec, width, height, bitrate: v.bitrate, framerate: fps, latencyMode: "quality", ...(v.kind === "avc" ? { avc: { format: "avc" } } : {}) });
  }

  private check() {
    if (this.failed) throw new Error(`The video encoder stopped: ${this.failed.message}`);
  }

  /** Encode the next frame from a canvas; waits while the encoder is behind. */
  async addFrame(source: HTMLCanvasElement | OffscreenCanvas) {
    this.check();
    while (this.video.encodeQueueSize > 4) {
      await new Promise((r) => setTimeout(r, 2));
      this.check();
    }
    const i = this.frames++;
    const frame = new VideoFrame(source, { timestamp: Math.round((i * 1e6) / this.fps), duration: Math.round(1e6 / this.fps) });
    try {
      this.video.encode(frame, { keyFrame: i % (this.fps * 2) === 0 });
    } finally {
      frame.close();
    }
  }

  /** Encode the soundtrack (stereo at 48 kHz). */
  async addAudio(buf: AudioBuffer) {
    const a = this.choice.audio;
    if (!a || typeof AudioEncoder === "undefined") return;
    this.audio = new AudioEncoder({
      output: (chunk, meta) => {
        if (meta?.decoderConfig?.description && !this.aConfig) this.aConfig = copy(meta.decoderConfig.description);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        const duration = Math.max(1, Math.round(((chunk.duration ?? (a.kind === "aac" ? (1024 / AUDIO_RATE) * 1e6 : 20000)) * AUDIO_RATE) / 1e6));
        this.aSamples.push({ data, pts: this.aPts, duration, key: true });
        this.aPts += duration;
      },
      error: (e) => (this.failed = e instanceof Error ? e : new Error(String(e))),
    });
    this.audio.configure({ codec: a.codec, sampleRate: AUDIO_RATE, numberOfChannels: 2, bitrate: a.bitrate });
    const step = 4800;
    const l = buf.getChannelData(0);
    const r = buf.numberOfChannels > 1 ? buf.getChannelData(1) : l;
    for (let at = 0; at < buf.length; at += step) {
      const n = Math.min(step, buf.length - at);
      const data = new Float32Array(n * 2);
      data.set(l.subarray(at, at + n), 0);
      data.set(r.subarray(at, at + n), n);
      const ad = new AudioData({ format: "f32-planar", sampleRate: AUDIO_RATE, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((at * 1e6) / AUDIO_RATE), data });
      try {
        this.audio.encode(ad);
      } finally {
        ad.close();
      }
      while (this.audio.encodeQueueSize > 8) await new Promise((res) => setTimeout(res, 1));
      this.check();
    }
    await this.audio.flush();
    this.check();
  }

  async finish(): Promise<Blob> {
    await this.video.flush();
    this.check();
    const v = this.choice.video;
    // audio no longer than the picture
    const videoEnd = this.frames * (AUDIO_RATE / this.fps);
    const audio = this.choice.audio && this.aSamples.length ? this.aSamples.filter((s) => s.pts < videoEnd) : [];
    return writeMp4(
      { codec: v.kind, width: this.width, height: this.height, timescale: VIDEO_TIMESCALE, config: this.vConfig, codecString: v.codec, samples: this.vSamples },
      audio.length ? { codec: this.choice.audio!.kind, sampleRate: AUDIO_RATE, channels: 2, config: this.aConfig, samples: audio } : null,
      this.choice.audio?.bitrate,
    );
  }

  close() {
    for (const e of [this.video, this.audio]) {
      try {
        if (e && e.state !== "closed") e.close();
      } catch {
        /* already closed */
      }
    }
  }
}
