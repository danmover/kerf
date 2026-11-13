// Mike McCauley's AccelStepper (1.64) and its MultiStepper, ported line for line: the same speed ramp (David
// Austin's equations, c0 = 0.676·√(2/a)·10⁶ µs, then cn − 2cn/(4n + 1)), the same micros() timing in runSpeed(),
// the same pin patterns for a step/direction driver and for 2, 3 and 4-wire motors, and float arithmetic as the
// chip does it. Each call takes the time the real one does: about 7 µs to check, and on an Uno about 150 µs to
// work out the next speed after a step, which is why AccelStepper tops out near 4000 steps a second there.

import type { Pos } from "./ast";
import { BOOL } from "./ctypes";
import type { Ctx } from "./ir";
import { argCount, burn, def, dict, fnEv, method, numEv, ptrEv, sumCost, type LibClass, type LibFn, type LibMethod } from "./libBase";
import type { FnRef, Hal, Ptr } from "./vm";

const FUNCTION = 0;
const DRIVER = 1;
const FULL2WIRE = 2;
const FULL3WIRE = 3;
const FULL4WIRE = 4;
const HALF3WIRE = 6;
const HALF4WIRE = 8;
const CW = 1;
const CCW = 0;

const f32 = Math.fround;
/** a float converted to a long or unsigned long: towards zero */
const toLong = (v: number) => (Number.isFinite(v) ? Math.trunc(v) | 0 : 0);
const toULong = (v: number) => (Number.isFinite(v) && v > 0 ? Math.trunc(v) >>> 0 : 0);

export interface StepperObj {
  kind: "AccelStepper";
  iface: number;
  pins: number[];
  inverted: number[];
  enablePin: number;
  enableInverted: number;
  currentPos: number;
  targetPos: number;
  speed: number;
  maxSpeed: number;
  acceleration: number;
  stepInterval: number;
  minPulseWidth: number;
  lastStepTime: number;
  n: number;
  c0: number;
  cn: number;
  cmin: number;
  direction: number;
  forward: FnRef | null;
  backward: FnRef | null;
}

/** cycles of float work, AVR (no FPU) and ESP32 */
const cost = (hal: Hal, avr: number) => (hal.arch === "esp32" ? avr / 8 : avr);

function pinWrite(hal: Hal, pin: number, v: number) {
  hal.digitalWrite(pin, v);
  burn(hal, hal.arch === "esp32" ? 30 : 56);
}

function setOutputPins(hal: Hal, s: StepperObj, mask: number) {
  const n = s.iface === FULL4WIRE || s.iface === HALF4WIRE ? 4 : s.iface === FULL3WIRE || s.iface === HALF3WIRE ? 3 : 2;
  for (let i = 0; i < n; i++) pinWrite(hal, s.pins[i], (mask & (1 << i) ? 1 : 0) ^ s.inverted[i]);
}

const STEP2 = [0b10, 0b11, 0b01, 0b00];
const STEP3 = [0b100, 0b001, 0b010];
const STEP4 = [0b0101, 0b0110, 0b1010, 0b1001];
const STEP6 = [0b100, 0b101, 0b001, 0b011, 0b010, 0b110];
const STEP8 = [0b0001, 0b0101, 0b0100, 0b0110, 0b0010, 0b1010, 0b1000, 0b1001];
/** C's % on a long: the sign of the dividend */
const mod = (a: number, b: number) => a % b;

function step(hal: Hal, s: StepperObj, pos: number) {
  switch (s.iface) {
    case FUNCTION:
      (s.speed > 0 ? s.forward : s.backward)?.call([]);
      break;
    case DRIVER:
      // direction first, else rogue pulses; then the step pulse for the minimum width
      setOutputPins(hal, s, s.direction ? 0b10 : 0b00);
      setOutputPins(hal, s, s.direction ? 0b11 : 0b01);
      hal.spend((s.minPulseWidth * hal.fcpu) / 1e6);
      setOutputPins(hal, s, s.direction ? 0b10 : 0b00);
      break;
    case FULL2WIRE:
      setOutputPins(hal, s, STEP2[pos & 3]);
      break;
    case FULL3WIRE:
      setOutputPins(hal, s, STEP3[Math.abs(mod(pos, 3))] ?? 0);
      break;
    case FULL4WIRE:
      setOutputPins(hal, s, STEP4[pos & 3]);
      break;
    case HALF3WIRE:
      setOutputPins(hal, s, STEP6[Math.abs(mod(pos, 6))] ?? 0);
      break;
    case HALF4WIRE:
      setOutputPins(hal, s, STEP8[pos & 7]);
      break;
  }
}

