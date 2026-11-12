// Apps, running and saved: the builder's edits to the design file, trying an
// app on the simulated twin headless, the saved-app page and its data, and
// the custom panels' sandbox page.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "../src/lang/evaluator";
import { addPanel, appendApp, movePanel, newPanel, removePanel, renameApp, resizePanel, setAppProps, starterApp } from "../src/apps/source";
import { sandboxHtml } from "../src/apps/runtime/panels";
import { packMesh, unpackMesh, wireParse, wireStringify, type AppBundle } from "../src/apps/wire";
import { desktopProject, SAVED_APP_CSP, standaloneHtml, tokenCss } from "../src/apps/exportDoc";
import { twinFirmware } from "../src/apps/twinFirmware";
import { tryApp } from "../src/apps/tryApp";
import type { TwinOptions } from "../src/apps/twin";
import type { Model } from "../src/core/model";
import { languageReference } from "../src/ai/reference";
import { referenceText } from "../src/ai/leanReference";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const SRC = `design "Rig"
component ctrl = lib.controller("arduino_uno") { at: (0, 0, 0) }
firmware brain { board: ctrl }

app "Bench" {
  about: "A first look"
  telemetry: [csv("T", "ms rpm amps:A")]
  panels: [
    readout("Now", ["rpm", "amps"]),
    chart("Speed", ["rpm"], window: 10s),
    console(),
  ]
}
`;

const appOf = (m: Model, name = "Bench") => m.apps!.find((a) => a.name === name)!;

describe("the app builder's edits", () => {
  it("adds, moves, resizes and removes panels, keeping the rest of the file", () => {
    let src = SRC;
    let m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    src = addPanel(src, appOf(m), newPanel("gauge", ["rpm"]));
    m = evaluate(src);
    expect(appOf(m).panels.map((p) => p.kind)).toEqual(["readout", "chart", "console", "gauge"]);
    src = movePanel(src, appOf(m), 3, 0);
    m = evaluate(src);
    expect(appOf(m).panels.map((p) => p.kind)).toEqual(["gauge", "readout", "chart", "console"]);
    src = resizePanel(src, appOf(m), 2, 5, 3);
    m = evaluate(src);
    expect(appOf(m).panels[2]).toMatchObject({ kind: "chart", w: 5, h: 3, window: 10 });
    src = removePanel(src, appOf(m), 1);
    m = evaluate(src);
    expect(appOf(m).panels.map((p) => p.kind)).toEqual(["gauge", "chart", "console"]);
    expect(src.startsWith('design "Rig"\ncomponent ctrl')).toBe(true);
    expect(src).toContain('about: "A first look"');
  });

  it("changes the app's own properties and its name", () => {
    let src = setAppProps(SRC, appOf(evaluate(SRC)), { about: '"Live"', columns: "4", baud: "57600" });
    let m = evaluate(src);
    expect(appOf(m)).toMatchObject({ about: "Live", columns: 4, baud: 57600 });
    src = setAppProps(src, appOf(m), { about: null });
    m = evaluate(src);
    expect(appOf(m).about).toBeUndefined();
    src = renameApp(src, appOf(m), 'Bench "two"');
    m = evaluate(src);
    expect(m.apps!.map((a) => a.name)).toEqual(['Bench "two"']);
  });

  it("writes a starter app that the language reads", () => {
    const m0 = evaluate(read("src/demos/sand-tunneller.kerf"));
    const src = appendApp(read("src/demos/sand-tunneller.kerf"), starterApp(m0, "Control room", ["fw.state", "front.rpm", "front.amps", "bat.volts"]));
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const app = appOf(m, "Control room");
    expect(app.twin).toBe(m.scenarios![0].label);
    expect(app.panels.map((p) => p.kind)).toContain("console");
  });
});

