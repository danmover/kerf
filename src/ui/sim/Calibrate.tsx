// Calibrate from the real machine: the bench test's serial log (captured over
// USB, opened from a file or pasted) fitted to each gearmotor and the battery,
// shown against what the simulation used, and written back to the design as
// `measured:` so every simulation runs on the real machine's numbers.

import { useMemo, useState } from "react";
import { commitSource } from "../../app/project";
import { toast } from "../../app/ui";
import { evaluateOnly, useDesign } from "../../core/engine";
import type { Model } from "../../core/model";
import { fmtNum } from "../../lang/values";
import { applyFits, benchScenario, calibrateUnavailable, fitBench, parseBench, type CalFit } from "../../sim/calibrate";
import { setBlockProps } from "../../core/sourceEdit";
import { Icon } from "../icons";

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}
const serialApi = () => (navigator as Navigator & { serial?: { requestPort(): Promise<SerialPortLike> } }).serial;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Open the port, start the bench test and collect what it prints until "cal end". */
async function captureBench(onText: (t: string) => void): Promise<string> {
  const port = await serialApi()!.requestPort();
  await port.open({ baudRate: 115200 });
  let text = "";
  const reader = port.readable!.getReader();
  const decoder = new TextDecoder();
  let done = false;
  const reading = (async () => {
    while (!done) {
      const { value, done: end } = await reader.read();
      if (end) break;
      text += decoder.decode(value, { stream: true });
      onText(text);
    }
  })().catch(() => undefined);
  try {
    // opening the port resets most Arduinos: let it boot first
    for (let t = 0; t < 4000 && !/ready/.test(text); t += 100) await wait(100);
    const writer = port.writable!.getWriter();
    await writer.write(new TextEncoder().encode("b\n"));
    writer.releaseLock();
    for (let t = 0; t < 90_000 && !/cal end/.test(text); t += 200) await wait(200);
  } finally {
    done = true;
    await reader.cancel().catch(() => undefined);
    await reading;
    reader.releaseLock();
    await port.close().catch(() => undefined);
  }
  return text;
}

const change = (before: number, after: number) => {
  const p = ((after - before) / before) * 100;
  return Math.abs(p) < 0.5 ? "same" : `${p > 0 ? "+" : ""}${fmtNum(p, 0)} %`;
};

/** Three significant figures, torque in N·m. */
const shown = (v: number, unit: string) => (unit === "N·mm" ? `${fmtNum(Number((v / 1000).toPrecision(3)), 3)} N·m` : `${fmtNum(Number(v.toPrecision(3)), 3)} ${unit}`);

