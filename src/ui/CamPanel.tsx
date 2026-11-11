// CNC toolpaths, by hand: a panel over the 3D view where you pick the part, the way the tool comes, how the stock
// is held, the end mills and the machine, and watch the cuts planned on the model while you choose: the paths, the
// tool and the stock cut as you scrub or play through. Save G-code saves the files for the chosen controller.
// Claude's cnc_toolpaths tool plans the same job and can open it here.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SceneController } from "./viewport/scene";
import { CamOverlay, OP_COLORS } from "./viewport/camOverlay";
import { useDesign } from "../core/engine";
import { camPart, camParts, closeCam, jobFor, jobKey, replan, saveGcode, setupChoices, useCam, type CamJob } from "../cam/job";
import { timeline } from "../cam/timeline";
import { POSTS } from "../cam/gcode";
import type { CamTool, Hold, OpKind } from "../cam/plan";
import type { Frame } from "../cam/feeds";
import { frameFit } from "../mfg/materials";
import { Icon } from "./icons";

const HOLDS: { value: Hold; label: string; tip: string }[] = [
  { value: "tabs", label: "Sheet, held by tabs", tip: "Cut out of a sheet screwed or clamped down: the part stays held by small tabs you cut after" },
  { value: "base", label: "Block in a vise", tip: "A block held in a vise or on a fixture: the tool cuts down to the part's bottom and leaves a base under it to cut or face off" },
  { value: "none", label: "Cut right through", tip: "Cut out completely, for stock held by a vacuum table or double-sided tape" },
];
const FRAMES: { value: Frame; label: string }[] = [
  { value: "router", label: "CNC router" },
  { value: "benchtop", label: "Benchtop mill" },
  { value: "vmc", label: "Machining centre" },
];
const MATERIALS = ["Plywood", "MDF", "Hardwood", "HDPE", "Acrylic", "Delrin (POM)", "Nylon", "Aluminum 6061", "Aluminum 7075", "Brass", "Mild steel", "Stainless 304"];
const OP_NAME: Record<OpKind, string> = { face: "Face", rough: "Rough", rest: "Rest", finish: "Finish", drill: "Drill" };
/** how long a play through takes, s */
const PLAY_SECONDS = 24;

const num = (x: number, d = 2) => String(+x.toFixed(d));

export function fmtDuration(s: number): string {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600),
    m = Math.floor((t % 3600) / 60),
    sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** "6 × 22, 3 × 12, drill 2 × 15" (diameter × reach, mm) as tools, or null when it does not read as that. A diameter alone reaches 4 of itself. */
export function parseTools(text: string): CamTool[] | null {
  const parts = text.split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: CamTool[] = [];
  for (const p of parts) {
    const drill = /\bdrill\b/i.test(p);
    const m = /^(\d+(?:\.\d+)?)\s*(?:mm)?\s*(?:[x×*]\s*(\d+(?:\.\d+)?)\s*(?:mm)?)?$/i.exec(p.replace(/\bdrill\b/i, "").trim());
    if (!m) return null;
    const d = parseFloat(m[1]);
    const reach = m[2] ? parseFloat(m[2]) : Math.round((drill ? 8 : 4) * d);
    if (!(d > 0 && d <= 60 && reach > 0 && reach <= 300)) return null;
    out.push(drill ? { d, reach, drill } : { d, reach });
  }
  return out.slice(0, 8);
}

export const toolsText = (tools: CamTool[]) => tools.map((t) => `${t.drill ? "drill " : ""}${num(t.d, 3)} × ${num(t.reach)}`).join(", ");

function NumIn({ label, value, onChange, unit = "mm", step = 1, min = 0, max, tip }: { label: string; value: number; onChange: (v: number) => void; unit?: string; step?: number; min?: number; max?: number; tip?: string }) {
  const [text, setText] = useState(num(value));
  useEffect(() => setText(num(value)), [value]);
  return (
    <label className="mt-num" data-tip={tip}>
      <span className="mono">{label}</span>
      <input
        className="input mono"
        type="number"
        step={step}
        min={min}
        max={max}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= min && (max === undefined || v <= max)) onChange(v);
        }}
      />
      <span className="dim mono">{unit}</span>
    </label>
  );
}

