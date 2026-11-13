// Timer libraries: TimerOne (Paul Stoffregen's, for the Uno and Nano) and the ESP32 core's hardware timers (core
// 3.x: timerBegin(frequency), timerAttachInterrupt, timerAlarm). TimerOne does what the library does, through timer
// 1's registers, so the board's timer model makes its interrupt and PWM; the ESP32 calls go to the board's timers.

import type { Pos } from "./ast";
import { VOID } from "./ctypes";
import type { C, Ctx } from "./ir";
import { argCount, def, dict, fnEv, numEv, ptrEv, sumCost, type LibFn } from "./libBase";
import type { FnRef, Ptr } from "./vm";

// ---------- TimerOne ----------

const TIMER1_RESOLUTION = 65536;
const WGM13 = 1 << 4;
const CS10 = 1;
const CS11 = 2;
const CS12 = 4;
const COM1A1 = 1 << 7;
const COM1B1 = 1 << 5;
const TOIE1 = 1;

/** the library's own state: the clock-select bits and the period setPeriod() chose */
export interface TimerOneState {
  cs: number;
  period: number;
}

function reg(ctx: Ctx, name: string) {
  const r = ctx.hal.register?.(name);
  if (!r) throw new Error(`TimerOne needs ${name}`);
  return r;
}

function avrOnly(ctx: Ctx, pos: Pos) {
  if (!ctx.hal.register?.("TCCR1B")) ctx.error("TimerOne drives the ATmega328P's timer 1 (Uno, Nano): this board has no such timer. On the ESP32 use timerBegin() and timerAlarm()", pos);
}

function setPeriod(ctx: Ctx, us: number) {
  const st = ctx.lib.timerOne;
  // phase and frequency correct PWM counts up to ICR1 and back, so a period is two counts of ICR1
  const cycles = Math.floor((Math.floor(ctx.hal.fcpu / 100000) * us) / 20);
  if (cycles < TIMER1_RESOLUTION) [st.cs, st.period] = [CS10, cycles];
  else if (cycles < TIMER1_RESOLUTION * 8) [st.cs, st.period] = [CS11, Math.floor(cycles / 8)];
  else if (cycles < TIMER1_RESOLUTION * 64) [st.cs, st.period] = [CS11 | CS10, Math.floor(cycles / 64)];
  else if (cycles < TIMER1_RESOLUTION * 256) [st.cs, st.period] = [CS12, Math.floor(cycles / 256)];
  else if (cycles < TIMER1_RESOLUTION * 1024) [st.cs, st.period] = [CS12 | CS10, Math.floor(cycles / 1024)];
  else [st.cs, st.period] = [CS12 | CS10, TIMER1_RESOLUTION - 1];
  reg(ctx, "ICR1").write(st.period);
  reg(ctx, "TCCR1B").write(WGM13 | st.cs);
}

function setPwmDuty(ctx: Ctx, pin: number, duty: number) {
  const v = Math.floor((ctx.lib.timerOne.period * duty) / 1024);
  if (pin === 9) reg(ctx, "OCR1A").write(v);
  else if (pin === 10) reg(ctx, "OCR1B").write(v);
}

function pwm(ctx: Ctx, pin: number, duty: number) {
  const a = reg(ctx, "TCCR1A");
  if (pin === 9 || pin === 10) {
    ctx.hal.pinMode(pin, 1);
    a.write(a.read() | (pin === 9 ? COM1A1 : COM1B1));
  } else ctx.hal.fault(`Timer1.pwm(${pin}): TimerOne makes PWM on pins 9 and 10 only (timer 1's outputs on the Uno and Nano)`, "firmware", 0);
  setPwmDuty(ctx, pin, duty);
  reg(ctx, "TCCR1B").write(WGM13 | ctx.lib.timerOne.cs);
}

