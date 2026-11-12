// Where an app's data comes from. Three links, one store:
//   twin    the design's simulated twin, live (twinServe.ts in a worker)
//   usb     the real machine over a USB serial port (Web Serial: Chrome, Edge
//           and Kerf's desktop app)
//   replay  a finished simulation run played back
// Every link puts the firmware's lines into the store the same way, so a
// panel cannot tell the twin from the real machine except by the twin's own
// extra numbers.

import type { SignalStore } from "./store";
import type { TwinInfo, TwinOptions } from "./twin";
import type { TwinIn, TwinOut } from "./twinServe";

export type LinkKind = "twin" | "usb" | "replay";

export interface LinkStatus {
  state: "idle" | "connecting" | "live" | "paused" | "stopped" | "error";
  text: string;
  /** twin: simulated seconds a wall-clock second */
  rate?: number;
  behind?: boolean;
}

export interface Link {
  readonly kind: LinkKind;
  status: LinkStatus;
  onStatus?: (s: LinkStatus) => void;
  start(): Promise<void>;
  send(text: string): void;
  stop(): void;
  /** twin and replay: how fast time runs, and pausing it */
  speed?: number;
  setSpeed?(x: number): void;
  paused?: boolean;
  setPaused?(p: boolean): void;
  info?: TwinInfo;
}

abstract class Base {
  status: LinkStatus = { state: "idle", text: "" };
  onStatus?: (s: LinkStatus) => void;
  protected setStatus(s: LinkStatus) {
    this.status = s;
    this.onStatus?.(s);
  }
}

// ---------- the simulated twin ----------

export class TwinLink extends Base implements Link {
  readonly kind = "twin" as const;
  speed = 1;
  paused = false;
  info?: TwinInfo;
  private w: Worker | null = null;
  private t = 0;

  constructor(
    private store: SignalStore,
    private makeWorker: () => Worker,
    private opts: TwinOptions,
    private hello: string[],
  ) {
    super();
  }

  start(): Promise<void> {
    this.stop();
    this.setStatus({ state: "connecting", text: "starting the simulated twin…" });
    const w = this.makeWorker();
    this.w = w;
    return new Promise((resolve) => {
      w.onmessage = (ev: MessageEvent<TwinOut>) => {
        const m = ev.data;
        if (m.type === "ready") {
          this.info = m.info;
          this.store.note(0, `Simulated twin: ${m.info.firmware || "the firmware"} on a virtual ${m.info.boardName}, in the world of “${this.opts.spec.label ?? "the scenario"}”`);
          for (const h of this.hello) this.send(h);
          this.setStatus({ state: "live", text: "simulated twin", rate: 1 });
          resolve();
        } else if (m.type === "tick") {
          this.t = m.t;
          for (const l of m.lines) this.store.lineOut(l.t, l.text);
          for (const e of m.events) this.store.event(e.t, e.kind === "warn" ? "fault" : "note", e.text);
          this.store.values(m.t, m.ch);
          if (this.status.state === "live" && (Math.abs((this.status.rate ?? 1) - m.rate) > 0.05 || this.status.behind !== m.behind)) this.setStatus({ ...this.status, rate: m.rate, behind: m.behind });
        } else if (m.type === "stopped") {
          for (const l of m.lines) this.store.lineOut(l.t, l.text);
          this.store.note(m.t, `The twin stopped: ${m.reason}${m.error ? ` (${m.error})` : ""}`);
          this.setStatus({ state: "stopped", text: `twin stopped: ${m.reason}` });
          resolve();
        } else if (m.type === "error") {
          this.setStatus({ state: "error", text: m.message });
          resolve();
        }
      };
      w.onerror = (e) => {
        this.setStatus({ state: "error", text: e.message || "the twin's worker failed" });
        resolve();
      };
      this.post({ type: "start", opts: this.opts, speed: this.speed });
    });
  }

  private post(m: TwinIn) {
    this.w?.postMessage(m);
  }

  send(text: string) {
    this.post({ type: "type", text });
    this.store.lineIn(this.t, text);
  }

  setSpeed(x: number) {
    this.speed = x;
    this.post({ type: "speed", speed: x });
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.post({ type: "pause", paused: p });
    if (this.status.state === "live" || this.status.state === "paused") this.setStatus({ state: p ? "paused" : "live", text: p ? "twin paused" : "simulated twin", rate: this.status.rate });
  }

  stop() {
    if (!this.w) return;
    this.post({ type: "stop" });
    this.w.terminate();
    this.w = null;
    if (this.status.state !== "error") this.setStatus({ state: "idle", text: "" });
  }
}

// ---------- USB serial ----------

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

type SerialApi = { requestPort(o?: object): Promise<SerialPortLike> };

export const serialApi = (): SerialApi | undefined => (typeof navigator !== "undefined" ? (navigator as Navigator & { serial?: SerialApi }).serial : undefined);

export const USB_UNAVAILABLE = "This browser cannot open USB serial ports. Use Chrome or Edge on a computer, or Kerf's desktop app.";

export class SerialLink extends Base implements Link {
  readonly kind = "usb" as const;
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private t0 = 0;
  private closing = false;

  constructor(
    private store: SignalStore,
    private baud: number,
    private hello: string[],
  ) {
    super();
  }

  private now() {
    return (performance.now() - this.t0) / 1000;
  }