function computeNewSpeed(hal: Hal, s: StepperObj): number {
  burn(hal, cost(hal, 2400));
  const distanceTo = (s.targetPos - s.currentPos) | 0;
  const stepsToStop = toLong(f32(f32(s.speed * s.speed) / f32(2 * s.acceleration)));
  if (distanceTo === 0 && stepsToStop <= 1) {
    s.stepInterval = 0;
    s.speed = 0;
    s.n = 0;
    return 0;
  }
  if (distanceTo > 0) {
    if (s.n > 0) {
      if (stepsToStop >= distanceTo || s.direction === CCW) s.n = -stepsToStop;
    } else if (s.n < 0) {
      if (stepsToStop < distanceTo && s.direction === CW) s.n = -s.n;
    }
  } else if (distanceTo < 0) {
    if (s.n > 0) {
      if (stepsToStop >= -distanceTo || s.direction === CW) s.n = -stepsToStop;
    } else if (s.n < 0) {
      if (stepsToStop < -distanceTo && s.direction === CCW) s.n = -s.n;
    }
  }
  if (s.n === 0) {
    s.cn = s.c0;
    s.direction = distanceTo > 0 ? CW : CCW;
  } else {
    s.cn = f32(s.cn - f32(f32(2 * s.cn) / f32(4 * s.n + 1)));
    s.cn = Math.max(s.cn, s.cmin);
  }
  s.n = (s.n + 1) | 0;
  s.stepInterval = toULong(s.cn);
  s.speed = f32(1e6 / s.cn);
  if (s.direction === CCW) s.speed = -s.speed;
  return s.stepInterval;
}

function runSpeed(hal: Hal, s: StepperObj): boolean {
  if (!s.stepInterval) {
    burn(hal, 12);
    return false;
  }
  const time = hal.micros() >>> 0;
  burn(hal, cost(hal, 90));
  if (((time - s.lastStepTime) >>> 0) >= s.stepInterval) {
    s.currentPos = (s.currentPos + (s.direction === CW ? 1 : -1)) | 0;
    step(hal, s, s.currentPos);
    s.lastStepTime = time;
    return true;
  }
  return false;
}

function run(hal: Hal, s: StepperObj): boolean {
  if (runSpeed(hal, s)) computeNewSpeed(hal, s);
  return s.speed !== 0 || s.targetPos !== s.currentPos;
}

function moveTo(hal: Hal, s: StepperObj, absolute: number) {
  if (s.targetPos !== absolute) {
    s.targetPos = absolute | 0;
    computeNewSpeed(hal, s);
  }
}

function setMaxSpeed(hal: Hal, s: StepperObj, speed: number) {
  speed = f32(Math.abs(speed));
  if (s.maxSpeed !== speed) {
    s.maxSpeed = speed;
    s.cmin = f32(1e6 / speed);
    if (s.n > 0) {
      s.n = toLong(f32(f32(s.speed * s.speed) / f32(2 * s.acceleration)));
      computeNewSpeed(hal, s);
    }
  }
}

function setAcceleration(hal: Hal, s: StepperObj, a: number) {
  if (a === 0) return;
  a = f32(Math.abs(a));
  if (s.acceleration !== a) {
    s.n = toLong(s.n * f32(s.acceleration / a));
    s.c0 = f32(0.676 * Math.sqrt(2 / a) * 1e6);
    s.acceleration = a;
    computeNewSpeed(hal, s);
  }
}

function setSpeed(s: StepperObj, speed: number) {
  speed = f32(speed);
  if (speed === s.speed) return;
  speed = Math.min(Math.max(speed, -s.maxSpeed), s.maxSpeed);
  if (speed === 0) s.stepInterval = 0;
  else {
    s.stepInterval = toULong(Math.abs(f32(1e6 / speed)));
    s.direction = speed > 0 ? CW : CCW;
  }
  s.speed = speed;
}

