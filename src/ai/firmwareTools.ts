// Claude's tools for firmware code: read a block's sketch (Kerf's generated code, or the block's own), write the
// block's own code (code: "own", run in place of Kerf's on the virtual chip, in apps and in the build pack), and
// debug it: a scenario's run again under the debugger, with a logic analyser on the pins and buses. Every change
// compiles the sketch for its board, as the Arduino IDE's Verify does, and the user sees the code in Build →
// Firmware and the debug run in Simulate → Debug and Signals.

import { z } from "zod";
import { useDesign, whenChecked } from "../core/engine";
import { generateFirmware, type FirmwareOutput } from "../machine/firmware";
import { deleteOwnFile, kerfCodeFor, ownFiles, renameOwnFile, resetOwnCode, startOwnCode, switchToKerfCode, withOwnCode, writeOwnFile } from "../app/firmwareCode";
import { checkFirmware, type FirmwareCheck } from "../sim/mcu/check";
import { debugScenario, scenarioBlock, useDebugRun, type DebugRun } from "../sim/debugRuntime";
import { edges, type PinTrace, type SignalTrace } from "../sim/engine/probes";
import { VARIANTS, type VariantName } from "../sim/worlds/common";
import type { DebugSite, DebugSpec, DebugStop } from "../sim/mcu";
import { fmtNum } from "../lang/values";
import type { ToolOutcome } from "./tools";

const BUSES = ["uart", "i2c", "spi", "adc"] as const;