function Pick<T extends string>({ label, value, options, onChange, tip }: { label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; tip?: string }) {
  return (
    <label className="mt-num" data-tip={tip}>
      <span className="mono">{label}</span>
      <select className="select" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const setJob = (patch: Partial<CamJob>) => {
  const j = useCam.getState().job;
  if (j) useCam.setState({ job: { ...j, ...patch } });
};

/** Two or three small numbers on one row: the stock round the part, above and below it. */
function Nums({ label, items, tip }: { label: string; items: { value: number; onChange: (v: number) => void; word: string; tip: string; min?: number }[]; tip?: string }) {
  return (
    <div className="mt-num cam-nums" data-tip={tip}>
      <span className="mono">{label}</span>
      <div className="cam-nums-row">
        {items.map((it) => (
          <SmallNum key={it.tip} {...it} />
        ))}
      </div>
      <span className="dim mono">mm</span>
    </div>
  );
}

function SmallNum({ value, onChange, word, tip, min = 0 }: { value: number; onChange: (v: number) => void; word: string; tip: string; min?: number }) {
  const [text, setText] = useState(num(value));
  useEffect(() => setText(num(value)), [value]);
  return (
    <label className="cam-small" data-tip={tip}>
      <input
        className="input mono"
        type="number"
        step={0.5}
        min={min}
        value={text}
        aria-label={tip}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v >= min) onChange(v);
        }}
      />
      {word && <span className="dim">{word}</span>}
    </label>
  );
}

const OP_SHORT: Record<OpKind, string> = { face: "facing", rough: "roughing", rest: "clearing corners", finish: "finishing walls", drill: "drilling" };