function enableOutputs(hal: Hal, s: StepperObj) {
  if (!s.iface) return;
  hal.pinMode(s.pins[0], 1);
  hal.pinMode(s.pins[1], 1);
  if (s.iface === FULL4WIRE || s.iface === HALF4WIRE) {
    hal.pinMode(s.pins[2], 1);
    hal.pinMode(s.pins[3], 1);
  } else if (s.iface === FULL3WIRE || s.iface === HALF3WIRE) hal.pinMode(s.pins[2], 1);
  if (s.enablePin !== 0xff) {
    hal.pinMode(s.enablePin, 1);
    pinWrite(hal, s.enablePin, 1 ^ s.enableInverted);
  }
}

function disableOutputs(hal: Hal, s: StepperObj) {
  if (!s.iface) return;
  setOutputPins(hal, s, 0);
  if (s.enablePin !== 0xff) {
    hal.pinMode(s.enablePin, 1);
    pinWrite(hal, s.enablePin, 0 ^ s.enableInverted);
  }
}

function newStepper(): StepperObj {
  return {
    kind: "AccelStepper",
    iface: FULL4WIRE,
    pins: [2, 3, 4, 5],
    inverted: [0, 0, 0, 0],
    enablePin: 0xff,
    enableInverted: 0,
    currentPos: 0,
    targetPos: 0,
    speed: 0,
    maxSpeed: 0,
    acceleration: 0,
    stepInterval: 0,
    minPulseWidth: 1,
    lastStepTime: 0,
    n: 0,
    c0: 0,
    cn: 0,
    cmin: 1,
    direction: CCW,
    forward: null,
    backward: null,
  };
}

/** the constructor's own work: outputs on, then "some reasonable default" of 1 step/s² and 1 step/s */
function setUp(hal: Hal, s: StepperObj, enable: boolean) {
  if (enable) enableOutputs(hal, s);
  setAcceleration(hal, s, 1);
  setMaxSpeed(hal, s, 1);
}

const T = { k: "class" as const, name: "AccelStepper" };

/** AccelStepper(interface = FULL4WIRE, pin1 = 2, pin2 = 3, pin3 = 4, pin4 = 5, enable = true), or (forward, backward) */
const construct: LibFn = (args, ctx, pos) => {
  if (args.length > 6) argCount("AccelStepper", 0, 6, args.length, ctx, pos);
  const hal = ctx.hal;
  const fnArgs = args.length === 2 && args.every((a) => a.t.k === "fn" || (a.t.k === "ptr" && a.t.to.k === "fn"));
  if (fnArgs) {
    const [F, B] = args.map((a) => fnEv(a, ctx, "AccelStepper()"));
    return {
      t: T,
      ev: (f) => {
        const s = newStepper();
        s.iface = FUNCTION;
        s.forward = F(f) as FnRef;
        s.backward = B(f) as FnRef;
        setUp(hal, s, true);
        return s;
      },
      cost: sumCost(args) + 100,
      pos,
    };
  }
  const defaults = [FULL4WIRE, 2, 3, 4, 5, 1];
  const A = args.map((a, i) => numEv(a, i === 5 ? BOOL : ctx.T.uchar, ctx, "AccelStepper()"));
  return {
    t: T,
    ev: (f) => {
      const v = defaults.map((d, i) => (i < A.length ? (A[i](f) as number) : d));
      const s = newStepper();
      s.iface = v[0];
      s.pins = v.slice(1, 5);
      if (![FUNCTION, DRIVER, FULL2WIRE, FULL3WIRE, FULL4WIRE, HALF3WIRE, HALF4WIRE].includes(s.iface))
        hal.fault(`AccelStepper(${s.iface}, ...): ${s.iface} is not one of its interfaces (AccelStepper::DRIVER is 1, FULL4WIRE 4, HALF4WIRE 8), so it never steps`, "firmware", 0);
      setUp(hal, s, v[5] !== 0);
      return s;
    },
    cost: sumCost(args) + 100,
    pos,
  };
};

type MethodRun = (s: StepperObj, v: number[], ctx: Ctx, pos: Pos) => unknown;
const m = (name: string, params: Parameters<typeof method>[2], ret: Parameters<typeof method>[3], cyc: number, run: MethodRun, defaults: unknown[] = []) =>
  method<StepperObj>("AccelStepper", name, params, ret, cyc, run, defaults);