export const FIRMWARE_TOOL_DEFS = [
  {
    name: "read_firmware",
    description:
      'Read a firmware block\'s code: the sketch Kerf generates for it, or its own code when the block says code: "own" (a sketch written for it, run in place of Kerf\'s). Lists the files, returns one with line numbers, and compiles the sketch for the board as the Arduino IDE\'s Verify does: the first mistake with its file and line, or the RAM its globals take. Changes nothing.',
    input_schema: {
      type: "object" as const,
      properties: {
        block: { type: "string", description: "The firmware block's name (default the first one)." },
        file: { type: "string", description: "The file to show (default the .ino)." },
        from: { type: "integer", description: "First line to show (default 1)." },
        to: { type: "integer", description: "Last line to show (default 400 lines on)." },
        kerf: { type: "boolean", description: "Show Kerf's generated code even when the block runs its own." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "edit_firmware",
    description:
      'Change a firmware block\'s own code: an Arduino sketch that runs in place of the code Kerf generates, on the virtual chip in scenarios and apps, and in the build pack. Actions: use_own (the block runs its own code, starting from Kerf\'s sketch when it has none; sets code: "own" in the design), use_kerf (back to Kerf\'s code; its own files are kept), reset (its own files start again from Kerf\'s sketch), write (a whole file, new or replaced), edit (replace text that occurs exactly once in a file), rename, delete. write and edit on a block that runs Kerf\'s code switch it to its own code first. Each change compiles the sketch and returns the first mistake with its line. Files are flat: one .ino and any .h, .c and .cpp beside it. Which libraries and C++ the virtual chip runs: Firmware in the language reference.',
    input_schema: {
      type: "object" as const,
      properties: {
        block: { type: "string", description: "The firmware block's name." },
        action: { type: "string", enum: ["use_own", "use_kerf", "reset", "write", "edit", "rename", "delete"] },
        file: { type: "string", description: "The file (write, edit, rename, delete), e.g. brain.ino or pins.h." },
        content: { type: "string", description: "write: the whole file." },
        old: { type: "string", description: "edit: the exact text to replace, occurring once in the file; include enough lines round it to be unique." },
        new: { type: "string", description: "edit: what replaces it." },
        to: { type: "string", description: "rename: the new file name." },
      },
      required: ["block", "action"],
      additionalProperties: false,
    },
  },
  {
    name: "debug_firmware",
    description:
      "Run one variant of a scenario again with its firmware under the debugger and a logic analyser on the chip's pins and buses, as Simulate → Debug and Signals do (the user sees this run there; the scenario's own results are left as they are). A breakpoint stops at a file and line, optionally only when a C condition holds or from its nth hit, and records the call stack with every variable, the globals, your watches and the statements that ran just before; a logpoint (log) records a line of text with {expressions} filled in and carries on. break_on_fault stops where the firmware makes a mistake the chip wouldn't report (an index outside an array, a divide by zero). signals returns what chosen pins did in a time window (levels, PWM, pulse rates and widths, servo pulses) and the UART, I2C, SPI and ADC traffic. Use it when a run misbehaves and the console doesn't show why. Takes about as long as one variant of the scenario.",
    input_schema: {
      type: "object" as const,
      properties: {
        scenario: { type: "string", description: "The scenario's label." },
        variant: { type: "string", enum: [...VARIANTS], description: "Which run (default expected)." },
        breakpoints: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            properties: {
              file: { type: "string", description: "Default the sketch's .ino." },
              line: { type: "integer" },
              cond: { type: "string", description: "Stop only when this C expression is true, e.g. pos > 100 && state == 2." },
              log: { type: "string", description: "A logpoint: record this text and go on, e.g. \"pos={pos} speed={stepper.speed()}\"." },
              hit: { type: "integer", description: "Stop from this hit on (1 = the first)." },
            },
            required: ["line"],
            additionalProperties: false,
          },
        },
        watches: { type: "array", maxItems: 12, items: { type: "string" }, description: "C expressions shown at every stop, e.g. leds[0].r or digitalRead(3)." },
        break_on_fault: { type: "boolean", description: "Stop at the firmware's mistakes (default true)." },
        from: { type: "number", description: "Record stops from this time on, s (earlier ones are only counted)." },
        signals: {
          type: "object",
          properties: {
            pins: { type: "array", maxItems: 12, items: { type: "string" }, description: "Board pins as the pinout names them: D3, A0, GPIO26. Default every pin the run used, briefly." },
            buses: { type: "array", items: { type: "string", enum: [...BUSES] } },
            from: { type: "number", description: "Window start, s (default 0)." },
            to: { type: "number", description: "Window end, s (default the end of the run)." },
          },
          additionalProperties: false,
        },
      },
      required: ["scenario"],
      additionalProperties: false,
    },
  },
];

export const FIRMWARE_TOOL_TITLES: Record<string, string> = { read_firmware: "Reading the firmware", edit_firmware: "Writing the firmware", debug_firmware: "Debugging the firmware" };

const ReadInput = z.object({
  block: z.string().max(80).optional(),
  file: z.string().max(80).optional(),
  from: z.number().int().min(1).optional(),
  to: z.number().int().min(1).optional(),
  kerf: z.boolean().optional(),
});
const EditInput = z.object({
  block: z.string().min(1).max(80),
  action: z.enum(["use_own", "use_kerf", "reset", "write", "edit", "rename", "delete"]),
  file: z.string().max(80).optional(),
  content: z.string().max(300_000).optional(),
  old: z.string().max(100_000).optional(),
  new: z.string().max(100_000).optional(),
  to: z.string().max(80).optional(),
});
const DebugInput = z.object({
  scenario: z.string().min(1).max(200),
  variant: z.enum(VARIANTS as [VariantName, ...VariantName[]]).optional(),
  breakpoints: z
    .array(z.object({ file: z.string().max(80).optional(), line: z.number().int().min(1), cond: z.string().max(400).optional(), log: z.string().max(400).optional(), hit: z.number().int().min(1).optional() }))
    .max(12)
    .optional(),
  watches: z.array(z.string().max(200)).max(12).optional(),
  break_on_fault: z.boolean().optional(),
  from: z.number().min(0).optional(),
  signals: z.object({ pins: z.array(z.string().max(20)).max(12).optional(), buses: z.array(z.enum(BUSES)).optional(), from: z.number().min(0).optional(), to: z.number().min(0).optional() }).optional(),
});

const fail = (content: string, title: string): ToolOutcome => ({ isError: true, content, card: { title, status: "error" } });
const issues = (e: z.ZodError) => e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");

// ---------------------------------------------------------------- blocks and files

interface Block {
  name: string;
  own: boolean;
  out: FirmwareOutput;
  /** the controller part, to compile for */
  partId?: string;
}

export function blockNamed(name: string | undefined): Block | string {
  const model = useDesign.getState().model;
  const mm = model?.machine;
  if (!model || !mm?.firmware.length) return 'The design has no firmware block. Add one with edit_design (firmware <name> { board: <controller> }; see Firmware in the language reference).';
  const outs = generateFirmware(withOwnCode(mm), model.name);
  const def = name ? mm.firmware.find((f) => f.name === name) : (mm.firmware.find((f) => outs.find((o) => o.name === f.name)?.target === "arduino") ?? mm.firmware[0]);
  if (!def) return `There is no firmware block "${name}". Blocks: ${mm.firmware.map((f) => f.name).join(", ")}.`;
  const out = outs.find((o) => o.name === def.name)!;
  return { name: def.name, own: def.settings.code === "own", out, partId: mm.components.find((c) => c.name === def.board)?.catalogId };
}

const lineCount = (s: string) => (s.length ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0);

function checkLine(c: FirmwareCheck): string {
  if (c.problem) return `Does not compile for ${c.board}: ${c.problem.file ? `${c.problem.file}:${c.problem.line}: ` : ""}${c.problem.message}`;
  if (c.missing?.length) return `Compiles for ${c.board}, but has no ${c.missing.map((m) => `${m}()`).join(" or ")}.`;
  return `Compiles for ${c.board}: RAM ${c.ram?.used ?? "?"} of ${c.ram?.total ?? "?"} bytes before it runs.`;
}

/** the problem line with a few round it, so the mistake can be fixed without reading the file again */
function around(files: { path: string; content: string }[], c: FirmwareCheck): string {
  const p = c.problem;
  const f = p && files.find((x) => x.path === p.file);
  if (!p || !f || p.line < 1) return "";
  const lines = f.content.split("\n");
  const a = Math.max(1, p.line - 3);
  const b = Math.min(lines.length, p.line + 3);
  return `\n${f.path} lines ${a}–${b}:\n${numbered(lines.slice(a - 1, b), a, p.line)}`;
}

function numbered(lines: string[], first: number, mark?: number): string {
  const w = String(first + lines.length - 1).length;
  return lines.map((l, i) => `${String(first + i).padStart(w)}${first + i === mark ? ">" : "|"} ${l}`).join("\n");
}

function readFirmware(input: z.infer<typeof ReadInput>): ToolOutcome {
  const b = blockNamed(input.block);
  if (typeof b === "string") return fail(b, "No firmware to read");
  const kerf = input.kerf || !b.own;
  const files = kerf ? (kerfCodeFor(b.name)?.files ?? b.out.files) : ownFiles(b.name);
  const head = [`Firmware block ${b.name} (board ${b.out.board || "?"}): ${b.own ? 'runs its own code (code: "own")' : "runs the code Kerf generates"}${b.own && kerf ? "; showing Kerf's code, which it does not run" : ""}. ${b.out.summary}.`];
  if (!files.length) return { content: [...head, kerf ? "Kerf writes no code for it." : "It has no files yet: edit_firmware write one, or reset to start from Kerf's sketch."].join("\n"), card: { title: `${b.name}: no files` } };
  head.push(`Files: ${files.map((f) => `${f.path} (${lineCount(f.content)} lines)`).join(", ")}.`);
  const arduino = b.out.target === "arduino";
  const check = arduino ? checkFirmware(files, b.partId) : null;
  if (check) head.push(checkLine(check));
  if (b.out.warnings.length) head.push(`Kerf's notes on it: ${b.out.warnings.slice(0, 6).join(" ")}`);
  if (b.out.pinTable.length) head.push(`Pins (from the wiring): ${b.out.pinTable.slice(0, 40).map((p) => `${p.signal} ${p.pin} → ${p.wire}`).join("; ")}.`);
  const file = input.file ? files.find((f) => f.path === input.file || f.path.endsWith(`/${input.file}`)) : (files.find((f) => f.path.endsWith(".ino")) ?? files[0]);
  if (!file) return fail(`${b.name} has no file ${input.file}. Files: ${files.map((f) => f.path).join(", ")}.`, "File not found");
  const lines = file.content.split("\n");
  const from = Math.min(input.from ?? 1, Math.max(1, lines.length));
  const to = Math.min(lines.length, input.to ?? from + 399, from + 599);
  head.push(`--- ${file.path} lines ${from}–${to} of ${lines.length} ---`, numbered(lines.slice(from - 1, to), from, check?.problem?.file === file.path ? check.problem.line : undefined));
  return { content: head.join("\n"), card: { title: `Read ${file.path}`, detail: check ? (check.ok ? "compiles" : (check.problem?.message ?? "does not compile")) : undefined } };
}

function editFirmware(input: z.infer<typeof EditInput>): ToolOutcome {
  const b = blockNamed(input.block);
  if (typeof b === "string") return fail(b, "No firmware to change");
  if (b.out.target !== "arduino" && b.out.target !== "none") return fail(`${b.name} runs ${b.out.target} on its board: own code is for Arduino-style boards. Change its settings in the firmware block instead.`, "Not an Arduino board");
  const notes: string[] = [];
  let before: string | undefined;
  let after: string | undefined;
  const need = (k: "file" | "content" | "to") => {
    if (input[k] === undefined) throw new Error(`${input.action} needs ${k}.`);
    return input[k]!;
  };
  const ensureOwn = (): string | null => {
    if (b.own) return null;
    const why = startOwnCode(b.name, "claude");
    if (!why) notes.push(`${b.name} now runs its own code (code: "own"), started from Kerf's sketch.`);
    return why;
  };
  let why: string | null = null;
  try {
    switch (input.action) {
      case "use_own":
        why = startOwnCode(b.name, "claude");
        if (!why) notes.push(b.own ? `${b.name} already runs its own code.` : `${b.name} now runs its own code (code: "own"), started from Kerf's sketch if it had none.`);
        break;
      case "use_kerf":
        why = switchToKerfCode(b.name, "claude");
        if (!why) notes.push(`${b.name} runs Kerf's code again; its own files are kept to switch back to.`);
        break;
      case "reset":
        why = resetOwnCode(b.name);
        if (!why) notes.push(`${b.name}'s own files start again from Kerf's sketch.`);
        break;
      case "write": {
        const file = need("file");
        const content = need("content");
        why = ensureOwn();
        if (why) break;
        before = ownFiles(b.name).find((f) => f.path === file)?.content ?? "";
        why = writeOwnFile(b.name, file, content);
        after = content;
        if (!why) notes.push(`${before ? "Replaced" : "Wrote"} ${file} (${lineCount(content)} lines).`);
        break;
      }
      case "edit": {
        const file = need("file");
        if (input.old === undefined || input.new === undefined) throw new Error("edit needs old and new.");
        why = ensureOwn();
        if (why) break;
        const cur = ownFiles(b.name).find((f) => f.path === file);
        if (!cur) {
          why = `${b.name} has no file ${file}. Files: ${ownFiles(b.name).map((f) => f.path).join(", ")}.`;
          break;
        }
        const n = input.old ? cur.content.split(input.old).length - 1 : 0;
        if (n !== 1) {
          why = n === 0 ? `The text to replace is not in ${file}: read_firmware it and copy the lines exactly.` : `The text to replace occurs ${n} times in ${file}: include more of the lines round it so it occurs once.`;
          break;
        }
        before = cur.content;
        after = cur.content.replace(input.old, () => input.new!);
        why = writeOwnFile(b.name, file, after);
        if (!why) notes.push(`Edited ${file}.`);
        break;
      }
      case "rename": {
        const file = need("file");
        const to = need("to");
        why = renameOwnFile(b.name, file, to);
        if (!why) notes.push(`Renamed ${file} to ${to}.`);
        break;
      }
      case "delete": {
        const file = need("file");
        why = deleteOwnFile(b.name, file);
        if (!why) notes.push(`Deleted ${file}.`);
        break;
      }
    }
  } catch (e) {
    why = e instanceof Error ? e.message : String(e);
  }
  if (why) return fail(why, `Could not ${input.action.replace("_", " ")} ${b.name}`);
  // the sketch it runs now, compiled for its board
  const now = blockNamed(b.name);
  const files = typeof now === "string" ? [] : now.own ? ownFiles(b.name) : (kerfCodeFor(b.name)?.files ?? []);
  const check = files.length ? checkFirmware(files, b.partId) : null;
  if (check) notes.push(checkLine(check) + around(files, check));
  if (typeof now !== "string" && now.own) notes.push(`Files: ${files.map((f) => `${f.path} (${lineCount(f.content)} lines)`).join(", ")}.`);
  return {
    content: notes.join("\n"),
    card: { title: notes[0] ?? `Changed ${b.name}`, detail: check ? (check.ok ? "compiles" : (check.problem?.message ?? "does not compile")) : undefined, ...(before !== undefined && after !== undefined ? { diff: { before, after } } : {}) },
  };
}

// ---------------------------------------------------------------- debugging

const sec = (t: number) => `${fmtNum(t, t < 10 ? 4 : 3)} s`;
/** n to d significant figures, with no trailing zeros (a rate reads 24.61 Hz, not 24.6103 Hz) */
const sig = (n: number, d = 4) => (Number.isFinite(n) ? String(Number(n.toPrecision(d))) : String(n));

function stopText(s: DebugStop, sites: DebugSite[]): string {
  const top = s.stack[0];
  const lines = [`${sec(s.t)} ${s.reason === "fault" ? `firmware mistake "${s.fault}"` : `breakpoint ${s.bp}`} at ${s.file}:${s.line} in ${s.fn}()`];
  if (top?.locals.length) lines.push(`  locals: ${top.locals.map((v) => `${v.name} = ${v.value}`).join(", ")}`);
  if (s.stack.length > 1) lines.push(`  called from: ${s.stack.slice(1, 5).map((f) => `${f.fn}() at ${f.file}:${f.line}`).join(" ← ")}`);
  if (s.watches.length) lines.push(`  watches: ${s.watches.map((w) => `${w.expr} = ${w.error ? `(${w.error})` : w.value}`).join(", ")}`);
  const g = s.globals.filter((v) => !/^\[/.test(v.value) || v.value.length < 80).slice(0, 24);
  if (g.length) lines.push(`  globals: ${g.map((v) => `${v.name} = ${v.value.length > 60 ? v.value.slice(0, 57) + "…" : v.value}`).join(", ")}`);
  const at = (k: number) => (sites[k] ? `${sites[k].file === s.file ? "" : `${sites[k].file}:`}${sites[k].line}` : "?");
  const before = s.before.slice(-8);
  if (before.length) lines.push(`  lines run just before: ${before.map((st) => at(st.s)).join(", ")}`);
  const after = s.trace.slice(1, 9);
  if (after.length) lines.push(`  and after: ${after.map((st) => at(st.s)).join(", ")}`);
  return lines.join("\n");
}

function pinLabel(out: FirmwareOutput | undefined, p: PinTrace): string {
  const row = out?.pinTable.find((r) => r.pin === p.name || r.pin.startsWith(`${p.name} `) || r.pin.includes(`(${p.name})`) || r.pin === String(p.pin));
  return row ? `${p.name} (${row.wire}, ${row.signal})` : p.name;
}

function segText(s: PinTrace["segs"][number]): string {
  switch (s.k) {
    case "l":
      return `${s.v ? "high" : "low"}${s.by === "outside" ? " (driven from outside)" : s.by === "pull-up" ? " (pull-up)" : ""}`;
    case "pwm":
      return `PWM ${sig(s.hz ?? 0)} Hz at ${fmtNum((s.duty ?? 0) * 100, 3)} %`;
    case "servo":
      return `servo pulses ${sig(s.us ?? 0)} µs at 50 Hz`;
    case "tone":
      return `tone ${sig(s.hz ?? 0)} Hz`;
    default:
      return "not driven";
  }
}

/** what a pin did in a window: its levels and modes, and its pulses counted from the edges */
function pinText(p: PinTrace, t0: number, t1: number, out: FirmwareOutput | undefined, brief: boolean): string {
  const segs = p.segs.filter((s, i) => (p.segs[i + 1]?.t ?? Infinity) > t0 && s.t < t1);
  const e = edges(p, t0, t1, 400_000);
  let rises = 0;
  let high = 0;
  let wMin = Infinity;
  let wMax = 0;
  let gapMin = Infinity;
  let gapMax = 0;
  let lastRise = -1;
  for (let i = 0; i < e.length; i++) {
    const end = e[i + 1]?.t ?? t1;
    if (e[i].v !== 1) continue;
    high += end - e[i].t;
    if (i > 0 && e[i - 1].v !== 1) {
      rises++;
      if (e[i + 1]) {
        wMin = Math.min(wMin, end - e[i].t);
        wMax = Math.max(wMax, end - e[i].t);
      }
      if (lastRise >= 0) {
        gapMin = Math.min(gapMin, e[i].t - lastRise);
        gapMax = Math.max(gapMax, e[i].t - lastRise);
      }
      lastRise = e[i].t;
    }
  }
  const us = (t: number) => (t < 1e-3 ? `${fmtNum(t * 1e6, 3)} µs` : t < 1 ? `${fmtNum(t * 1e3, 3)} ms` : `${fmtNum(t, 3)} s`);
  const head = `${pinLabel(out, p)}:`;
  const pulses = rises
    ? ` ${rises} rising edge${rises === 1 ? "" : "s"}${rises > 1 ? `, ${sig(rises / (t1 - t0))} a second on average (${gapMax - gapMin <= gapMin * 1e-3 ? `steady at ${sig(1 / gapMin)} Hz` : `fastest ${sig(1 / gapMin)} Hz, slowest ${sig(1 / gapMax)} Hz`})` : ""}${wMax ? `, high pulses ${us(wMin)}${wMax - wMin > 1e-9 ? ` to ${us(wMax)}` : ""} wide` : ""}; high ${fmtNum((high / (t1 - t0)) * 100, 3)} % of the window.`
    : ` no pulses; high ${fmtNum((high / (t1 - t0)) * 100, 3)} % of the window.`;
  if (brief) return `${head}${pulses} Ends ${segText(segs[segs.length - 1] ?? p.segs[p.segs.length - 1])}.`;
  const list = segs.slice(0, 14).map((s) => `${sec(Math.max(t0, s.t))} ${segText(s)}`);
  return `${head}${pulses}\n  ${list.join("; ")}${segs.length > 14 ? `; … ${segs.length - 14} more changes` : ""}`;
}

const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, "0")).join(" ");

