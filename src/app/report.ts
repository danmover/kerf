// The design report: one self-contained HTML file (no scripts, images
// inlined) with the brief, pictures, key numbers, every check, the driving
// values and the parts list. It reads well on screen and prints to PDF.
// Everything from the design is escaped: names and notes are user text.

import type { Model } from "../core/model";
import type { CheckReport, CheckItem } from "../core/checks";
import type { DesignStats, BriefSummary } from "./designStats";
import { massText, sizeText } from "./designStats";
import { markSvg } from "../ui/logoGeometry";

export interface ReportInput {
  model: Model;
  report: CheckReport | null;
  stats: DesignStats;
  brief: BriefSummary | null;
  bom: { qty: number; item: string; description: string; standard: string; material: string; kind: string }[];
  versions: number;
  appVersion: string;
  date: Date;
  /** data URLs */
  hero?: string;
  views: { label: string; url: string }[];
}

export const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Only images Kerf rendered itself go into the file. */
const safeImage = (url: string | undefined) => (url && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : null);

const CATEGORY: Record<string, string> = {
  brief: "Brief",
  requirement: "Requirements",
  interference: "Interference",
  access: "Tool access",
  motion: "Motion",
  gears: "Gears",
  analysis: "Strength",
  process: "Manufacturing",
  build: "Build",
  electrical: "Wiring",
  engineering: "Calculations",
  testing: "Physical tests",
  info: "Needs analysis",
};

const STATUS: Record<string, string> = { pass: "pass", fail: "fail", warn: "warn", pending: "pending", info: "note" };

function checksHtml(items: CheckItem[]): string {
  const groups = new Map<string, CheckItem[]>();
  for (const i of items) groups.set(i.category, [...(groups.get(i.category) ?? []), i]);
  const order = (i: CheckItem) => ({ fail: 0, warn: 1, pending: 2, info: 3, pass: 4 })[i.status] ?? 5;
  return [...groups.entries()]
    .map(
      ([cat, list]) =>
        `<h3>${esc(CATEGORY[cat] ?? cat)} <span class="n">${list.length}</span></h3><ul class="checks">${list
          .sort((a, b) => order(a) - order(b))
          .map((i) => `<li class="${esc(i.status)}"><span class="st">${esc(STATUS[i.status] ?? i.status)}</span><div><b>${esc(i.title)}</b>${i.level === "soft" ? ' <span class="soft">soft</span>' : ""}<div class="d">${esc(i.detail)}</div></div></li>`)
          .join("")}</ul>`,
    )
    .join("");
}