function CamPanel({ stop }: { stop: () => void }) {
  const { job, result, busy, error, planned } = useCam();
  const model = useDesign((s) => s.model);
  const parts = useMemo(() => camParts(model), [model]);
  const part = parts.find((p) => p.id === job?.part);
  const choices = useMemo(() => (part ? setupChoices(part) : []), [part]);
  const [toolText, setToolText] = useState("");
  const [more, setMore] = useState(false);
  const [folded, setFolded] = useState(false);
  useEffect(() => setToolText(job ? toolsText(job.tools) : ""), [job?.part, job?.tools]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!job) return null;
  const key = part ? `${jobKey(job)}|${part.hash}` : "";
  const plan = result?.plan;
  const stale = !!result && planned !== key;
  const fit = frameFit(job.frame, job.material);
  const total = plan?.seconds ?? 0;
  const opStart = (k: number) => (plan ? plan.ops.slice(0, k).reduce((a, o) => a + o.seconds, 0) : 0);
  const st = plan?.stock;
  const setupLabel = choices.find((c) => c.dir.join(",") === job.setup.join(","))?.label ?? "";
  const holdLabel = HOLDS.find((h) => h.value === job.hold)?.label ?? job.hold;

  return (
    <motion.div key="cam" className="vp-float cam-panel" role="dialog" aria-label="CNC toolpaths" initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 8 }} transition={{ type: "spring", stiffness: 480, damping: 36 }} onPointerDown={(e) => e.stopPropagation()}>
      <div className="mt-head">
        <Icon.EndMill size={14} />
        <span className="grow" style={{ marginLeft: 6 }}>
          CNC toolpaths
        </span>
        {busy && <span className="spinner sm" aria-label="Planning" />}
        <button className="icon-btn sm" onClick={() => (stop(), closeCam())} aria-label="Close" data-tip="Close (Esc)">
          <Icon.X size={12} />
        </button>
      </div>
      {fit.status !== "pass" && <div className={`cam-note ${fit.status}`}>{fit.why.replace(/^./, (c) => c.toUpperCase())}.</div>}
      {error && <div className="cam-note fail">{error}</div>}
      {plan && (
        <div className={`cam-result ${stale ? "stale" : ""}`}>
          <div className="cam-sum">
            <b>{plan.ops.length ? `About ${fmtDuration(total)} of cutting` : "Nothing to cut"}</b>
            {st && (
              <span className="dim">
                {" "}
                · stock {num(st.hi[0] - st.lo[0], 1)} × {num(st.hi[1] - st.lo[1], 1)} × {num(st.top - st.bottom, 1)} mm
              </span>
            )}
          </div>
          <div className="cam-ops">
            {plan.ops.map((o, k) => (
              <button key={k} className="cam-op" data-tip={`${o.label}: ${num(o.length / 1000, 2)} m of cutting at ${o.cut.feed} mm/min, ${o.cut.rpm} rpm`} onClick={() => (stop(), useCam.setState({ t: total ? Math.min(1, (opStart(k) + 1e-3) / total) : 0 }))}>
                <span className="cam-swatch" style={{ background: OP_COLORS[o.kind] }} />
                <span className="grow">{OP_NAME[o.kind]}</span>
                <span className="mono dim">
                  T{o.tool + 1} Ø{num(o.d)} · {o.cut.rpm} rpm · F{o.cut.feed}
                </span>
                <span className="mono">{fmtDuration(o.seconds)}</span>
              </button>
            ))}
          </div>
          {plan.warnings.map((w) => (
            <div key={w} className="cam-note warn">
              {w}
            </div>
          ))}
        </div>
      )}
      {!plan && !error && <div className="cam-note">{busy ? "Planning the cuts…" : "Waiting for the part to build…"}</div>}
      <button className="cam-fold" onClick={() => setFolded(!folded)} aria-expanded={!folded} data-tip={folded ? "Show the job's settings" : "Fold the settings away"}>
        <Icon.ChevronDown size={11} style={{ transform: folded ? "rotate(-90deg)" : "none" }} />
        <span className="grow">{folded ? `${part?.label ?? "Part"} · ${setupLabel.replace(/^Setup /, "setup ")} · ${holdLabel.toLowerCase()} · ${toolsText(job.tools)} mm · ${POSTS.find((p) => p.id === job.post)?.label}` : "Job"}</span>
      </button>
      {!folded && (
        <>
          <Pick
            label="Part"
            value={job.part}
            options={parts.map((p) => ({ value: p.id, label: p.label }))}
            onChange={(id) => {
              const p = camPart(id);
              if (p) useCam.setState({ job: { ...jobFor(p), post: job.post } });
            }}
          />
          <Pick
            label="Tool from"
            tip="The way the tool comes down onto the part: each side that needs cutting is another setup, with the part turned over in between"
            value={job.setup.join(",")}
            options={choices.map((c) => ({ value: c.dir.join(","), label: c.label }))}
            onChange={(v) => setJob({ setup: v.split(",").map(Number) as [number, number, number] })}
          />
          <Pick
            label="Held as"
            tip={HOLDS.find((h) => h.value === job.hold)?.tip}
            value={job.hold}
            options={HOLDS}
            onChange={(hold) => setJob(hold === "base" ? { hold, above: Math.max(job.above, 1), below: job.below > 0 ? job.below : 5, margin: Math.max(job.margin, 3) } : { hold, above: 0, below: 0 })}
          />
          <NumIn label="Stock round" tip="Stock on each side of the part" step={0.5} value={job.margin} onChange={(v) => setJob({ margin: v })} />
          {job.hold === "base" && (
            <Nums
              label="Above, below"
              tip="Stock above the part's top (faced off first) and under its bottom (the base the vise holds)"
              items={[
                { word: "", tip: "Stock above the part's top: faced off first", value: job.above, onChange: (v: number) => setJob({ above: v }) },
                { word: "", tip: "Stock under the part's bottom: the base the vise holds", value: job.below, min: 0.5, onChange: (v: number) => setJob({ below: v }) },
              ]}
            />
          )}
          <label className="mt-num" data-tip="End mills as diameter × how deep it reaches, mm, largest used first, and any twist drills for small holes: 6 × 22, 3 × 12, drill 2 × 15">
            <span className="mono">Tools</span>
            <input
              className={`input mono ${parseTools(toolText) ? "" : "bad"}`}
              value={toolText}
              spellCheck={false}
              onChange={(e) => {
                setToolText(e.target.value);
                const tools = parseTools(e.target.value);
                if (tools && JSON.stringify(tools) !== JSON.stringify(job.tools)) setJob({ tools });
              }}
            />
            <span className="dim mono">mm</span>
          </label>
          <label className="mt-num" data-tip="Sets the spindle speed and feeds">
            <span className="mono">Material</span>
            <input className="input" list="cam-materials" value={job.material} spellCheck={false} onChange={(e) => setJob({ material: e.target.value })} />
            <datalist id="cam-materials">
              {MATERIALS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <span />
          </label>
          <div className="mt-num cam-machine">
            <span className="mono">Machine</span>
            <select className="select" value={job.frame} onChange={(e) => setJob({ frame: e.target.value as Frame })} aria-label="Machine">
              {FRAMES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
            <SmallNum word="rpm" tip="The spindle's top speed, rpm" value={job.rpm} min={100} onChange={(rpm) => setJob({ rpm })} />
          </div>
          <Pick label="Controller" tip={POSTS.find((p) => p.id === job.post)?.note} value={job.post} options={POSTS.map((p) => ({ value: p.id, label: p.label }))} onChange={(post) => setJob({ post })} />
          <button className="btn sm ghost cam-more" onClick={() => setMore(!more)} aria-expanded={more}>
            <Icon.ChevronDown size={11} style={{ transform: more ? "none" : "rotate(-90deg)" }} /> Passes{job.hold === "tabs" ? " and tabs" : ""}
          </button>
          {more && (
            <>
              <NumIn label="Stepover" unit="% of Ø" step={5} min={5} max={90} tip="How far each roughing ring steps out, as a share of the tool's diameter" value={Math.round(job.stepover * 100)} onChange={(v) => setJob({ stepover: v / 100 })} />
              <NumIn label="Finish stock" step={0.05} max={3} tip="Left on the walls by roughing for the finishing pass (0 for no finishing pass)" value={job.allowance} onChange={(v) => setJob({ allowance: v })} />
              <Pick
                label="Direction"
                value={job.climb ? "climb" : "conv"}
                options={[
                  { value: "climb", label: "Climb (rigid machines)" },
                  { value: "conv", label: "Conventional (flexible ones)" },
                ]}
                onChange={(v) => setJob({ climb: v === "climb" })}
              />
              {job.hold === "tabs" && (
                <>
                  <NumIn label="Tabs" unit="" tip="How many tabs on each outline (0 for one about every 120 mm)" value={job.tabs.count} max={40} onChange={(v) => setJob({ tabs: { ...job.tabs, count: Math.round(v) } })} />
                  <NumIn label="Tab width" step={0.5} min={1} max={40} value={job.tabs.width} onChange={(v) => setJob({ tabs: { ...job.tabs, width: v } })} />
                  <NumIn label="Tab height" step={0.5} min={0.5} max={20} value={job.tabs.height} onChange={(v) => setJob({ tabs: { ...job.tabs, height: v } })} />
                </>
              )}
            </>
          )}
        </>
      )}

    </motion.div>
  );
}