function busText(tr: SignalTrace, bus: (typeof BUSES)[number], t0: number, t1: number, pinName: (pin: number) => string): string {
  switch (bus) {
    case "uart": {
      const groups = new Map<string, number[]>();
      for (const u of tr.uart) if (u.t0 >= t0 && u.t0 < t1) (groups.get(`Serial${u.port || ""} ${u.dir}`) ?? groups.set(`Serial${u.port || ""} ${u.dir}`, []).get(`Serial${u.port || ""} ${u.dir}`)!).push(u.b);
      if (!groups.size) return "UART: nothing sent or received in the window.";
      return [...groups].map(([k, b]) => `UART ${k}: ${b.length} bytes: ${JSON.stringify(String.fromCharCode(...b.slice(0, 400)))}${b.length > 400 ? "…" : ""}`).join("\n");
    }
    case "i2c": {
      const x = tr.i2c.filter((q) => q.t0 >= t0 && q.t0 < t1);
      if (!x.length) return "I2C: no transactions in the window.";
      const addrs = [...new Set(x.map((q) => q.addr))].map((a) => `0x${a.toString(16)}${x.some((q) => q.addr === a && !q.ack) ? " (no answer)" : ""}`);
      return `I2C: ${x.length} transactions with ${addrs.join(", ")}:\n${x
        .slice(0, 16)
        .map((q) => `  ${sec(q.t0)} 0x${q.addr.toString(16)} ${q.op === "w" ? "write" : "read"} [${hex(q.bytes.slice(0, 16))}${q.bytes.length > 16 ? " …" : ""}]${q.ack ? "" : " NACK"}`)
        .join("\n")}${x.length > 16 ? `\n  … ${x.length - 16} more` : ""}`;
    }
    case "spi": {
      const x = tr.spi.filter((q) => q.t0 >= t0 && q.t0 < t1);
      if (!x.length) return "SPI: no transfers in the window.";
      return `SPI: ${x.length} transfers:\n${x
        .slice(0, 16)
        .map((q) => `  ${sec(q.t0)} CS ${q.cs >= 0 ? pinName(q.cs) : "none"} at ${fmtNum(q.hz / 1e6, 3)} MHz out [${hex(q.out.slice(0, 12))}${q.out.length > 12 ? " …" : ""}] in [${hex(q.in.slice(0, 12))}${q.in.length > 12 ? " …" : ""}]`)
        .join("\n")}${x.length > 16 ? `\n  … ${x.length - 16} more` : ""}`;
    }
    case "adc": {
      const x = tr.adc.filter((a) => a.t >= t0 && a.t < t1);
      if (!x.length) return "ADC: no readings in the window.";
      const pins = [...new Set(x.map((a) => a.pin))];
      return `ADC: ${pins
        .map((pin) => {
          const r = x.filter((a) => a.pin === pin);
          const v = r.map((a) => a.volts);
          return `${pinName(pin)} read ${r.length} times, ${fmtNum(Math.min(...v), 3)} to ${fmtNum(Math.max(...v), 3)} V (readings ${Math.min(...r.map((a) => a.reading))} to ${Math.max(...r.map((a) => a.reading))}), last ${fmtNum(v[v.length - 1], 3)} V`;
        })
        .join("; ")}.`;
    }
  }
}

