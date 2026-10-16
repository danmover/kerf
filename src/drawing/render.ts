// Sheet renderers: SVG (for files and for showing the assistant a drawing),
// PDF (hand-written, base-14 Helvetica, one page per sheet) and DXF R12
// (layers per line type, 1:1 paper millimetres).

import { PENS, type Pen, type Sheet, type Shape } from "./sheet";
import { textWidth, winAnsi } from "./text";

const FONT = "Helvetica, Arial, 'Liberation Sans', sans-serif";

export interface SvgTheme {
  paper: string;
  ink: string;
  hidden: string;
  center: string;
  thin: string;
  hatch: string;
}

export const PAPER: SvgTheme = { paper: "#ffffff", ink: "#111111", hidden: "#111111", center: "#111111", thin: "#111111", hatch: "#111111" };

const r2 = (n: number) => Math.round(n * 1000) / 1000;

export function xmlEscape(s: string) {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** SVG path data for a non-text shape. */
export function pathData(s: Shape): string {
  switch (s.t) {
    case "line":
      return `M${r2(s.p[0])} ${r2(s.p[1])}L${r2(s.p[2])} ${r2(s.p[3])}`;
    case "poly":
    case "fill": {
      let d = `M${r2(s.p[0])} ${r2(s.p[1])}`;
      for (let i = 2; i < s.p.length; i += 2) d += `L${r2(s.p[i])} ${r2(s.p[i + 1])}`;
      if (s.t === "fill" || s.closed) d += "Z";
      return d;
    }
    case "arc": {
      const [cx, cy] = s.c;
      const pt = (a: number) => `${r2(cx + s.r * Math.cos(a))} ${r2(cy - s.r * Math.sin(a))}`;
      if (s.a1 - s.a0 >= Math.PI * 2 - 1e-9) return `M${pt(0)}A${r2(s.r)} ${r2(s.r)} 0 1 0 ${pt(Math.PI)}A${r2(s.r)} ${r2(s.r)} 0 1 0 ${pt(0)}Z`;
      const large = s.a1 - s.a0 > Math.PI ? 1 : 0;
      return `M${pt(s.a0)}A${r2(s.r)} ${r2(s.r)} 0 ${large} 0 ${pt(s.a1)}`;
    }
    default:
      return "";
  }
}

export function penColor(pen: Pen, t: SvgTheme): string {
  return pen === "hidden" ? t.hidden : pen === "center" || pen === "cutting" || pen === "phantom" ? t.center : pen === "hatch" ? t.hatch : pen === "thin" || pen === "fill" ? t.thin : t.ink;
}

/** A standalone SVG document of a sheet in millimetres. */
export function sheetToSvg(sheet: Sheet, theme: SvgTheme = PAPER): string {
  const out: string[] = [];
  out.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${sheet.w}mm" height="${sheet.h}mm" viewBox="0 0 ${sheet.w} ${sheet.h}">`);
  out.push(`<title>${xmlEscape(sheet.title)}</title>`);
  out.push(`<rect x="0" y="0" width="${sheet.w}" height="${sheet.h}" fill="${theme.paper}"/>`);
  // one path per line type keeps files small
  const byPen = new Map<Pen, string[]>();
  for (const s of sheet.shapes) {
    if (s.t === "text") continue;
    const list = byPen.get(s.pen) ?? [];
    list.push(pathData(s));
    byPen.set(s.pen, list);
  }
  const order: Pen[] = ["hatch", "thin", "center", "phantom", "cutting", "hidden", "frame", "visible", "border", "fill"];
  for (const pen of order) {
    const d = byPen.get(pen);
    if (!d?.length) continue;
    const p = PENS[pen];
    const color = penColor(pen, theme);
    if (pen === "fill") out.push(`<path d="${d.join("")}" fill="${color}" stroke="none"/>`);
    else out.push(`<path d="${d.join("")}" fill="none" stroke="${color}" stroke-width="${p.w}" stroke-linecap="round" stroke-linejoin="round"${p.dash ? ` stroke-dasharray="${p.dash.join(" ")}"` : ""}/>`);
  }
  out.push(`<g font-family="${FONT}" fill="${theme.thin}">`);
  for (const s of sheet.shapes) if (s.t === "text") out.push(svgText(s));
  out.push(`</g></svg>`);
  return out.join("\n");
}

export function svgText(s: Extract<Shape, { t: "text" }>): string {
  const anchor = s.anchor === "start" ? "" : ` text-anchor="${s.anchor}"`;
  const rot = s.rot ? ` transform="rotate(${r2(-s.rot)} ${r2(s.at[0])} ${r2(s.at[1])})"` : "";
  const bold = s.bold ? ` font-weight="bold"` : "";
  return `<text x="${r2(s.at[0])}" y="${r2(s.at[1])}" font-size="${r2(s.size)}"${anchor}${rot}${bold}>${xmlEscape(s.s)}</text>`;
}

// ---------- PDF ----------

const PT = 72 / 25.4;

/** Cubic Bézier segments approximating an arc (paper angles, sheet y down). */
function arcBeziers(cx: number, cy: number, r: number, a0: number, a1: number): number[][] {
  const out: number[][] = [];
  const n = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2)));
  const step = (a1 - a0) / n;
  const k = (4 / 3) * Math.tan(step / 4);
  for (let i = 0; i < n; i++) {
    const s0 = a0 + i * step;
    const s1 = s0 + step;
    const p0 = [cx + r * Math.cos(s0), cy - r * Math.sin(s0)];
    const p3 = [cx + r * Math.cos(s1), cy - r * Math.sin(s1)];
    const p1 = [p0[0] - k * r * Math.sin(s0), p0[1] - k * r * Math.cos(s0)];
    const p2 = [p3[0] + k * r * Math.sin(s1), p3[1] + k * r * Math.cos(s1)];
    out.push([...p0, ...p1, ...p2, ...p3]);
  }
  return out;
}

