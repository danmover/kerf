// Plays a simulated preamp output the way the amp would: the power amp board
// clips softly at full power, then an open-back 10" speaker and a small room.
// Levels are relative to the power amp's full power, so a quiet setting
// sounds quiet and a cranked one clips.

let ctx: AudioContext | null = null;
let playing: { src: AudioBufferSourceNode; cab: GainNode; di: GainNode; started: number; dur: number } | null = null;
let room: AudioBuffer | null = null;

function audio(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** The power amp's clipping: linear to 85 % of full power, then a smooth knee to full. The input is ±2 × full power. */
function powerAmpCurve(): Float32Array<ArrayBuffer> {
  const n = 2048;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = ((i / (n - 1)) * 2 - 1) * 2;
    const a = Math.abs(v);
    const knee = 0.85;
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = Math.sign(v) * y * 0.9;
  }
  return c;
}

/** A short, plain room: decaying noise, a little brighter at the start. */
function roomImpulse(ac: AudioContext): AudioBuffer {
  if (room && room.sampleRate === ac.sampleRate) return room;
  const len = Math.round(ac.sampleRate * 0.45);
  const b = ac.createBuffer(2, len, ac.sampleRate);
  let s = 1;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = rand() * Math.exp(-i / (ac.sampleRate * 0.09)) * (i < 40 ? i / 40 : 1);
  }
  room = b;
  return b;
}

/** The speaker in its open-back cabinet, as filters: bass lost round the open back, a cone peak, and the roll-off of a 10" guitar speaker. */
function cabinet(ac: AudioContext): { input: AudioNode; output: AudioNode } {
  const f = (type: BiquadFilterType, hz: number, q: number, gain = 0) => {
    const n = ac.createBiquadFilter();
    n.type = type;
    n.frequency.value = hz;
    n.Q.value = q;
    n.gain.value = gain;
    return n;
  };
  const chain = [f("highpass", 85, 0.8), f("peaking", 120, 1.1, 3), f("peaking", 2300, 1.3, 4.5), f("lowpass", 4800, 0.9), f("lowpass", 6500, 0.7)];
  for (let i = 0; i + 1 < chain.length; i++) chain[i].connect(chain[i + 1]);
  const out = ac.createGain();
  const dry = ac.createGain();
  const wet = ac.createGain();
  const conv = ac.createConvolver();
  conv.buffer = roomImpulse(ac);
  dry.gain.value = 0.85;
  wet.gain.value = 0.2;
  chain[chain.length - 1].connect(dry).connect(out);
  chain[chain.length - 1].connect(conv).connect(wet).connect(out);
  return { input: chain[0], output: out };
}

export function stopSound() {
  if (!playing) return;
  try {
    playing.src.stop();
  } catch {
    // already stopped
  }
  playing = null;
}

/**
 * Play preamp output volts (at sample rate fs). `fullPower` is the preamp
 * output that drives the power amp to full power.
 */
export function playSound(volts: Float32Array, fs: number, fullPower: number, opts: { cab: boolean; onEnd?: () => void }) {
  stopSound();
  const ac = audio();
  const buf = ac.createBuffer(1, volts.length, fs);
  const d = buf.getChannelData(0);
  const k = 1 / (2 * Math.max(1e-3, fullPower));
  // the preamp output sits on a DC level after its coupling capacitor settles: remove it
  let mean = 0;
  for (let i = 0; i < volts.length; i++) mean += volts[i];
  mean /= Math.max(1, volts.length);
  for (let i = 0; i < volts.length; i++) d[i] = (volts[i] - mean) * k;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const shaper = ac.createWaveShaper();
  shaper.curve = powerAmpCurve();
  shaper.oversample = "4x";
  const cabGain = ac.createGain();
  const diGain = ac.createGain();
  const master = ac.createGain();
  master.gain.value = 0.8;
  const cab = cabinet(ac);
  src.connect(shaper);
  shaper.connect(cabGain).connect(cab.input);
  cab.output.connect(master);
  shaper.connect(diGain).connect(master);
  master.connect(ac.destination);
  cabGain.gain.value = opts.cab ? 1 : 0;
  diGain.gain.value = opts.cab ? 0 : 0.6;
  src.onended = () => {
    if (playing?.src === src) playing = null;
    opts.onEnd?.();
  };
  src.start();
  playing = { src, cab: cabGain, di: diGain, started: ac.currentTime, dur: buf.duration };
}

/** Switch the speaker cabinet in or out while a take plays. */
export function setCabinet(on: boolean) {
  if (!playing || !ctx) return;
  const t = ctx.currentTime;
  playing.cab.gain.setTargetAtTime(on ? 1 : 0, t, 0.02);
  playing.di.gain.setTargetAtTime(on ? 0 : 0.6, t, 0.02);
}

/** How far through the playing take, 0..1, or undefined when nothing plays. */
export function playPosition(): number | undefined {
  if (!playing || !ctx) return undefined;
  return Math.min(1, (ctx.currentTime - playing.started) / playing.dur);
}
