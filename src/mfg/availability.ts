// Which manufacturing processes the user can use: machines they own
// ("own"), processes they can order from a shop or online service
// ("order"), and the rest ("none"). Settings hold the user's usual set; a
// project's brief can override it with workshop: and can_order: lists, which
// travel with the design like every other brief field.

import { PROCESSES, PROCESS_IDS, isProcessId } from "./profiles";
import { processFromText } from "./spec";
import type { ProcessId } from "./types";

export type Access = "own" | "order" | "none";
export type Availability = Record<ProcessId, Access>;

export const ACCESS_LABEL: Record<Access, string> = { own: "I have it", order: "I can order it", none: "Not available" };
export const ACCESS_SHORT: Record<Access, string> = { own: "own", order: "order", none: "off" };

/** Everything can be ordered from somewhere until the user says what they own. */
export const DEFAULT_ACCESS: Partial<Record<ProcessId, Access>> = {};

/** The user's usual access with every process filled in (processes added after it was saved can be ordered). */
export function fullAccess(saved: Partial<Record<string, Access>> | undefined): Availability {
  const out = {} as Availability;
  for (const id of PROCESS_IDS) {
    const v = saved?.[id];
    out[id] = v === "own" || v === "order" || v === "none" ? v : "order";
  }
  return out;
}

/** Process ids from the brief's loose names ("fdm", "laser cut", "CNC machining"); unknown names are skipped. */
export function processList(names: readonly string[] | undefined): ProcessId[] {
  const out: ProcessId[] = [];
  for (const n of names ?? []) {
    const id = isProcessId(n) ? n : processFromText(n);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

export interface AvailabilitySource {
  workshop?: readonly string[];
  canOrder?: readonly string[];
}

/**
 * What this project can use: the brief's workshop: list replaces the processes
 * the user owns, its can_order: list replaces the ones they can order, and
 * either one left out comes from Settings (where a process you own can also be
 * ordered). Owning a process wins over ordering it.
 */
export function availability(brief: AvailabilitySource | null | undefined, saved: Partial<Record<string, Access>> | undefined): { access: Availability; fromBrief: boolean } {
  const base = fullAccess(saved);
  const own = brief?.workshop ? new Set(processList(brief.workshop)) : new Set(PROCESS_IDS.filter((id) => base[id] === "own"));
  // a process you own at home can still be ordered when this design's workshop is somewhere else
  const order = brief?.canOrder ? new Set(processList(brief.canOrder)) : new Set(PROCESS_IDS.filter((id) => base[id] !== "none"));
  const access = {} as Availability;
  for (const id of PROCESS_IDS) access[id] = own.has(id) ? "own" : order.has(id) ? "order" : "none";
  return { access, fromBrief: !!(brief?.workshop || brief?.canOrder) };
}

export const usable = (a: Availability) => PROCESS_IDS.filter((id) => a[id] !== "none");

/** One line for Claude and for tooltips: what the user owns, can order and cannot use. */
export function availabilityText(a: Availability, fromBrief: boolean): string {
  const by = (x: Access) => PROCESS_IDS.filter((id) => a[id] === x);
  const names = (ids: ProcessId[]) => ids.map((id) => `${PROCESSES[id].short} (${id})`).join(", ");
  const own = by("own");
  const order = by("order");
  const none = by("none");
  const parts = [
    own.length ? `Has: ${names(own)}.` : "Owns no machines Kerf knows about.",
    order.length ? `Can order: ${names(order)}.` : "Cannot order anything.",
    none.length ? `Not available: ${names(none)}.` : "",
  ].filter(Boolean);
  return `${parts.join(" ")} (${fromBrief ? "set in this project's brief" : "from Settings"})`;
}