function pdfString(s: string): string {
  let out = "(";
  for (const ch of s) {
    const b = winAnsi(ch);
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += "\\" + String.fromCharCode(b);
    else if (b < 32 || b > 126) out += "\\" + b.toString(8).padStart(3, "0");
    else out += String.fromCharCode(b);
  }
  return out + ")";
}

const f3 = (n: number) => {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? "0" : String(v);
};

function pageContent(sheet: Sheet): string {
  const H = sheet.h * PT;
  const X = (x: number) => f3(x * PT);
  const Y = (y: number) => f3(H - y * PT);
  const ops: string[] = ["1 J 1 j"];
  const byPen = new Map<Pen, Shape[]>();
  for (const s of sheet.shapes) {
    if (s.t === "text") continue;
    byPen.set(s.pen, [...(byPen.get(s.pen) ?? []), s]);
  }
  const order: Pen[] = ["hatch", "thin", "center", "phantom", "cutting", "hidden", "frame", "visible", "border", "fill"];
  for (const pen of order) {
    const list = byPen.get(pen);
    if (!list) continue;
    const p = PENS[pen];
    if (pen === "fill") ops.push("0 g");
    else ops.push(`0 G ${f3(p.w * PT)} w [${(p.dash ?? []).map((d) => f3(d * PT)).join(" ")}] 0 d`);
    for (const s of list) {
      if (s.t === "line") ops.push(`${X(s.p[0])} ${Y(s.p[1])} m ${X(s.p[2])} ${Y(s.p[3])} l S`);
      else if (s.t === "poly" || s.t === "fill") {
        let d = `${X(s.p[0])} ${Y(s.p[1])} m`;
        for (let i = 2; i < s.p.length; i += 2) d += ` ${X(s.p[i])} ${Y(s.p[i + 1])} l`;
        ops.push(d + (s.t === "fill" ? " h f" : s.closed ? " h S" : " S"));
      } else if (s.t === "arc") {
        const segs = arcBeziers(s.c[0], s.c[1], s.r, s.a0, Math.min(s.a1, s.a0 + Math.PI * 2));
        let d = `${X(segs[0][0])} ${Y(segs[0][1])} m`;
        for (const b of segs) d += ` ${X(b[2])} ${Y(b[3])} ${X(b[4])} ${Y(b[5])} ${X(b[6])} ${Y(b[7])} c`;
        ops.push(d + " S");
      }
    }
  }
  ops.push("0 g");
  for (const s of sheet.shapes) {
    if (s.t !== "text") continue;
    const w = textWidth(s.s, s.size, s.bold);
    const a = ((s.rot ?? 0) * Math.PI) / 180;
    const off = s.anchor === "start" ? 0 : s.anchor === "middle" ? -w / 2 : -w;
    const x = s.at[0] + off * Math.cos(a);
    const y = s.at[1] - off * Math.sin(a);
    const c = Math.cos(a);
    const sn = Math.sin(a);
    ops.push(`BT /${s.bold ? "F2" : "F1"} ${f3(s.size * PT)} Tf ${f3(c)} ${f3(sn)} ${f3(-sn)} ${f3(c)} ${X(x)} ${Y(y)} Tm ${pdfString(s.s)} Tj ET`);
  }
  return ops.join("\n");
}