/** Along the bottom of the view: play, the cutting's timeline in its operations' colours, what to show, and save. */
function CamBar({ playing, setPlaying }: { playing: boolean; setPlaying: (p: boolean) => void }) {
  const { job, result, t, show, busy, planned } = useCam();
  const part = camPart(job?.part);
  const plan = result?.plan;
  if (!job || !plan || !plan.ops.length) return null;
  const total = plan.seconds;
  const stale = planned !== (part ? `${jobKey(job)}|${part.hash}` : "");
  const runs = plan.ops.reduce((n, o, i) => n + (i === 0 || plan.ops[i - 1].tool !== o.tool ? 1 : 0), 0);
  const files = job.post === "grbl" ? runs : 1;
  const ext = job.post === "linuxcnc" ? ".ngc" : job.post === "mach3" ? ".tap" : ".nc";
  // the op under way
  let acc = 0;
  let k = plan.ops.length - 1;
  for (let i = 0; i < plan.ops.length; i++) {
    if (t * total <= acc + plan.ops[i].seconds + 1e-9) {
      k = i;
      break;
    }
    acc += plan.ops[i].seconds;
  }
  const now = plan.ops[k];
  return (
    <motion.div key="cam-bar" className="vp-float cam-bar" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }} onPointerDown={(e) => e.stopPropagation()}>
      <button className="icon-btn" onClick={() => setPlaying(!playing)} aria-label={playing ? "Pause" : "Play the cutting"} data-tip={playing ? "Pause (Space)" : "Play the cutting (Space)"}>
        {playing ? <Icon.Pause size={14} /> : <Icon.Play size={14} />}
      </button>
      <div className="cam-track grow">
        <div className="cam-segs" aria-hidden="true">
          {plan.ops.map((o, i) => (
            <span key={i} style={{ flexGrow: Math.max(o.seconds, total * 0.004), background: OP_COLORS[o.kind] }} />
          ))}
        </div>
        <input className="slider" type="range" min={0} max={1} step={0.0005} value={t} aria-label="How far through the cutting" style={{ ["--p" as string]: `${t * 100}%` }} onChange={(e) => (setPlaying(false), useCam.setState({ t: Number(e.target.value) }))} />
        <div className="cam-now dim">
          {t >= 1 ? (
            <>Done: the stock as the machine leaves it</>
          ) : (
            <>
              <span className="cam-swatch" style={{ background: OP_COLORS[now.kind] }} /> {OP_SHORT[now.kind].replace(/^./, (c) => c.toUpperCase())} with T{now.tool + 1} Ø{num(now.d)}
            </>
          )}
        </div>
      </div>
      <span className="mono cam-clock">
        {fmtDuration(t * total)} <span className="dim">/ {fmtDuration(total)}</span>
      </span>
      <button className={`btn sm ${show.paths ? "active" : "ghost"}`} aria-pressed={show.paths} onClick={() => useCam.setState({ show: { ...show, paths: !show.paths } })}>
        Paths
      </button>
      <button className={`btn sm ${show.stock ? "active" : "ghost"}`} aria-pressed={show.stock} onClick={() => useCam.setState({ show: { ...show, stock: !show.stock } })} data-tip="The stock as the cuts leave it; off shows the part itself">
        Stock
      </button>
      <button className="btn sm primary" disabled={stale || busy} onClick={() => void saveGcode()} data-tip={files > 1 ? `${files} files, one per tool, in a zip: GRBL has no tool changer, so you fit each tool and zero Z again between them` : `One ${ext} file for ${POSTS.find((p) => p.id === job.post)?.label}`}>
        <Icon.Download size={12} /> Save G-code
      </button>
    </motion.div>
  );
}