export function designReportHtml(r: ReportInput): string {
  const { model, report, stats, brief } = r;
  const fails = report?.counts.fail ?? 0;
  const warns = report?.counts.warn ?? 0;
  const passes = report?.counts.pass ?? 0;
  const verdict = !report ? "Checks not run" : fails ? `${fails} check${fails > 1 ? "s" : ""} failing` : `All ${passes} checks pass`;
  const note = model.notes.join(" ");
  const hero = safeImage(r.hero);
  const views = r.views.map((v) => ({ ...v, url: safeImage(v.url) })).filter((v) => v.url);
  const facts: [string, string][] = [
    ["Overall size", stats.size ? `${sizeText(stats.size)} mm` : "—"],
    ["Mass", massText(stats.mass)],
    ["Parts", `${stats.make} to make · ${stats.buy} to buy`],
    ["Materials", stats.materials.map((m) => m.label).join(", ") || "—"],
  ];
  if (brief?.data.process) facts.push(["Process", brief.data.process]);
  if (brief?.data.quantity) facts.push(["Quantity", String(brief.data.quantity)]);
  const params = model.params.filter((p) => typeof p.value === "number" || typeof p.value === "string");

  const briefHtml = brief
    ? `<section><h2>Brief</h2>${brief.data.purpose ? `<p class="lead">${esc(brief.data.purpose)}</p>` : ""}${brief.data.setting ? `<p>${esc(brief.data.setting)}</p>` : ""}${
        brief.data.priorities.length ? `<p class="tags">${brief.data.priorities.map((p) => `<span>${esc(p)}</span>`).join("")}</p>` : ""
      }${
        brief.uses.length
          ? `<h3>What it must do</h3><ul class="checks">${brief.uses
              .map((u) => `<li class="${u.status === "unchecked" ? "pending" : esc(u.status)}"><span class="st">${u.status === "unchecked" ? "no check" : esc(STATUS[u.status])}</span><div><b>${esc(u.text)}</b>${u.assumed ? ' <span class="soft">assumed</span>' : ""}</div></li>`)
              .join("")}</ul>`
          : ""
      }${brief.toConfirm ? `<p class="muted">${brief.toConfirm} assumption${brief.toConfirm > 1 ? "s" : ""} still to confirm.</p>` : ""}</section>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Kerf ${esc(r.appVersion)}">
<title>${esc(model.name || "Design")} · design report</title>
<style>
:root{--ink:#141824;--ink2:#4a5370;--ink3:#7d86a0;--line:#e3e6ef;--bg:#f6f7fb;--card:#fff;--acc:#4f63e6;--pass:#11a36b;--warn:#c98300;--fail:#d93a4a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}
.page{max-width:1080px;margin:0 auto;padding:40px 32px 60px}
header{display:flex;align-items:center;gap:16px;margin-bottom:24px}
header h1{margin:0;font-size:30px;letter-spacing:-.01em}
header .sub{color:var(--ink3);font:12.5px "IBM Plex Mono",ui-monospace,monospace}
.verdict{margin-left:auto;padding:8px 14px;border-radius:999px;font:600 13px "IBM Plex Mono",monospace;white-space:nowrap}
.verdict.ok{background:#e3f7ee;color:var(--pass)}.verdict.bad{background:#fde7ea;color:var(--fail)}
.hero{border-radius:16px;overflow:hidden;background:#0b0e14;box-shadow:0 18px 40px -20px rgba(20,24,36,.45)}
.hero img{display:block;width:100%;height:auto}
.views{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:12px}
.views figure{margin:0;border-radius:12px;overflow:hidden;background:#0b0e14;position:relative}
.views img{display:block;width:100%;height:auto}
.views figcaption{position:absolute;left:10px;top:8px;color:#c9d2ea;font:500 11px "IBM Plex Mono",monospace;text-transform:uppercase;letter-spacing:.08em}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:22px 0}
.facts div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.facts dt{color:var(--ink3);font:500 11px "IBM Plex Mono",monospace;text-transform:uppercase;letter-spacing:.08em}
.facts dd{margin:4px 0 0;font-weight:600;font-size:15px}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-top:16px;break-inside:avoid-page}
h2{margin:0 0 10px;font-size:18px}h3{margin:16px 0 6px;font-size:13px;color:var(--ink2);text-transform:uppercase;letter-spacing:.06em}
h3 .n{color:var(--ink3);font-weight:400}
.lead{font-size:16px;margin:0 0 6px}.muted{color:var(--ink3)}
.tags span{display:inline-block;margin:0 6px 6px 0;padding:2px 9px;border-radius:999px;background:#eef0fb;color:var(--acc);font-size:12px}
ul.checks{list-style:none;margin:0;padding:0}
ul.checks li{display:flex;gap:12px;padding:8px 0;border-top:1px solid var(--line)}
ul.checks li:first-child{border-top:0}
.st{flex:none;width:68px;text-align:center;height:20px;line-height:20px;border-radius:6px;font:600 10.5px "IBM Plex Mono",monospace;text-transform:uppercase}
li.pass .st{background:#e3f7ee;color:var(--pass)}li.fail .st{background:#fde7ea;color:var(--fail)}li.warn .st{background:#fff3dc;color:var(--warn)}
li.pending .st,li.info .st{background:#eef0f5;color:var(--ink3)}
.d{color:var(--ink2);font-size:13px}.soft{font:500 10px "IBM Plex Mono",monospace;color:var(--ink3);border:1px solid var(--line);border-radius:4px;padding:0 4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--ink3);font:500 11px "IBM Plex Mono",monospace;text-transform:uppercase;letter-spacing:.06em;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid var(--line);vertical-align:top}
td.mono,td.num{font-family:"IBM Plex Mono",monospace;font-size:12.5px}td.num{text-align:right;white-space:nowrap}
footer{margin-top:28px;color:var(--ink3);font:12px "IBM Plex Mono",monospace}
@media (max-width:700px){.views{grid-template-columns:1fr}header{flex-wrap:wrap}.verdict{margin-left:0}}
@media print{body{background:#fff}.page{padding:0}section,.facts div{border-color:#d6dae5}.hero,.views figure{box-shadow:none}@page{margin:14mm}}
</style></head><body><div class="page">
<header>${markSvg(52, 0.07, "rk")}<div><h1>${esc(model.name || "Design")}</h1><div class="sub">Design report · ${esc(r.date.toISOString().slice(0, 10))} · ${r.versions} version${r.versions === 1 ? "" : "s"} · Kerf ${esc(r.appVersion)}</div></div>
<div class="verdict ${fails ? "bad" : "ok"}">${esc(verdict)}${warns ? ` · ${warns} warning${warns > 1 ? "s" : ""}` : ""}</div></header>
${note ? `<p class="lead" style="margin:0 0 18px">${esc(note)}</p>` : ""}
${hero ? `<div class="hero"><img alt="Isometric view" src="${hero}"></div>` : ""}
${views.length ? `<div class="views">${views.map((v) => `<figure><img alt="${esc(v.label)} view" src="${v.url}"><figcaption>${esc(v.label)}</figcaption></figure>`).join("")}</div>` : ""}
<dl class="facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl>
${briefHtml}
<section><h2>Checks</h2>${report ? checksHtml(report.items) : '<p class="muted">The checks had not run when this report was made.</p>'}</section>
${
  params.length
    ? `<section><h2>Driving values</h2><table><thead><tr><th>Name</th><th>Value</th><th>What it sets</th></tr></thead><tbody>${params
        .map((p) => `<tr><td class="mono">${esc(p.name)}${p.locked ? ' <span class="soft">locked</span>' : ""}</td><td class="num">${esc(p.text)}</td><td>${esc(p.desc ?? "")}</td></tr>`)
        .join("")}</tbody></table></section>`
    : ""
}
${
  r.bom.length
    ? `<section><h2>Parts list</h2><table><thead><tr><th>Qty</th><th>Make / buy</th><th>Item</th><th>Description</th><th>Material</th><th>Standard</th></tr></thead><tbody>${r.bom
        .map((b) => `<tr><td class="num">${b.qty}</td><td>${esc(b.kind)}</td><td class="mono">${esc(b.item)}</td><td>${esc(b.description)}</td><td>${esc(b.material)}</td><td class="mono">${esc(b.standard)}</td></tr>`)
        .join("")}</tbody></table></section>`
    : ""
}
<footer>Made with Kerf ${esc(r.appVersion)}. Units: millimetres. Strength checks are estimates from a simplified model: test a part before you rely on it.</footer>
</div></body></html>
`;
}