/** A PDF with one page per sheet. */
export function sheetsToPdf(sheets: Sheet[], title = "Drawing"): Uint8Array {
  const objs: string[] = [];
  const add = (body: string) => {
    objs.push(body);
    return objs.length;
  };
  const catalog = add("");
  const pagesId = add("");
  const f1 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const f2 = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  const kids: number[] = [];
  for (const sh of sheets) {
    const content = pageContent(sh);
    const cid = add(`<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f3(sh.w * PT)} ${f3(sh.h * PT)}] /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >> >> /Contents ${cid} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  const info = add(`<< /Title ${pdfString(title)} /Producer (Kerf) >>`);
  let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // every character is below 256 (Latin-1 bytes)
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

function byteLength(s: string) {
  return s.length;
}

// ---------- DXF ----------

const DXF_LTYPES: Record<string, { desc: string; pattern: number[] }> = {
  DASHED: { desc: "Dashed __ __ __", pattern: [3, -1.5] },
  CENTER: { desc: "Center ____ _ ____", pattern: [8, -1.5, 1.2, -1.5] },
  PHANTOM: { desc: "Phantom ____ _ _ ____", pattern: [6, -1.5, 1.2, -1.5, 1.2, -1.5] },
};

const LAYER_LTYPE: Record<string, string> = { HIDDEN: "DASHED", CENTER: "CENTER", CUTTING: "CENTER", PHANTOM: "PHANTOM" };

function dxfText(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "Ø") out += "%%c";
    else if (ch === "±") out += "%%p";
    else if (ch === "°") out += "%%d";
    else if (ch === "%") out += "%%%";
    else {
      const c = ch.charCodeAt(0);
      out += c >= 32 && c <= 126 ? ch : c >= 0xa0 && c <= 0xff ? ch : ch === "−" || ch === "–" ? "-" : ch === "×" ? "x" : ch === "…" ? "..." : "?";
    }
  }
  return out;
}

/** A DXF R12 file of a sheet at 1:1 paper millimetres. */
export function sheetToDxf(sheet: Sheet): string {
  const g: string[] = [];
  const put = (code: number, v: string | number) => g.push(String(code), typeof v === "number" ? f3(v) : v);
  const Y = (y: number) => sheet.h - y;
  const layers = new Set<string>(["0", "TEXT"]);
  for (const s of sheet.shapes) layers.add(s.t === "text" ? "TEXT" : PENS[s.pen].layer);

  put(0, "SECTION");
  put(2, "HEADER");
  put(9, "$ACADVER");
  put(1, "AC1009");
  put(9, "$INSUNITS");
  put(70, "4");
  put(9, "$MEASUREMENT");
  put(70, "1");
  put(9, "$EXTMIN");
  put(10, 0);
  put(20, 0);
  put(9, "$EXTMAX");
  put(10, sheet.w);
  put(20, sheet.h);
  put(9, "$LTSCALE");
  put(40, 1);
  put(0, "ENDSEC");

  put(0, "SECTION");
  put(2, "TABLES");
  put(0, "TABLE");
  put(2, "LTYPE");
  put(70, String(Object.keys(DXF_LTYPES).length + 1));
  put(0, "LTYPE");
  put(2, "CONTINUOUS");
  put(70, "0");
  put(3, "Solid line");
  put(72, "65");
  put(73, "0");
  put(40, 0);
  for (const [name, lt] of Object.entries(DXF_LTYPES)) {
    put(0, "LTYPE");
    put(2, name);
    put(70, "0");
    put(3, lt.desc);
    put(72, "65");
    put(73, String(lt.pattern.length));
    put(40, lt.pattern.reduce((a, b) => a + Math.abs(b), 0));
    for (const d of lt.pattern) put(49, d);
  }
  put(0, "ENDTAB");
  put(0, "TABLE");
  put(2, "LAYER");
  put(70, String(layers.size));
  for (const name of layers) {
    const pen = (Object.keys(PENS) as Pen[]).find((p) => PENS[p].layer === name);
    put(0, "LAYER");
    put(2, name);
    put(70, "0");
    put(62, String(pen ? PENS[pen].color : 7));
    put(6, LAYER_LTYPE[name] ?? "CONTINUOUS");
  }
  put(0, "ENDTAB");
  put(0, "TABLE");
  put(2, "STYLE");
  put(70, "1");
  put(0, "STYLE");
  put(2, "STANDARD");
  put(70, "0");
  put(40, 0);
  put(41, 1);
  put(50, 0);
  put(71, "0");
  put(42, 2.5);
  put(3, "txt");
  put(4, "");
  put(0, "ENDTAB");
  put(0, "ENDSEC");

  put(0, "SECTION");
  put(2, "ENTITIES");
  for (const s of sheet.shapes) {
    const layer = s.t === "text" ? "TEXT" : PENS[s.pen].layer;
    switch (s.t) {
      case "line":
        put(0, "LINE");
        put(8, layer);
        put(10, s.p[0]);
        put(20, Y(s.p[1]));
        put(11, s.p[2]);
        put(21, Y(s.p[3]));
        break;
      case "arc":
        if (s.a1 - s.a0 >= Math.PI * 2 - 1e-9) {
          put(0, "CIRCLE");
          put(8, layer);
          put(10, s.c[0]);
          put(20, Y(s.c[1]));
          put(40, s.r);
        } else {
          put(0, "ARC");
          put(8, layer);
          put(10, s.c[0]);
          put(20, Y(s.c[1]));
          put(40, s.r);
          put(50, (s.a0 * 180) / Math.PI);
          put(51, (s.a1 * 180) / Math.PI);
        }
        break;
      case "poly":
        put(0, "POLYLINE");
        put(8, layer);
        put(66, "1");
        put(10, 0);
        put(20, 0);
        put(70, s.closed ? "1" : "0");
        for (let i = 0; i < s.p.length; i += 2) {
          put(0, "VERTEX");
          put(8, layer);
          put(10, s.p[i]);
          put(20, Y(s.p[i + 1]));
        }
        put(0, "SEQEND");
        put(8, layer);
        break;
      case "fill": {
        // arrowheads and markers as SOLIDs (triangles and quads; larger fills as fans)
        const n = s.p.length / 2;
        for (let k = 1; k + 1 < n; k += 2) {
          const idx = [0, k, k + 1, Math.min(k + 2, n - 1)];
          put(0, "SOLID");
          put(8, layer);
          // SOLID corner order is 1, 2, 4, 3
          const order = [0, 1, 3, 2];
          order.forEach((o, j) => {
            put(10 + j, s.p[idx[o] * 2]);
            put(20 + j, Y(s.p[idx[o] * 2 + 1]));
          });
        }
        break;
      }
      case "text": {
        const h = s.size * 0.72;
        put(0, "TEXT");
        put(8, layer);
        put(10, s.at[0]);
        put(20, Y(s.at[1]));
        put(40, h);
        put(1, dxfText(s.s));
        if (s.rot) put(50, s.rot);
        if (s.anchor !== "start") {
          put(72, s.anchor === "middle" ? "1" : "2");
          put(11, s.at[0]);
          put(21, Y(s.at[1]));
        }
        break;
      }
    }
  }
  put(0, "ENDSEC");
  put(0, "EOF");
  return g.join("\n") + "\n";
}