/** The panel, its timeline bar and, once there is a plan, its toolpaths, tool and stock in the 3D view. */
export function CamLayer({ scene }: { scene: SceneController }) {
  const { open, job, result, t, show } = useCam();
  const model = useDesign((s) => s.model);
  const overlay = useRef<CamOverlay | null>(null);
  const framed = useRef("");
  const [playing, setPlaying] = useState(false);
  const part = camPart(job?.part);
  const key = job && part ? `${jobKey(job)}|${part.hash}` : "";

  // plan again a moment after anything changes
  useEffect(() => {
    if (!open || !key) return;
    const tm = setTimeout(() => void replan(), 320);
    return () => clearTimeout(tm);
  }, [open, key]);

  // play: the whole job in PLAY_SECONDS
  useEffect(() => {
    if (!playing || !open) return;
    let raf = 0;
    let last = performance.now();
    if (useCam.getState().t >= 1) useCam.setState({ t: 0 });
    const step = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const next = Math.min(1, useCam.getState().t + dt / PLAY_SECONDS);
      useCam.setState({ t: next });
      if (next >= 1) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, open]);

  // Esc closes it, as it does the other tool panels; Space plays and pauses
  useEffect(() => {
    if (!open) {
      setPlaying(false);
      framed.current = "";
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (e.key === "Escape") {
        if (typing && !el?.closest(".cam-panel, .cam-bar")) return;
        e.stopPropagation();
        setPlaying(false);
        closeCam();
      } else if (e.key === " " && !typing && useCam.getState().result?.plan.ops.length) {
        e.preventDefault();
        e.stopPropagation();
        setPlaying((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  useEffect(() => {
    if (!open || !result || !job) return;
    const p = model?.parts.find((x) => x.id === job.part);
    if (!p) return;
    const tl = timeline(result.plan, job.frame);
    const o = new CamOverlay(
      p,
      (model?.parts ?? []).map((x) => x.id),
      result,
      tl,
      job.tools,
      job.material,
    );
    const cs = useCam.getState();
    o.setShow(cs.show);
    o.setTime(cs.t * tl.total);
    overlay.current = o;
    scene.addOverlay(o);
    // look from the side the tool comes from when the part or the setup is new
    const view = `${p.id}|${job.setup.join(",")}`;
    if (framed.current !== view) {
      framed.current = view;
      scene.fit("current", true, o.frameBox(), o.viewDir());
    }
    scene.requestRender();
    return () => {
      scene.removeOverlay(o);
      o.dispose();
      overlay.current = null;
      scene.requestRender();
    };
    // the job's other fields come with the result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, result, scene]);

  useEffect(() => {
    const o = overlay.current;
    if (!o) return;
    o.setTime(t * o.total);
    scene.requestRender();
  }, [t, scene, result]);

  useEffect(() => {
    const o = overlay.current;
    if (!o) return;
    o.setShow(show);
    scene.overlaysChanged();
    scene.requestRender();
  }, [show, scene, result]);

  return (
    <AnimatePresence>
      {open && job && <CamPanel key="cam" stop={() => setPlaying(false)} />}
      {open && job && <CamBar key="cam-bar" playing={playing} setPlaying={setPlaying} />}
    </AnimatePresence>
  );
}