function waitForDebug(key: string, signal?: AbortSignal): Promise<DebugRun | null> {
  return new Promise((resolve) => {
    const settled = () => {
      const r = useDebugRun.getState().run;
      return !r || r.key !== key ? null : r.status !== "running" ? r : undefined;
    };
    const first = settled();
    if (first !== undefined) return resolve(first);
    const unsub = useDebugRun.subscribe(() => {
      const r = settled();
      if (r !== undefined) {
        unsub();
        resolve(r);
      }
    });
    signal?.addEventListener("abort", () => {
      unsub();
      resolve(useDebugRun.getState().run);
    });
  });
}

async function debugFirmware(input: z.infer<typeof DebugInput>, signal?: AbortSignal): Promise<ToolOutcome> {
  await whenChecked(60_000);
  const model = useDesign.getState().model;
  const def = model?.scenarios?.find((d) => d.label === input.scenario);
  if (!def) return fail(`No scenario is labelled "${input.scenario}". Scenarios: ${(model?.scenarios ?? []).map((d) => `"${d.label}"`).join(", ") || "none"}.`, "Scenario not found");
  const blockName = scenarioBlock(def.label);
  const b = blockNamed(blockName ?? undefined);
  if (typeof b === "string") return fail(b, "No firmware to debug");
  const files = b.own ? ownFiles(b.name) : b.out.files;
  const main = files.find((f) => f.path.endsWith(".ino"))?.path.split("/").pop() ?? `${b.name}.ino`;
  const spec: DebugSpec = {
    breakpoints: (input.breakpoints ?? []).map((bp, i) => ({ id: `b${i + 1}`, file: bp.file ?? main, line: bp.line, ...(bp.cond ? { cond: bp.cond } : {}), ...(bp.log ? { log: bp.log } : {}), ...(bp.hit ? { hit: bp.hit } : {}) })),
    watches: input.watches ?? [],
    breakOnFault: input.break_on_fault ?? true,
    from: input.from && input.from > 0 ? input.from : undefined,
    maxStops: 40,
    traceSteps: 300,
  };
  const variant = input.variant ?? "expected";
  const why = debugScenario(def.label, variant, { spec });
  if (why) return fail(why, "Could not debug");
  const key = useDebugRun.getState().run?.key ?? "";
  const run = await waitForDebug(key, signal);
  if (signal?.aborted) return fail("Stopped waiting for the debug run: the user pressed Stop. It carries on in Simulate → Debug.", "Debug wait stopped");
  if (!run || run.key !== key) return fail("The debug run was replaced by another one before it finished (the user started one in Simulate → Debug).", "Debug run replaced");
  if (run.status === "error") return fail(`The debug run failed: ${run.error}`, "Debug run failed");
  const stops = run.result?.stops.length ?? 0;
  return { content: debugReport(run, b, spec, input.signals), card: { title: stops ? `Stopped ${stops} time${stops === 1 ? "" : "s"} in ${b.name}` : `Debugged ${b.name}: no stops`, detail: `${def.label}, ${variant} run` } };
}