const stepperMethods: Record<string, LibMethod> = {
  moveTo: m("moveTo", ["long"], "void", 20, (s, [a], ctx) => moveTo(ctx.hal, s, a)),
  move: m("move", ["long"], "void", 24, (s, [r], ctx) => moveTo(ctx.hal, s, (s.currentPos + r) | 0)),
  run: m("run", [], "bool", 8, (s, _v, ctx) => run(ctx.hal, s)),
  runSpeed: m("runSpeed", [], "bool", 8, (s, _v, ctx) => runSpeed(ctx.hal, s)),
  setMaxSpeed: m("setMaxSpeed", ["float"], "void", 30, (s, [v], ctx) => setMaxSpeed(ctx.hal, s, v)),
  maxSpeed: m("maxSpeed", [], "float", 8, (s) => s.maxSpeed),
  setAcceleration: m("setAcceleration", ["float"], "void", 30, (s, [v], ctx) => {
    burn(ctx.hal, cost(ctx.hal, 900));
    setAcceleration(ctx.hal, s, v);
  }),
  acceleration: m("acceleration", [], "float", 8, (s) => s.acceleration),
  setSpeed: m("setSpeed", ["float"], "void", 30, (s, [v], ctx) => {
    burn(ctx.hal, cost(ctx.hal, 500));
    setSpeed(s, v);
  }),
  speed: m("speed", [], "float", 8, (s) => s.speed),
  distanceToGo: m("distanceToGo", [], "long", 12, (s) => (s.targetPos - s.currentPos) | 0),
  targetPosition: m("targetPosition", [], "long", 8, (s) => s.targetPos),
  currentPosition: m("currentPosition", [], "long", 8, (s) => s.currentPos),
  setCurrentPosition: m("setCurrentPosition", ["long"], "void", 20, (s, [p]) => {
    s.targetPos = s.currentPos = p | 0;
    s.n = 0;
    s.stepInterval = 0;
    s.speed = 0;
  }),
  runToPosition: m("runToPosition", [], "void", 10, (s, _v, ctx) => {
    while (run(ctx.hal, s));
  }),
  runSpeedToPosition: m("runSpeedToPosition", [], "bool", 16, (s, _v, ctx) => {
    if (s.targetPos === s.currentPos) return false;
    s.direction = s.targetPos > s.currentPos ? CW : CCW;
    return runSpeed(ctx.hal, s);
  }),
  runToNewPosition: m("runToNewPosition", ["long"], "void", 20, (s, [p], ctx) => {
    moveTo(ctx.hal, s, p);
    while (run(ctx.hal, s));
  }),
  stop: m("stop", [], "void", 30, (s, _v, ctx) => {
    if (s.speed !== 0) {
      burn(ctx.hal, cost(ctx.hal, 700));
      const stepsToStop = toLong(f32(f32(s.speed * s.speed) / f32(2 * s.acceleration))) + 1;
      moveTo(ctx.hal, s, (s.currentPos + (s.speed > 0 ? stepsToStop : -stepsToStop)) | 0);
    }
  }),
  disableOutputs: m("disableOutputs", [], "void", 20, (s, _v, ctx) => disableOutputs(ctx.hal, s)),
  enableOutputs: m("enableOutputs", [], "void", 20, (s, _v, ctx) => enableOutputs(ctx.hal, s)),
  setMinPulseWidth: m("setMinPulseWidth", ["uint"], "void", 8, (s, [w]) => (s.minPulseWidth = w)),
  setEnablePin: m(
    "setEnablePin",
    ["u8"],
    "void",
    20,
    (s, [p], ctx) => {
      s.enablePin = p;
      if (p !== 0xff) {
        ctx.hal.pinMode(p, 1);
        pinWrite(ctx.hal, p, 1 ^ s.enableInverted);
      }
    },
    [0xff],
  ),
  setPinsInverted: (obj, args, ctx, pos) => {
    // (direction, step, enable) or (pin1, pin2, pin3, pin4, enable)
    if (args.length > 5) argCount("AccelStepper.setPinsInverted", 0, 5, args.length, ctx, pos);
    const five = args.length >= 4;
    const run = five
      ? m("setPinsInverted", ["bool", "bool", "bool", "bool", "bool"], "void", 20, (s, v) => {
          s.inverted = v.slice(0, 4).map((x) => (x ? 1 : 0));
          s.enableInverted = v[4] ? 1 : 0;
        }, [0])
      : m("setPinsInverted", ["bool", "bool", "bool"], "void", 20, (s, [dir, stp, en]) => {
          s.inverted[0] = stp ? 1 : 0;
          s.inverted[1] = dir ? 1 : 0;
          s.enableInverted = en ? 1 : 0;
        }, [0, 0, 0]);
    return run(obj, args, ctx, pos);
  },
  isRunning: m("isRunning", [], "bool", 12, (s) => !(s.speed === 0 && s.targetPos === s.currentPos)),
  stepForward: m("stepForward", [], "long", 20, (s, _v, ctx) => {
    s.currentPos = (s.currentPos + 1) | 0;
    step(ctx.hal, s, s.currentPos);
    s.lastStepTime = ctx.hal.micros() >>> 0;
    return s.currentPos;
  }),
  stepBackward: m("stepBackward", [], "long", 20, (s, _v, ctx) => {
    s.currentPos = (s.currentPos - 1) | 0;
    step(ctx.hal, s, s.currentPos);
    s.lastStepTime = ctx.hal.micros() >>> 0;
    return s.currentPos;
  }),
};