/** a method taking a function and maybe a period (attachInterrupt) */
function attach(name: string): LibFn {
  return (args, ctx, pos) => {
    if (args.length < 1 || args.length > 2) argCount(`Timer1.${name}`, 1, 2, args.length, ctx, pos);
    avrOnly(ctx, pos);
    const F = fnEv(args[0], ctx, `Timer1.${name}()`);
    const U = args[1] ? numEv(args[1], ctx.T.ulong, ctx, `Timer1.${name}()`) : null;
    return {
      t: VOID,
      ev: (f) => {
        const us = U ? (U(f) as number) : 0;
        if (us > 0) setPeriod(ctx, us);
        const fn = F(f) as FnRef | null;
        ctx.hal.setVector?.("TIMER1_OVF_vect", fn);
        reg(ctx, "TIMSK1").write(TOIE1);
      },
      cost: sumCost(args) + 40,
      pos,
    };
  };
}

const t1 = (name: string, params: Parameters<typeof def>[1], cyc: number, run: (v: number[], ctx: Ctx) => void, defaults: unknown[] = []): LibFn => {
  const d = def(`Timer1.${name}`, params, "void", cyc, (v, ctx) => run(v as number[], ctx), defaults);
  return (args: C[], ctx: Ctx, pos: Pos) => {
    avrOnly(ctx, pos);
    return d(args, ctx, pos);
  };
};

export const timerOne: Record<string, LibFn> = dict<LibFn>({
  initialize: t1(
    "initialize",
    ["ulong"],
    60,
    ([us], ctx) => {
      reg(ctx, "TCCR1B").write(WGM13);
      reg(ctx, "TCCR1A").write(0);
      setPeriod(ctx, us);
    },
    [1_000_000],
  ),
  setPeriod: t1("setPeriod", ["ulong"], 60, ([us], ctx) => setPeriod(ctx, us)),
  start: t1("start", [], 20, (_v, ctx) => {
    reg(ctx, "TCCR1B").write(0);
    reg(ctx, "TCNT1").write(0);
    reg(ctx, "TCCR1B").write(WGM13 | ctx.lib.timerOne.cs);
  }),
  restart: t1("restart", [], 20, (_v, ctx) => {
    reg(ctx, "TCCR1B").write(0);
    reg(ctx, "TCNT1").write(0);
    reg(ctx, "TCCR1B").write(WGM13 | ctx.lib.timerOne.cs);
  }),
  stop: t1("stop", [], 10, (_v, ctx) => reg(ctx, "TCCR1B").write(WGM13)),
  resume: t1("resume", [], 10, (_v, ctx) => reg(ctx, "TCCR1B").write(WGM13 | ctx.lib.timerOne.cs)),
  pwm: t1("pwm", ["u8", "uint", "ulong"], 60, ([pin, duty, us], ctx) => {
    if (us > 0) setPeriod(ctx, us);
    pwm(ctx, pin, duty);
  }, [0]),
  setPwmDuty: t1("setPwmDuty", ["u8", "uint"], 30, ([pin, duty], ctx) => setPwmDuty(ctx, pin, duty)),
  disablePwm: t1("disablePwm", ["u8"], 20, ([pin], ctx) => {
    const a = reg(ctx, "TCCR1A");
    if (pin === 9) a.write(a.read() & ~COM1A1);
    else if (pin === 10) a.write(a.read() & ~COM1B1);
  }),
  attachInterrupt: attach("attachInterrupt"),
  detachInterrupt: t1("detachInterrupt", [], 10, (_v, ctx) => reg(ctx, "TIMSK1").write(0)),
});

// ---------- ESP32 hardware timers (core 3.x) ----------

/** the timer object behind a hw_timer_t pointer */
const timerOf = (p: unknown): object | null => {
  const q = p as Ptr | null;
  const t = q?.m?.[q.i] as { kind?: string } | undefined;
  return t && t.kind === "hw_timer" ? t : null;
};

/** the ESP32 core declares these; another board's build stops at the first one */
function espOnly(name: string, ctx: Ctx, pos: Pos) {
  if (!ctx.hal.hwTimers) ctx.error(`'${name}' was not declared in this scope: ${name}() is part of the ESP32 core. On the Uno or Nano use timer 1 (TimerOne, or its registers)`, pos);
}

