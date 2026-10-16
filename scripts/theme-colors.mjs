#!/usr/bin/env node
// Keeps CSS on the theme tokens, so it works in both the light and dark themes.
//
//   node scripts/theme-colors.mjs            list raw colours that ignore the theme
//   node scripts/theme-colors.mjs --fix      move the ones that match a token onto it
//   node scripts/theme-colors.mjs a.css ...  only these files
//
// --fix rewrites a hex that is exactly a dark token as var(--token), and an
// rgba() whose colour is (or is within a few steps of) a token's channels as
// rgb(var(--token-rgb) / alpha). Token definitions (lines starting --name:)
// are left alone. Whatever is left is listed for a person to decide: a light
// theme value in styles/theme.css, a new token, or a colour that is the same
// in both themes (mark those with a /* theme: same */ comment on the line).

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const fix = process.argv.includes("--fix");
const named = process.argv.slice(2).filter((a) => !a.startsWith("--"));

// the dark theme's tokens are the source of truth
const rootBlock = readFileSync(join(root, "src/styles/app.css"), "utf8").match(/:root\s*\{([\s\S]*?)\n\}/)[1];
const hexTokens = new Map();
const channelTokens = [];
for (const m of rootBlock.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
  const [, name, value] = m;
  // a white or a tooltip background could mean anything: never guess those
  if (["on-accent", "tip-bg", "glass", "scrim", "ink-rgb", "shade-rgb"].includes(name)) continue;
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(hex) && !hexTokens.has(hex)) hexTokens.set(hex, name);
  const ch = value.trim().match(/^(\d+) (\d+) (\d+)$/);
  if (ch) channelTokens.push({ name, rgb: ch.slice(1).map(Number) });
}

/** The channel token for a colour: exact for status colours, nearby for the dark surfaces. */
function channelToken(rgb) {
  let best = null;
  for (const t of channelTokens) {
    const d = Math.hypot(...t.rgb.map((v, i) => v - rgb[i]));
    const near = /^(bg-\d|line|text|text-2)-rgb$/.test(t.name) ? 8 : 0;
    if (d <= near && (!best || d < best.d)) best = { ...t, d };
  }
  return best?.name ?? null;
}

const RGBA = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+%?)\s*)?\)/g;
const HEX = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/g;

function cssFiles(dir) {
  const out = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...cssFiles(p));
    else if (f.endsWith(".css") && f !== "theme.css") out.push(p);
  }
  return out;
}

const files = named.length ? named.map((f) => join(process.cwd(), f)) : cssFiles(join(root, "src"));
let left = 0;
let moved = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*--[\w-]+\s*:/.test(line) || line.includes("theme: same")) continue;
    let next = line;
    if (fix) {
      next = next.replace(RGBA, (whole, r, g, b, a) => {
        const t = channelToken([+r, +g, +b]);
        if (!t) return whole;
        moved++;
        return `rgb(var(--${t}) / ${a ?? 1})`;
      });
      next = next.replace(HEX, (whole) => {
        const t = whole.length === 7 && hexTokens.get(whole.toLowerCase());
        if (!t) return whole;
        moved++;
        return `var(--${t})`;
      });
      lines[i] = next;
    }
    const raw = [...next.matchAll(RGBA)].map((m) => m[0]).concat(next.match(HEX) ?? []);
    if (raw.length) {
      left += raw.length;
      console.log(`${relative(root, file)}:${i + 1}  ${raw.join("  ")}  │ ${next.trim().slice(0, 90)}`);
    }
  }
  if (fix) {
    const out = lines.join("\n");
    if (out !== src) writeFileSync(file, out);
  }
}
if (fix) console.log(`\nmoved ${moved} colours onto theme tokens`);
console.log(`${left} raw colours left`);