export const accelStepperClass: LibClass = {
  construct,
  // `AccelStepper stepper;`: four wires on pins 2 to 5; its constructor sets the pins up before setup() runs
  make: (ctx) => defaultStepper(ctx.hal),
  methods: dict(stepperMethods),
};

// ---------- MultiStepper ----------

const MAX_STEPPERS = 10;

export interface MultiObj {
  kind: "MultiStepper";
  steppers: StepperObj[];
}

const mm = (name: string, params: Parameters<typeof method>[2], ret: Parameters<typeof method>[3], cyc: number, run: (o: MultiObj, v: unknown[], ctx: Ctx, pos: Pos) => unknown) => method<MultiObj>("MultiStepper", name, params, ret, cyc, run);

function multiRun(hal: Hal, o: MultiObj): boolean {
  let ret = false;
  for (const s of o.steppers) {
    burn(hal, 20);
    if (s.targetPos !== s.currentPos) {
      runSpeed(hal, s);
      ret = true;
    }
  }
  return ret;
}

export const multiStepperClass: LibClass = {
  make: (): MultiObj => ({ kind: "MultiStepper", steppers: [] }),
  methods: dict<LibMethod>({
    addStepper: mm("addStepper", ["obj"], "bool", 20, (o, [s]) => {
      if (o.steppers.length >= MAX_STEPPERS) return false;
      o.steppers.push(s as StepperObj);
      return true;
    }),
    moveTo: (obj, args, ctx, pos) => {
      if (args.length !== 1) argCount("MultiStepper.moveTo", 1, 1, args.length, ctx, pos);
      const O = obj.lv ? obj.lv.get : obj.ev;
      const P = ptrEv(args[0], ctx, "MultiStepper.moveTo()");
      return {
        t: { k: "void" },
        ev: (f) => {
          const o = O(f) as MultiObj;
          const p = P(f) as Ptr;
          const hal = ctx.hal;
          const target = (i: number) => (Number(p.m[p.i + i] ?? 0) | 0);
          burn(hal, cost(hal, 600) * o.steppers.length);
          let longest = 0;
          o.steppers.forEach((s, i) => {
            const t = f32(Math.abs((target(i) - s.currentPos) | 0) / s.maxSpeed);
            if (t > longest) longest = t;
          });
          if (longest > 0)
            o.steppers.forEach((s, i) => {
              const dist = (target(i) - s.currentPos) | 0;
              const speed = f32(dist / longest);
              moveTo(hal, s, target(i));
              setSpeed(s, speed);
            });
        },
        cost: sumCost(args) + 40,
        pos,
      };
    },
    run: mm("run", [], "bool", 10, (o, _v, ctx) => multiRun(ctx.hal, o)),
    runSpeedToPosition: mm("runSpeedToPosition", [], "void", 10, (o, _v, ctx) => {
      while (multiRun(ctx.hal, o));
    }),
  }),
};

/** AccelStepper::DRIVER and the rest, as the class's enums */
export const stepperScoped: Record<string, LibFn> = Object.fromEntries(
  Object.entries({ FUNCTION, DRIVER, FULL2WIRE, FULL3WIRE, FULL4WIRE, HALF3WIRE, HALF4WIRE, DIRECTION_CCW: CCW, DIRECTION_CW: CW }).map(([k, v]) => [`AccelStepper::${k}`, def(`AccelStepper::${k}`, [], "int", 0, () => v)]),
);

/** for the default constructor (`AccelStepper stepper;`), which also runs its set-up */
export function defaultStepper(hal: Hal): StepperObj {
  const s = newStepper();
  setUp(hal, s, true);
  return s;
}