function esp(name: string, params: Parameters<typeof def>[1], ret: Parameters<typeof def>[2], cyc: number, run: (v: unknown[], ctx: Ctx, pos: Pos) => unknown, defaults: unknown[] = []): LibFn {
  const d = def(name, params, ret, cyc, run, defaults);
  return (args, ctx, pos) => {
    espOnly(name, ctx, pos);
    return d(args, ctx, pos);
  };
}

/** the timer a call names; a NULL one is the crash it is on the chip */
function need(ctx: Ctx, p: unknown, what: string): object | null {
  const t = timerOf(p);
  if (!t) ctx.hal.fault(`${what}() on a NULL timer: timerBegin() failed or was never called, and on the chip this crashes`, "firmware", 0);
  return t;
}

const OLD_API: Record<string, string> = {
  timerAlarmWrite: "timerAlarm(timer, ticks, autoreload, 0)",
  timerAlarmEnable: "timerAlarm(timer, ticks, autoreload, 0), which also enables it",
  timerAlarmDisable: "timerStop(timer) or timerDetachInterrupt(timer)",
  timerSetDivider: "timerBegin(frequency)",
  timerGetConfig: "timerGetFrequency(timer)",
  timerReadMilis: "timerReadMillis(timer)",
  timerAlarmRead: "the alarm value you passed to timerAlarm()",
  timerAlarmReadMicros: "the alarm value you passed to timerAlarm(), over timerGetFrequency(timer)",
  timerGetAutoReload: "the autoreload you passed to timerAlarm()",
  timerSetAutoReload: "timerAlarm(timer, ticks, autoreload, 0)",
  timerSetCountUp: "nothing: a core 3.x timer always counts up",
  timerStarted: "your own flag, set where you call timerStart() and timerStop()",
};