  async start(): Promise<void> {
    const api = serialApi();
    if (!api) {
      this.setStatus({ state: "error", text: USB_UNAVAILABLE });
      return;
    }
    this.setStatus({ state: "connecting", text: "pick the machine's port…" });
    let port: SerialPortLike;
    try {
      port = await api.requestPort();
    } catch (e) {
      // closing the picker is not a failure
      this.setStatus((e as Error).name === "NotFoundError" ? { state: "idle", text: "" } : { state: "error", text: (e as Error).message });
      return;
    }
    try {
      await port.open({ baudRate: this.baud });
    } catch (e) {
      this.setStatus({ state: "error", text: `Could not open the port at ${this.baud} baud: ${(e as Error).message}. Is another program (the Arduino IDE's serial monitor) using it?` });
      return;
    }
    this.port = port;
    this.closing = false;
    this.t0 = performance.now();
    this.store.note(0, `USB serial open at ${this.baud} baud`);
    this.setStatus({ state: "live", text: `USB ${this.baud} baud` });
    this.writer = port.writable?.getWriter() ?? null;
    void this.readLoop(port);
    // opening the port resets most Arduino boards: let it start before sending anything
    if (this.hello.length) setTimeout(() => this.hello.forEach((h) => this.send(h)), 1800);
  }

  private async readLoop(port: SerialPortLike) {
    const dec = new TextDecoder();
    let buf = "";
    while (port.readable && !this.closing) {
      const reader = port.readable.getReader();
      this.reader = reader;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            this.store.lineOut(this.now(), line);
          }
          // a run-away line with no newline: show it in pieces
          if (buf.length > 2000) {
            this.store.lineOut(this.now(), buf);
            buf = "";
          }
        }
      } catch (e) {
        if (!this.closing) this.store.note(this.now(), `USB read failed: ${(e as Error).message}`);
      } finally {
        reader.releaseLock();
      }
      if (!this.closing) {
        // the cable came out, or the board reset hard
        this.store.note(this.now(), "The machine went away (USB unplugged?)");
        this.setStatus({ state: "stopped", text: "USB disconnected" });
        break;
      }
    }
  }

  send(text: string) {
    if (!this.writer) return;
    this.store.lineIn(this.now(), text);
    void this.writer.write(new TextEncoder().encode(text + "\n")).catch((e) => this.store.note(this.now(), `USB write failed: ${(e as Error).message}`));
  }

  stop() {
    this.closing = true;
    const port = this.port;
    this.port = null;
    void (async () => {
      await this.reader?.cancel().catch(() => undefined);
      try {
        this.writer?.releaseLock();
      } catch {
        // already released
      }
      await port?.close().catch(() => undefined);
    })();
    this.reader = null;
    this.writer = null;
    if (this.status.state !== "error") this.setStatus({ state: "idle", text: "" });
  }
}

// ---------- a finished run played back ----------

export interface ReplayRun {
  /** frame times, s */
  t: ArrayLike<number>;
  series: Record<string, ArrayLike<number>>;
  serial: { t: number; dir: "out" | "in"; text: string }[];
  label: string;
}

export class ReplayLink extends Base implements Link {
  readonly kind = "replay" as const;
  speed = 1;
  paused = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private simT = 0;
  private frame = 0;
  private line = 0;
  private last = 0;

  constructor(
    private store: SignalStore,
    private run: ReplayRun,
  ) {
    super();
  }

  get end() {
    const t = this.run.t;
    return t.length ? t[t.length - 1] : 0;
  }

  async start() {
    this.stop();
    this.simT = 0;
    this.frame = 0;
    this.line = 0;
    this.store.note(0, `Playing back the simulation run “${this.run.label}” (${Math.round(this.end)} s)`);
    this.last = performance.now();
    this.timer = setInterval(() => this.step(), 33);
    this.setStatus({ state: "live", text: "replaying a run" });
  }

  private step() {
    const now = performance.now();
    const dt = ((now - this.last) / 1000) * (this.paused ? 0 : this.speed);
    this.last = now;
    this.simT = Math.min(this.end, this.simT + dt);
    const { t, series, serial } = this.run;
    while (this.line < serial.length && serial[this.line].t <= this.simT) {
      const l = serial[this.line++];
      if (l.dir === "out") this.store.lineOut(l.t, l.text);
      else this.store.lineIn(l.t, l.text);
    }
    let rec: Record<string, number> | null = null;
    while (this.frame < t.length && t[this.frame] <= this.simT) {
      rec = {};
      for (const [k, v] of Object.entries(series)) rec[k] = v[this.frame];
      this.store.values(t[this.frame], rec);
      this.frame++;
    }
    if (this.simT >= this.end && this.frame >= t.length) {
      this.store.note(this.end, "End of the recorded run");
      this.stop();
      this.setStatus({ state: "stopped", text: "replay finished" });
    }
  }

  send(text: string) {
    // a recording cannot answer: say so in the console
    this.store.lineIn(this.simT, text);
    this.store.note(this.simT, "A replayed run cannot take commands: use the simulated twin or the real machine");
  }

  setSpeed(x: number) {
    this.speed = x;
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.setStatus({ state: p ? "paused" : "live", text: p ? "replay paused" : "replaying a run" });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.status.state === "live" || this.status.state === "paused") this.setStatus({ state: "idle", text: "" });
  }
}