export function Calibrate({ model, onDone }: { model: Model; onDone?: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<"usb" | "sim" | null>(null);
  const why = calibrateUnavailable(model);
  const result = useMemo(() => (text.trim() ? fitBench(model, parseBench(text)) : null), [model, text]);
  const measured = (model.machine?.components ?? []).filter((c) => c.measured);

  const usb = async () => {
    setBusy("usb");
    try {
      setText(await captureBench(setText));
    } catch (e) {
      // closing the port picker is not a failure
      if ((e as Error).name !== "NotFoundError") toast({ kind: "warn", title: "Could not read the machine over USB", detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const simulate = async () => {
    setBusy("sim");
    try {
      const { runSpec } = await import("../../sim/build");
      const m = evaluateOnly(`${useDesign.getState().source.replace(/\s*$/, "")}\n\n${benchScenario(model)}\n`);
      const def = m.scenarios?.at(-1);
      if (!def || !m.machine) throw new Error(m.diagnostics.find((d) => d.severity === "error")?.message ?? "the bench test could not be set up");
      const v = runSpec({ ...def.spec, variants: ["expected"] }, m.machine, m.name).variants[0];
      setText(v.serial.filter((l) => l.dir === "out").map((l) => l.text).join("\n"));
    } catch (e) {
      toast({ kind: "warn", title: "The simulated bench test did not run", detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const use = (fits: CalFit[]) => {
    commitSource(applyFits(useDesign.getState().source, fits), "you", `Calibrated ${fits.map((f) => f.comp).join(", ")} from a bench test`);
    toast({ kind: "success", title: "The simulation now uses the measured numbers", detail: "Scenarios run again with them. The checks keep the maker's ratings." });
  };

  const reset = () => {
    let src = useDesign.getState().source;
    for (const c of measured) src = setBlockProps(src, c.name, { measured: null });
    commitSource(src, "you", "Back to catalog values for the simulation");
  };

  return (
    <div className="sim-empty cal">
      {onDone && (
        <button className="btn sm ghost" style={{ float: "right" }} onClick={onDone}>
          <Icon.X size={12} /> back
        </button>
      )}
      <h3>Calibrate from the real machine</h3>
      <div className="muted" style={{ maxWidth: 680, fontSize: 12.5, lineHeight: 1.55 }}>
        The simulation runs on the catalog's numbers for each motor and the battery, and real ones differ: a motor turns a little slower, a tired pack sags more. A bench test on the real machine measures them in about {fmtNum(4 + 4.5 * (model.machine?.components.filter((c) => c.kind === "gearmotor").length ?? 0), 0)} seconds, and every simulation then runs on the measured numbers. The checks keep the maker's ratings.
      </div>
      {why ? (
        <div className="sim-note" style={{ marginTop: 12 }}>{why}</div>
      ) : (
        <>
          <ol className="cal-steps">
            <li>Upload the firmware from the build pack to the controller.</li>
            <li>Prop the machine up so every motor turns freely, and keep it still while the test runs.</li>
            <li>{serialApi() ? "Connect over USB below, or open" : "Open"} a serial monitor at 115200 baud, type b, press Enter, and paste everything it prints here.</li>
          </ol>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {serialApi() && (
              <button className="btn sm" disabled={!!busy} onClick={usb}>
                {busy === "usb" ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon.Play size={12} />} {busy === "usb" ? "Running the bench test" : "Connect over USB and run it"}
              </button>
            )}
            <label className="btn sm ghost">
              <Icon.Upload size={12} /> Open a log file
              <input
                type="file"
                accept=".txt,.log,text/plain"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setText(await f.text());
                  e.target.value = "";
                }}
              />
            </label>
            <button className="btn sm ghost" disabled={!!busy} onClick={simulate} data-tip="Run the bench test on the simulation to see what it prints">
              {busy === "sim" ? <span className="spinner" style={{ width: 11, height: 11, borderWidth: 1.5 }} /> : <Icon.Flask size={12} />} Try it on the simulation
            </button>
            {measured.length > 0 && (
              <button className="btn sm ghost" onClick={reset} data-tip={`Remove measured: from ${measured.map((c) => c.name).join(", ")}`}>
                <Icon.Undo size={12} /> Back to catalog values
              </button>
            )}
          </div>
          <textarea className="cal-log mono" value={text} spellCheck={false} aria-label="Bench test log" placeholder={"cal start: hold the machine still with every motor free to turn\ncal rest vbat=12.41\ncal m_front peak_amps=8.95 peak_vbat=12.08 free_amps=0.26 free_rpm=29.1 free_vbat=12.38\ncal end"} onChange={(e) => setText(e.target.value)} />
          {measured.length > 0 && !result && <div className="sim-note">Using measured numbers for {measured.map((c) => c.name).join(", ")}.</div>}
          {result && (
            <>
              {result.problems.length > 0 && (
                <ul className="sim-note cal-problems">
                  {result.problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
              {result.fits.map((f) => (
                <div key={f.comp} className="cal-fit">
                  <div className="sim-h">{f.comp}</div>
                  <table className="bom">
                    <thead>
                      <tr>
                        <th>Value</th>
                        <th>Simulation used</th>
                        <th>Measured</th>
                        <th>Change</th>
                      </tr>
                    </thead>
                    <tbody>
                      {f.fields.map((x) => (
                        <tr key={x.key}>
                          <td>
                            {x.label}
                            {x.derived && <small className="dim"> worked out</small>}
                          </td>
                          <td className="mono">{shown(x.before, x.unit)}</td>
                          <td className="mono">{shown(x.measured, x.unit)}</td>
                          <td className={`mono ${Math.abs(x.measured / x.before - 1) > 0.15 ? "warn" : ""}`}>{change(x.before, x.measured)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {f.notes.map((n) => (
                    <div key={n} className="sim-note">
                      {n}
                    </div>
                  ))}
                </div>
              ))}
              {result.fits.length > 0 && (
                <button className="btn primary" style={{ marginTop: 12 }} onClick={() => use(result.fits)}>
                  <Icon.Check size={13} /> Use these numbers
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