describe("trying an app on the twin", () => {
  it("runs the tunneller's firmware, types commands and says what each panel shows", () => {
    const m0 = evaluate(read("src/demos/sand-tunneller.kerf"));
    const src = appendApp(
      read("src/demos/sand-tunneller.kerf"),
      `app "Try" {
  panels: [
    readout("Motors", ["m_front.rpm", "m_front.amps", "nothing_here"]),
    console(),
  ]
}`,
    );
    const m = evaluate(src);
    expect(m.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const app = appOf(m, "Try");
    const def = m.scenarios!.find((s) => s.label === app.twin)!;
    const fw = twinFirmware({ machine: m.machine!, designName: m.name, spec: def.spec });
    if ("error" in fw) throw new Error(fw.error);
    const o: TwinOptions = { spec: def.spec, machine: m.machine!, designName: m.name, firmware: fw.name, files: fw.files, board: { mcu: fw.mcu, partId: fw.partId } };
    const r = tryApp(app, o, { seconds: 3, send: [{ at: 1, text: "help" }] });
    expect(r.ran).toBeGreaterThan(2.9);
    expect(r.lines.some((l) => l.text === "> help")).toBe(true);
    // the console's help lists commands after the line is typed
    const after = r.lines.filter((l) => l.t >= 1 && !l.text.startsWith(">"));
    expect(after.length).toBeGreaterThan(2);
    expect(Object.keys(r.channels).some((n) => n.startsWith("m_front."))).toBe(true);
    const motors = r.panels[0].values;
    expect(motors.find((v) => v.expr === "m_front.rpm")!.shows).toBe(true);
    expect(motors.find((v) => v.expr === "nothing_here")!.shows).toBe(false);
    expect(m0.apps).toBeUndefined();
  });
});

describe("a saved app", () => {
  it("carries typed arrays, maps, sets and NaN through its JSON", () => {
    const v = { a: new Float32Array([1.5, -2, 3]), b: new Uint16Array([1, 65535]), m: new Map([["x", 1]]), s: new Set([2, 3]), n: NaN, i: -Infinity, t: "</script><!--  " };
    const text = wireStringify(v);
    expect(text).not.toContain("</script");
    expect(text).not.toContain(" ");
    const back = wireParse<typeof v>(text);
    expect(back.a).toBeInstanceOf(Float32Array);
    expect([...back.a]).toEqual([1.5, -2, 3]);
    expect([...back.b]).toEqual([1, 65535]);
    expect(back.m.get("x")).toBe(1);
    expect(back.s.has(3)).toBe(true);
    expect(Number.isNaN(back.n)).toBe(true);
    expect(back.i).toBe(-Infinity);
    expect(back.t).toBe(v.t);
  });

  it("packs meshes small and unpacks them close to the original", () => {
    const positions = new Float32Array([0, 0, 0, 100, 0, 0, 0, 50, 20]);
    const normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    const e = { bbox: [[0, 0, 0], [100, 50, 20]] as [[number, number, number], [number, number, number]], volume: 1, rev: 0 };
    const w = packMesh("h", e, { positions, normals, indices: new Uint32Array([0, 1, 2]) });
    expect(w.idx).toBeInstanceOf(Uint16Array);
    const back = unpackMesh(wireParse(wireStringify(w)));
    const p = back.preview!.positions;
    for (let i = 0; i < positions.length; i++) expect(Math.abs(p[i] - positions[i])).toBeLessThan(0.01);
    expect(back.preview!.normals[2]).toBeCloseTo(1, 3);
  });

  it("is one page with a locked-down policy, the app's data and its scripts", () => {
    const m = evaluate(SRC);
    const bundle: AppBundle = { v: 1, app: appOf(m), design: { name: "Rig", kerf: "0.1.18", saved: "2026-11-12T00:00:00Z" } };
    const html = standaloneHtml(bundle, { main: 'console.log("</script>")', worker: "self.onmessage=()=>{}" }, tokenCss(read("src/styles/app.css"), read("src/styles/theme.css")) + read("src/styles/apps.css"));
    expect(html).toContain(`content="${SAVED_APP_CSP}"`);
    expect(SAVED_APP_CSP).toContain("connect-src 'none'");
    // only the page's own three scripts close
    expect(html.match(/<\/script>/g)!.length).toBe(3);
    expect(html).toContain("--bg-0:");
    expect(html).toContain(':root[data-theme="light"]');
    const data = /<script type="application\/json" id="kerf-app">([\s\S]*?)<\/script>/.exec(html)![1];
    expect(wireParse<AppBundle>(data).app.name).toBe("Bench");
    const files = desktopProject(bundle, html);
    expect(files.map((f) => f.path)).toEqual(["bench-desktop/package.json", "bench-desktop/main.js", "bench-desktop/index.html", "bench-desktop/README.md"]);
    const pkg = JSON.parse(files[0].data as string);
    expect(pkg.main).toBe("main.js");
    expect(files[1].data).toContain("select-serial-port");
  });
});

describe("custom panels' sandbox", () => {
  it("is the page Kerf serves for it", () => {
    expect(read("public/app-sandbox.html")).toBe(sandboxHtml());
  });

  it("has its own policy on every host", () => {
    const headers = read("public/_headers");
    expect(headers).toMatch(/\/app-sandbox\.html\n\s+Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'/);
    expect(headers).toContain("/assets/twin.worker-*");
  });
});

describe("the reference", () => {
  it("documents app blocks, and the slim prompt can fetch them", () => {
    expect(languageReference()).toContain("## Apps");
    const apps = referenceText("apps");
    expect(apps).toContain("try_app");
    expect(apps).toContain("readout(");
  });
});
