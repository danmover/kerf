// The firmware debugger's settings for the open design: breakpoints (plain, with a condition, or logpoints that
// print), watch expressions and whether a firmware mistake stops it. They are kept per design in this browser, like
// an IDE's breakpoints, not in the design or the project file.

import { create } from "zustand";
import { useProject } from "./project";

export interface Breakpoint {
  id: string;
  /** the firmware block whose code it is in */
  block: string;
  /** the file, as the sketch names it (brain.ino, pins.h) */
  file: string;
  /** from 1 */
  line: number;
  /** stop only when this C expression is true (in the scope of the line) */
  cond?: string;
  /** a logpoint: print this (with {expressions}) instead of stopping */
  log?: string;
  enabled: boolean;
}

interface DebugPrefs {
  breakpoints: Breakpoint[];
  watches: string[];
  breakOnFault: boolean;
}

const EMPTY: DebugPrefs = { breakpoints: [], watches: [], breakOnFault: true };
const MAX_BREAKPOINTS = 64;
const MAX_WATCHES = 24;

export const useFirmwareDebug = create<DebugPrefs & { project: string | null }>(() => ({ ...EMPTY, project: null }));

const keyFor = (id: string) => `kerf.fwdebug.${id}`;

function load(id: string): DebugPrefs {
  try {
    const raw = localStorage.getItem(keyFor(id));
    if (!raw) return { ...EMPTY };
    const v = JSON.parse(raw) as Partial<DebugPrefs>;
    const bps = Array.isArray(v.breakpoints) ? v.breakpoints.filter((b) => b && typeof b.block === "string" && typeof b.file === "string" && Number.isInteger(b.line) && b.line >= 1) : [];
    return {
      breakpoints: bps.slice(0, MAX_BREAKPOINTS).map((b) => ({ id: String(b.id || newId()), block: b.block, file: b.file, line: b.line, cond: typeof b.cond === "string" && b.cond.trim() ? b.cond : undefined, log: typeof b.log === "string" && b.log.trim() ? b.log : undefined, enabled: b.enabled !== false })),
      watches: Array.isArray(v.watches) ? v.watches.filter((w) => typeof w === "string" && w.trim()).slice(0, MAX_WATCHES) : [],
      breakOnFault: v.breakOnFault !== false,
    };
  } catch {
    return { ...EMPTY };
  }
}

function save() {
  const s = useFirmwareDebug.getState();
  if (!s.project) return;
  try {
    localStorage.setItem(keyFor(s.project), JSON.stringify({ breakpoints: s.breakpoints, watches: s.watches, breakOnFault: s.breakOnFault }));
  } catch {
    // storage full or blocked: the settings last until the design closes
  }
}

let seq = 0;
const newId = () => `bp${Date.now().toString(36)}${(seq++).toString(36)}`;

function set(patch: Partial<DebugPrefs>) {
  useFirmwareDebug.setState(patch);
  save();
}

/** Follow the open design: its own breakpoints and watches. */
export function startFirmwareDebug() {
  const follow = (id: string | null) => {
    if (useFirmwareDebug.getState().project === id) return;
    useFirmwareDebug.setState({ ...(id ? load(id) : EMPTY), project: id });
  };
  follow(useProject.getState().current?.id ?? null);
  return useProject.subscribe((s) => follow(s.current?.id ?? null));
}

export function breakpointsIn(block: string, file: string): Breakpoint[] {
  return useFirmwareDebug.getState().breakpoints.filter((b) => b.block === block && b.file === file);
}

/** Set a breakpoint on a line, or clear the one there. */
export function toggleBreakpoint(block: string, file: string, line: number) {
  const { breakpoints } = useFirmwareDebug.getState();
  const at = breakpoints.find((b) => b.block === block && b.file === file && b.line === line);
  if (at) return set({ breakpoints: breakpoints.filter((b) => b !== at) });
  if (breakpoints.length >= MAX_BREAKPOINTS) return;
  set({ breakpoints: [...breakpoints, { id: newId(), block, file, line, enabled: true }] });
}

export function addBreakpoint(b: Omit<Breakpoint, "id" | "enabled"> & { enabled?: boolean }): Breakpoint | null {
  const { breakpoints } = useFirmwareDebug.getState();
  if (breakpoints.length >= MAX_BREAKPOINTS) return null;
  const at = breakpoints.find((x) => x.block === b.block && x.file === b.file && x.line === b.line);
  const next: Breakpoint = { id: at?.id ?? newId(), block: b.block, file: b.file, line: b.line, cond: b.cond?.trim() || undefined, log: b.log?.trim() || undefined, enabled: b.enabled ?? true };
  set({ breakpoints: at ? breakpoints.map((x) => (x === at ? next : x)) : [...breakpoints, next] });
  return next;
}

export function updateBreakpoint(id: string, patch: Partial<Omit<Breakpoint, "id">>) {
  set({
    breakpoints: useFirmwareDebug.getState().breakpoints.map((b) => {
      if (b.id !== id) return b;
      const n = { ...b, ...patch };
      return { ...n, cond: n.cond?.trim() || undefined, log: n.log?.trim() || undefined };
    }),
  });
}

export function removeBreakpoint(id: string) {
  set({ breakpoints: useFirmwareDebug.getState().breakpoints.filter((b) => b.id !== id) });
}

export function clearBreakpoints(block?: string) {
  set({ breakpoints: block ? useFirmwareDebug.getState().breakpoints.filter((b) => b.block !== block) : [] });
}

/** Typing moved a file's breakpoints: their new lines, in the order breakpointsIn gives them. */
export function moveBreakpoints(block: string, file: string, lines: number[]) {
  const mine = breakpointsIn(block, file);
  const to = new Map(mine.map((b, i) => [b.id, lines[i] ?? b.line]));
  // a line deleted (0) takes its breakpoint with it; two that end on one line become one
  const taken = new Set<number>();
  const keep = (b: Breakpoint) => {
    const n = to.get(b.id);
    if (n === undefined) return true;
    if (n < 1 || taken.has(n)) return false;
    taken.add(n);
    return true;
  };
  set({ breakpoints: useFirmwareDebug.getState().breakpoints.filter(keep).map((b) => (to.has(b.id) ? { ...b, line: to.get(b.id)! } : b)) });
}

/** A file was renamed: its breakpoints go with it. */
export function renameBreakpointFile(block: string, from: string, to: string) {
  set({ breakpoints: useFirmwareDebug.getState().breakpoints.map((b) => (b.block === block && b.file === from ? { ...b, file: to } : b)) });
}

export function setWatches(watches: string[]) {
  set({ watches: watches.map((w) => w.trim()).filter(Boolean).slice(0, MAX_WATCHES) });
}

export function setBreakOnFault(on: boolean) {
  set({ breakOnFault: on });
}