/** What a finished debug run found, for Claude: breakpoints and stops, logpoints, mistakes, and the signals asked for. */
export function debugReport(run: DebugRun, b: Block, spec: DebugSpec, want?: z.infer<typeof DebugInput>["signals"]): string {
  const r = run.result;
  const v = run.run;
  const lines: string[] = [`Debug run of "${run.label}" (${run.variant}), firmware ${b.name} (${b.own ? "its own code" : "Kerf's code"}): ${v ? `ran to ${sec(v.summary.time)} (${v.stop})` : "finished"}${run.ms ? `, ${fmtNum(run.ms / 1000, 2)} s of computer time` : ""}. The user can step through it in Simulate → Debug.`];
  if (r) {
    for (const bp of spec.breakpoints) {
      const bound = r.bound[bp.id];
      lines.push(`Breakpoint ${bp.id} at ${bp.file}:${bp.line}${bp.cond ? ` if ${bp.cond}` : ""}${bp.log ? " (logpoint)" : ""}: ${bound === null ? "no code at or after that line: it never stops" : `${bound !== bp.line ? `stops at line ${bound}, the first with code; ` : ""}hit ${r.hits[bp.id] ?? 0} times`}.`);
    }
    if (r.errors.length) lines.push(`Could not read: ${r.errors.map((x) => `${x.bp ?? x.watch ?? ""}: ${x.message}`).join("; ")}`);
    if (r.stops.length) {
      lines.push(`Stops (${r.stops.length}${r.more ? ", more not recorded" : ""}):`);
      for (const s of r.stops.slice(0, 10)) lines.push(stopText(s, r.sites));
      if (r.stops.length > 10) lines.push(`… ${r.stops.length - 10} more stops, at ${r.stops.slice(10).map((s) => `${sec(s.t)} ${s.file}:${s.line}`).slice(0, 12).join(", ")}`);
    } else lines.push("No stops.");
    if (r.logs.length) {
      lines.push(`Logpoints (${r.logs.length}${r.moreLogs ? ", more not kept" : ""}):`);
      for (const l of r.logs.slice(0, 40)) lines.push(`  ${sec(l.t)} ${l.file}:${l.line} ${l.text}`);
    }
  }
  if (v?.faults.length) lines.push(`Firmware mistakes: ${v.faults.map((f) => `${f.msg}${f.count > 1 ? ` (${f.count}×)` : ""}`).join("; ")}`);
  const tr = run.signals;
  if (tr) {
    const t0 = Math.max(0, want?.from ?? 0);
    const t1 = Math.min(tr.end, want?.to ?? tr.end);
    const wanted = want?.pins;
    const pinName = (pin: number) => tr.pins.find((p) => p.pin === pin)?.name ?? String(pin);
    if (t1 > t0) {
      lines.push(`Signals from ${sec(t0)} to ${sec(t1)}${tr.truncatedAt !== undefined ? ` (the recording filled up at ${sec(tr.truncatedAt)}; later changes are missing)` : ""}:`);
      if (wanted?.length) {
        for (const w of wanted) {
          const k = w.trim().toUpperCase();
          const p = tr.pins.find((x) => x.name.toUpperCase() === k || String(x.pin) === k || `D${x.pin}` === k || `GPIO${x.pin}` === k);
          lines.push(p ? pinText(p, t0, t1, b.out, false) : `${w}: the firmware never used it in this run. Pins it used: ${tr.pins.map((x) => x.name).join(", ")}.`);
        }
      } else if (!want?.buses?.length) for (const p of tr.pins.slice(0, 24)) lines.push(pinText(p, t0, t1, b.out, true));
      for (const bus of want?.buses ?? []) lines.push(busText(tr, bus, t0, t1, pinName));
    }
  }
  return lines.join("\n");
}

export async function runFirmwareTool(name: string, input: unknown, ctx: { signal?: AbortSignal } = {}): Promise<ToolOutcome | null> {
  switch (name) {
    case "read_firmware": {
      const p = ReadInput.safeParse(input ?? {});
      if (!p.success) return fail(`Invalid input: ${issues(p.error)}`, "Could not read the firmware");
      await whenChecked(60_000);
      return readFirmware(p.data);
    }
    case "edit_firmware": {
      const p = EditInput.safeParse(input ?? {});
      if (!p.success) return fail(`Invalid input: ${issues(p.error)}`, "Could not change the firmware");
      await whenChecked(60_000);
      return editFirmware(p.data);
    }
    case "debug_firmware": {
      const p = DebugInput.safeParse(input ?? {});
      if (!p.success) return fail(`Invalid input: ${issues(p.error)}`, "Could not debug the firmware");
      return debugFirmware(p.data, ctx.signal);
    }
  }
  return null;
}