export const espTimerFuncs: Record<string, LibFn> = dict<LibFn>({
  timerBegin: (args, ctx, pos) => {
    espOnly("timerBegin", ctx, pos);
    if (args.length === 3) ctx.error("timerBegin(num, divider, countUp) is the ESP32 core 2.x call; core 3.x takes timerBegin(frequency), e.g. timerBegin(1000000) for a 1 MHz count, then timerAttachInterrupt(timer, fn) and timerAlarm(timer, ticks, true, 0)", pos);
    if (args.length !== 1) argCount("timerBegin", 1, 1, args.length, ctx, pos);
    const F = numEv(args[0], ctx.T.ulong, ctx, "timerBegin()");
    return {
      t: { k: "ptr", to: VOID },
      ev: (f) => {
        const t = ctx.hal.hwTimers!.begin(F(f) as number);
        return t ? ({ m: [t], i: 0 } satisfies Ptr) : null;
      },
      cost: sumCost(args) + 600,
      pos,
    };
  },
  timerAttachInterrupt: (args, ctx, pos) => {
    espOnly("timerAttachInterrupt", ctx, pos);
    if (args.length === 3) ctx.error("timerAttachInterrupt(timer, fn, edge) is the ESP32 core 2.x call; core 3.x takes timerAttachInterrupt(timer, fn)", pos);
    if (args.length !== 2) argCount("timerAttachInterrupt", 2, 2, args.length, ctx, pos);
    const T = ptrEv(args[0], ctx, "timerAttachInterrupt()");
    const F = fnEv(args[1], ctx, "timerAttachInterrupt()");
    return {
      t: VOID,
      ev: (f) => {
        const t = need(ctx, T(f), "timerAttachInterrupt");
        if (t) ctx.hal.hwTimers?.attach(t, F(f) as FnRef | null);
      },
      cost: sumCost(args) + 400,
      pos,
    };
  },
  timerAttachInterruptArg: (args, ctx, pos) => {
    espOnly("timerAttachInterruptArg", ctx, pos);
    if (args.length !== 3) argCount("timerAttachInterruptArg", 3, 3, args.length, ctx, pos);
    const T = ptrEv(args[0], ctx, "timerAttachInterruptArg()");
    const F = fnEv(args[1], ctx, "timerAttachInterruptArg()");
    const A = ptrEv(args[2], ctx, "timerAttachInterruptArg()");
    return {
      t: VOID,
      ev: (f) => {
        const t = need(ctx, T(f), "timerAttachInterruptArg");
        if (t) ctx.hal.hwTimers?.attach(t, F(f) as FnRef | null, A(f));
      },
      cost: sumCost(args) + 400,
      pos,
    };
  },
  timerDetachInterrupt: esp("timerDetachInterrupt", ["ptr"], "void", 200, ([p], ctx) => {
    const t = need(ctx, p, "timerDetachInterrupt");
    if (t) ctx.hal.hwTimers!.detach(t);
  }),
  timerAlarm: esp("timerAlarm", ["ptr", "ulong", "bool", "ulong"], "void", 120, ([p, v, auto, n], ctx) => {
    const t = need(ctx, p, "timerAlarm");
    if (t) ctx.hal.hwTimers!.alarm(t, v as number, !!auto, n as number);
  }),
  timerStart: esp("timerStart", ["ptr"], "void", 40, ([p], ctx) => {
    const t = need(ctx, p, "timerStart");
    if (t) ctx.hal.hwTimers!.start(t);
  }),
  timerStop: esp("timerStop", ["ptr"], "void", 40, ([p], ctx) => {
    const t = need(ctx, p, "timerStop");
    if (t) ctx.hal.hwTimers!.stop(t);
  }),
  timerRestart: esp("timerRestart", ["ptr"], "void", 40, ([p], ctx) => {
    const t = need(ctx, p, "timerRestart");
    if (t) ctx.hal.hwTimers!.restart(t);
  }),
  timerWrite: esp("timerWrite", ["ptr", "ulong"], "void", 40, ([p, v], ctx) => {
    const t = need(ctx, p, "timerWrite");
    if (t) ctx.hal.hwTimers!.write(t, v as number);
  }),
  timerRead: esp("timerRead", ["ptr"], "ulong", 60, ([p], ctx) => {
    const t = need(ctx, p, "timerRead");
    return t ? ctx.hal.hwTimers!.read(t) : 0;
  }),
  // the core works these out from timerGetFrequency(), the whole-hertz rate
  timerReadMicros: esp("timerReadMicros", ["ptr"], "ulong", 80, ([p], ctx) => {
    const t = need(ctx, p, "timerReadMicros");
    return t ? Math.floor((ctx.hal.hwTimers!.read(t) * 1e6) / Math.floor(ctx.hal.hwTimers!.hz(t))) : 0;
  }),
  timerReadMillis: esp("timerReadMillis", ["ptr"], "ulong", 80, ([p], ctx) => {
    const t = need(ctx, p, "timerReadMillis");
    return t ? Math.floor((ctx.hal.hwTimers!.read(t) * 1e3) / Math.floor(ctx.hal.hwTimers!.hz(t))) : 0;
  }),
  timerReadSeconds: esp("timerReadSeconds", ["ptr"], "double", 80, ([p], ctx) => {
    const t = need(ctx, p, "timerReadSeconds");
    return t ? ctx.hal.hwTimers!.read(t) / Math.floor(ctx.hal.hwTimers!.hz(t)) : 0;
  }),
  timerGetFrequency: esp("timerGetFrequency", ["ptr"], "ulong", 20, ([p], ctx) => {
    const t = need(ctx, p, "timerGetFrequency");
    return t ? Math.floor(ctx.hal.hwTimers!.hz(t)) : 0;
  }),
  timerEnd: esp("timerEnd", ["ptr"], "void", 200, ([p], ctx) => {
    const t = need(ctx, p, "timerEnd");
    if (t) ctx.hal.hwTimers!.end(t);
  }),
  ...Object.fromEntries(
    Object.entries(OLD_API).map(([name, now]) => [
      name,
      ((_args, ctx, pos) => {
        espOnly(name, ctx, pos);
        ctx.error(`${name}() is from the ESP32 core 2.x and is gone in core 3.x: use ${now}`, pos);
      }) as LibFn,
    ]),
  ),
});
