// The parts catalog: purchasable parts with real specs, pins, shapes and
// where to buy them. Designs use them as lib.<kind>("id") components.

import type { CatalogKind, CatalogPart } from "../types";
import { AUDIO } from "./audio";
import { ELECTRONICS } from "./electronics";
import { MOTION } from "./motion";

export const CATALOG: CatalogPart[] = [...ELECTRONICS, ...MOTION, ...AUDIO];

const BY_ID = new Map(CATALOG.map((p) => [p.id, p]));

export function catalogPart(id: string): CatalogPart | undefined {
  return BY_ID.get(id);
}

export const CATALOG_KINDS: CatalogKind[] = [...new Set(CATALOG.map((p) => p.kind))];

export function catalogOfKind(kind: string): CatalogPart[] {
  return CATALOG.filter((p) => p.kind === kind);
}

/** Simple ranked text search over ids, names, summaries and specs. */
export function searchCatalog(query: string, kind?: string, limit = 12): CatalogPart[] {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9.]+/)
    .filter((w) => w.length > 1);
  const scored = CATALOG.filter((p) => !kind || p.kind === kind).map((p) => {
    const hay = `${p.id} ${p.name} ${p.kind} ${p.maker ?? ""} ${p.mpn ?? ""} ${p.summary} ${Object.entries(p.specs)
      .map(([k, v]) => `${k} ${v}`)
      .join(" ")}`.toLowerCase();
    let score = 0;
    for (const w of words) if (hay.includes(w)) score += p.id.includes(w) || p.name.toLowerCase().includes(w) ? 3 : 1;
    return { p, score };
  });
  return scored
    .filter((s) => s.score > 0 || !words.length)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.p);
}

export interface ShopLink {
  vendor: string;
  url: string;
  /** a maker or distributor product page rather than a search */
  direct: boolean;
}

/** Marketplace searches never go stale, so every part gets them as a fallback. */
export function searchLinks(text: string): ShopLink[] {
  const q = encodeURIComponent(text);
  return [
    { vendor: "Amazon", url: `https://www.amazon.com/s?k=${q}`, direct: false },
    { vendor: "AliExpress", url: `https://www.aliexpress.com/wholesale?SearchText=${q}`, direct: false },
  ];
}

export function shopLinks(p: CatalogPart): ShopLink[] {
  const out: ShopLink[] = [];
  for (const b of p.buy) {
    if (b.url) out.push({ vendor: b.vendor, url: b.url, direct: true });
    else if (b.search) out.push(...searchLinks(b.search));
  }
  if (!out.some((l) => !l.direct)) out.push(...searchLinks(p.mpn ? `${p.maker ?? ""} ${p.mpn}`.trim() : p.name));
  return out;
}

const shortSpec = (p: CatalogPart): string => {
  const s = p.specs;
  const nm = (x: unknown) => (typeof x === "number" ? (x / 1000).toFixed(2) : "?");
  switch (p.kind) {
    case "gearmotor":
      return `${s.v_rated}V ${s.rpm_free}rpm stall ${nm(s.t_stall)}N·m ${s.i_stall}A`;
    case "stepper":
      return `${s.i_rated}A ${nm(s.t_hold)}N·m hold`;
    case "servo":
      return `${nm(s.t_stall)}N·m ${s.v_min}-${s.v_max}V`;
    case "actuator":
      return `${s.f_max}N ${s.stroke}mm ${s.v_rated}V`;
    case "motor_driver":
    case "stepper_driver":
      return `${s.channels ?? 1}ch ${s.i_cont}A ${s.v_min}-${s.v_max}V ${s.control}`;
    case "battery":
      return `${s.v_nom}V ${s.capacity_mah}mAh ${s.i_cont}A`;
    case "psu":
    case "regulator":
      return p.summary.split(/(?<=\.)\s+/)[0].replace(/\.$/, "");
    default:
      return p.summary.split(/(?<=\.)\s+/)[0].replace(/\.$/, "");
  }
};

/** One line per part, for Claude's language reference. */
export function catalogTable(): string {
  const lines: string[] = [];
  for (const kind of CATALOG_KINDS) {
    lines.push(`${kind}:`);
    for (const p of catalogOfKind(kind)) lines.push(`  ${p.id} | ${p.name} | ${shortSpec(p)}`);
  }
  return lines.join("\n");
}

/** Full detail of one part for Claude: specs, pins, fields and notes. */
export function describePart(p: CatalogPart): string {
  const pins = p.pins
    .map((pin) => {
      const bits: string[] = [pin.type];
      if (pin.v != null) bits.push(`${pin.v}V`);
      if (pin.vmin != null || pin.vmax != null) bits.push(`${pin.vmin ?? "?"}-${pin.vmax ?? "?"}V`);
      if (pin.imax != null) bits.push(`${pin.imax}A`);
      if (pin.pwm) bits.push("pwm");
      if (pin.adc) bits.push("adc");
      if (pin.input_only) bits.push("input-only");
      if (pin.needs) bits.push(`needs ${pin.needs}`);
      if (pin.bus) bits.push(pin.bus);
      if (pin.port) bits.push(`${pin.port} ${pin.side}`);
      if (pin.need_a) bits.push(`needs ${pin.need_a}A`);
      if (pin.need_w) bits.push(`needs ${pin.need_w}W`);
      if (pin.required) bits.push("required");
      return `${pin.id}${pin.label ? ` "${pin.label}"` : ""} (${bits.join(", ")})${pin.note ? `: ${pin.note}` : ""}`;
    })
    .join("\n  ");
  return [
    `${p.id}: ${p.name}${p.generic ? " (generic part, specs vary by seller)" : ""}`,
    p.summary,
    `kind: ${p.kind}${p.maker ? `, maker: ${p.maker}` : ""}${p.mpn ? `, part no: ${p.mpn}` : ""}${p.price_usd ? `, about $${p.price_usd}` : ""}`,
    `specs: ${Object.entries(p.specs)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`,
    p.pins.length ? `pins:\n  ${pins}` : "pins: none (mechanical)",
    `shape: ${p.geom.g} ${Object.entries(p.geom.dims)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}${p.geom.holes ? `, holes ${JSON.stringify(p.geom.holes)}` : ""}`,
    ...(p.notes ?? []).map((n) => `note: ${n}`),
    ...(p.tests ?? []).map((t) => `test: ${t}`),
    `buy: ${shopLinks(p)
      .map((l) => `${l.vendor} ${l.url}`)
      .join(" | ")}`,
    p.source ? `source: ${p.source}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
