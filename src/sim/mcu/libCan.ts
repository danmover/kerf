// FlexCAN_T4, the CAN library Teensyduino ships for the Teensy 4.x (Antonio Brewer's): the class template
// FlexCAN_T4<CAN1, RX_SIZE_256, TX_SIZE_16>, its CAN_message_t, and the calls a polled sketch makes: begin(),
// setBaudRate(), setMaxMB(), enableFIFO(), write() and read(). Frames go out on the port's own pins (CTX1/CRX1 are
// pins 22/23 on the Teensy 4.1) to whatever transceiver and bus the design wires there, one at a time at the bus
// rate; write() gives 0 when every transmit mailbox is still waiting for the wire, and read() takes the oldest
// frame the receive queue holds. Interrupt-driven reception (enableFIFOInterrupt, onReceive, events) is not
// modelled: the sketch must poll read().

import type { Pos } from "./ast";
import { strip, type CType } from "./ctypes";
import type { C, Ctx } from "./ir";
import { argCount, dict, method, type LibClass, type LibMethod } from "./libBase";

export interface FlexCanObj {
  kind: "FlexCAN_T4";
  /** 1 to 3: CAN1, CAN2, CAN3 */
  port: number;
  rxSize: number;
  txSize: number;
  begun: boolean;
}

/** The header: its enums as FlexCAN_T4.h has them (the port names stand for 1 to 3 here, not register addresses). */
export const FLEXCAN_H = `#pragma once
#include <stdint.h>
enum CAN_DEV_TABLE { CAN0 = 0, CAN1 = 1, CAN2 = 2, CAN3 = 3 };
enum FLEXCAN_RXQUEUE_TABLE { RX_SIZE_2 = 2, RX_SIZE_4 = 4, RX_SIZE_8 = 8, RX_SIZE_16 = 16, RX_SIZE_32 = 32, RX_SIZE_64 = 64, RX_SIZE_128 = 128, RX_SIZE_256 = 256, RX_SIZE_512 = 512, RX_SIZE_1024 = 1024 };
enum FLEXCAN_TXQUEUE_TABLE { TX_SIZE_2 = 2, TX_SIZE_4 = 4, TX_SIZE_8 = 8, TX_SIZE_16 = 16, TX_SIZE_32 = 32, TX_SIZE_64 = 64, TX_SIZE_128 = 128, TX_SIZE_256 = 256, TX_SIZE_512 = 512, TX_SIZE_1024 = 1024 };
enum FLEXCAN_MAILBOX { MB0, MB1, MB2, MB3, MB4, MB5, MB6, MB7, MB8, MB9, MB10, MB11, MB12, MB13, MB14, MB15, FIFO = 99 };
struct CAN_flags_t {
  bool extended;
  bool remote;
  bool overrun;
  bool reserved;
};
// as C++ structs (the tag is the type); the library's own gives len 8 by default, here a new message is all zero, so set len
struct CAN_message_t {
  uint32_t id;
  uint16_t timestamp;
  uint8_t idhit;
  CAN_flags_t flags;
  uint8_t len;
  uint8_t buf[8];
  int8_t mb;
  uint8_t bus;
  bool seq;
};
`;

/** a CAN_message_t argument's fields by name, from its struct type */
function msgFields(c: C, ctx: Ctx, what: string, pos: Pos) {
  const t = strip(c.t) as CType;
  if (t.k !== "struct" || t.name !== "CAN_message_t") ctx.error(`${what} takes a CAN_message_t`, pos);
  const st = t as Extract<CType, { k: "struct" }>;
  const at = (n: string) => st.fields.findIndex((f) => f.name === n);
  return { id: at("id"), ts: at("timestamp"), len: at("len"), buf: at("buf"), bus: at("bus"), flags: at("flags") };
}

/** a method whose one argument is a CAN_message_t, passed by reference: run gets the struct's own field array */
function msgMethod(name: string, run: (o: FlexCanObj, m: unknown[], f: ReturnType<typeof msgFields>, ctx: Ctx, pos: Pos) => number): LibMethod {
  return (obj, args, ctx, pos) => {
    if (args.length !== 1) argCount(`FlexCAN_T4.${name}`, 1, 1, args.length, ctx, pos);
    const fields = msgFields(args[0], ctx, `FlexCAN_T4.${name}()`, pos);
    return method<FlexCanObj>("FlexCAN_T4", name, ["obj"], "int", name === "write" ? 120 : 60, (o, v, c2, p2) => run(o, v[0] as unknown[], fields, c2, p2))(obj, args, ctx, pos);
  };
}

const can: LibClass = {
  make: (_ctx, targs) => ({ kind: "FlexCAN_T4", port: targs?.[0] ?? 1, rxSize: targs?.[1] ?? 16, txSize: targs?.[2] ?? 16, begun: false }) satisfies FlexCanObj,
  methods: dict<LibMethod>({
    begin: method<FlexCanObj>("FlexCAN_T4", "begin", [], "void", 400, (o, _v, ctx) => {
      o.begun = true;
      ctx.hal.canBegin?.(o.port, 1_000_000, o.rxSize, Math.min(o.txSize, 16));
    }),
    setBaudRate: method<FlexCanObj>("FlexCAN_T4", "setBaudRate", ["ulong"], "void", 200, (o, v, ctx, pos) => {
      if (!o.begun) ctx.fault("FlexCAN_T4.setBaudRate() before begin(): call begin() first", pos);
      ctx.hal.canBaud?.(o.port, v[0] as number);
    }),
    setMaxMB: method<FlexCanObj>("FlexCAN_T4", "setMaxMB", ["int"], "void", 100, () => undefined),
    enableFIFO: method<FlexCanObj>("FlexCAN_T4", "enableFIFO", ["bool"], "void", 100, () => undefined, [1]),
    setMBFilter: method<FlexCanObj>("FlexCAN_T4", "setMBFilter", ["int"], "void", 50, () => undefined),
    write: msgMethod("write", (o, m, f, ctx, pos) => {
      if (!o.begun) {
        ctx.fault("FlexCAN_T4.write() before begin(): nothing goes out", pos);
        return 0;
      }
      const len = Math.max(0, Math.min(8, Number(m[f.len]) | 0));
      const buf = (m[f.buf] as number[]).slice(0, len).map((b) => Number(b) & 255);
      return ctx.hal.canWrite?.(o.port, { id: Number(m[f.id]) & 0x7ff, len, buf }) ? 1 : 0;
    }),
    read: msgMethod("read", (o, m, f, ctx) => {
      if (!o.begun) return 0;
      const r = ctx.hal.canRead?.(o.port);
      if (!r) return 0;
      m[f.id] = r.id;
      m[f.len] = r.len;
      const b = m[f.buf] as number[];
      for (let i = 0; i < 8; i++) b[i] = r.buf[i] ?? 0;
      if (f.ts >= 0) m[f.ts] = r.ts & 0xffff;
      if (f.bus >= 0) m[f.bus] = o.port;
      return 1;
    }),
  }),
};

export const CAN_CLASSES: Record<string, LibClass> = dict({ FlexCAN_T4: can });
/** classes that take template arguments */
export const CAN_TEMPLATED = ["FlexCAN_T4"];
