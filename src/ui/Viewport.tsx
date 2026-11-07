// The 3D viewport: mounts the three.js scene and overlays its controls.

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SceneController, type PhotoStatus } from "./viewport/scene";
import { ProcessOverlay } from "./viewport/processOverlay";
import { useMfgView } from "./mfgView";
import { meshes, meshOf, useDesign } from "../core/engine";
import { turns } from "../core/model";
import { findHolds } from "../core/holds";
import { useView, requestCamera, revealSpan, select, type ViewPreset } from "../app/view";
import { useSettings, updateSettings } from "../app/settings";
import { useTheme } from "../app/theme";
import { lightingPreset } from "./viewport/render/studio";
import { registerViewport } from "../app/viewportApi";
import { openFind } from "../app/ui";
import { Icon } from "./icons";
import { Menu, MenuItem } from "./common";
import { fmtNum } from "../lang/values";
import { materialDensity } from "../library/standards";
import { useChatDraft } from "./chatDraft";
import { LightingMenu } from "./LightingMenu";
import { MaterialButton } from "./MaterialPicker";
import { MaterialCompareHost } from "./materials/CompareOverlay";
import { SpotChat } from "./SpotChat";
import { ModelTools } from "./ModelTools";
import { Markup, toggleMarkup, useMarkup } from "./Markup";
import { openSpot, closeSpot, useSpot } from "../app/spot";
import { useGap, type Gap } from "./useGap";
import { ImportFacts } from "./ImportsPanel";
import { SketchLayer } from "./sketch/SketchPanels";
import { enterSketch, exitSketch, startPicking, useSketch } from "./sketch/session";
import { T } from "./sketch/glyphs";
import { ResultsLayer } from "./ResultsLayer";
import { AirflowLayer } from "./AirflowLayer";
import { MeasureButton, MeasureTool, measuring } from "./viewport/MeasureTool";
import { SimLayer } from "./sim/SimLayer";
import { WiringLayer } from "./WiringLayer";
import { FitLayer, playFitting, useFitView } from "./FitLayer";
import { hasFitting } from "../analysis/fitting";
import { toggleWiring, useWiringView } from "./wiringView";
import { BoardDecorator } from "./viewport/boards/decorate";

export function Viewport() {
  const mount = useRef<HTMLDivElement>(null);
  const ctl = useRef<SceneController | null>(null);
  const mfgOverlay = useRef<ProcessOverlay | null>(null);
  const boardDecor = useRef<BoardDecorator | null>(null);
  const processResults = useDesign((s) => s.process);
  const showProcessIssues = useMfgView((s) => s.overlay);
  const processPreview = useMfgView((s) => s.preview);
  const model = useDesign((s) => s.model);
  const meshVersion = useDesign((s) => s.meshVersion);
  const interferences = useDesign((s) => s.interferences);
  const kernelStatus = useDesign((s) => s.kernelStatus);
  const kernelError = useDesign((s) => s.kernelError);
  const stage = useDesign((s) => s.stage);
  const view = useView();
  const settings = useSettings();
  const theme = useTheme();
  const [webglError, setWebglError] = useState("");
  const [scene, setScene] = useState<SceneController | null>(null);
  // a ring that fills while a finger is held on the model, to open the spot chat
  const [hold, setHold] = useState<{ x: number; y: number; n: number } | null>(null);
  const sketching = useSketch((s) => !!s.active || s.picking);
  const inSketch = useSketch((s) => !!s.active);
  const measureHost = useCallback(() => (ctl.current ? { canvas: ctl.current.renderer.domElement, camera: ctl.current.camera, scene: ctl.current.scene, controls: ctl.current.controls, hit: (x: number, y: number) => ctl.current?.hitAt(x, y) ?? null } : null), []);
  const [photo, setPhoto] = useState<PhotoStatus>({ state: "off", samples: 0, max: 0 });
  const wiring = useWiringView((s) => s.on);
  const hasWires = !!model?.machine && model.machine.wires.length + model.machine.nets.length > 0;

  useEffect(() => {
    if (!mount.current) return;
    let c: SceneController;
    try {
      c = new SceneController(mount.current);
    } catch (e) {
      setWebglError(e instanceof Error ? e.message : String(e));
      return;
    }
    ctl.current = c;
    // circuit boards drawn in full: mask, copper, silkscreen and the parts on them
    const boards = new BoardDecorator(() => c.redecorate());
    boardDecor.current = boards;
    boards.setModel(useDesign.getState().model);
    c.setDecorator(boards);
    mfgOverlay.current = new ProcessOverlay(c);
    c.onHover = (id) => useView.setState({ hovered: id });
    c.onPick = (id, additive) => {
      if (measuring()) return;
      const s = useView.getState();
      if (!id) {
        closeSpot();
        return select([]);
      }
      if (additive) select(s.selected.includes(id) ? s.selected.filter((x) => x !== id) : [...s.selected, id]);
      else select([id]);
      const part = useDesign.getState().model?.parts.find((p) => p.id === id);
      if (part) revealSpan(part.span);
    };
    c.onDoublePick = (id) => {
      if (id) c.focusOn([id]);
      else c.fit("current");
    };
    if (import.meta.env.DEV) (window as unknown as { __kerfViewport?: SceneController }).__kerfViewport = c;
    c.onLightAngle = (deg) => updateSettings({ lightAngle: deg });
    c.onTurntableStop = () => useView.setState({ turntable: false });
    c.onPhotoStatus = setPhoto;
    c.onHold = (at) => {
      const r = mount.current?.getBoundingClientRect();
      setHold(at && r ? { x: at.x - r.left, y: at.y - r.top, n: Date.now() } : null);
    };
    c.onContext = (hit) => {
      // the right button pans in a sketch; the spot chat waits until it is closed
      const sk = useSketch.getState();
      if (sk.active || sk.picking) return;
      const part = hit && useDesign.getState().model?.parts.find((p) => p.id === hit.id);
      if (!hit || !part) return closeSpot();
      select([hit.id]);
      openSpot({ partId: hit.id, label: part.label, local: hit.local, point: hit.point, normal: hit.normal, localNormal: hit.localNormal });
    };
    registerViewport({
      capture: (o) => c.capture(o),
      swatch: (m, f, col, size) => c.swatch(m, f, col, size),
      preview: (ids, look) => c.setOverride(ids, look),
      materialMode: (on) => c.setMaterialMode(on),
      bounds: () => c.modelBounds(),
      viewDir: () => c.viewDir(),
      anchor: (id, local) => c.anchor(id, local),
      snapshot: () => c.snapshot(),
      hitAt: (x, y) => c.hitAt(x, y),
      photoStatus: () => c.photoStatus,
      photoBlocker: () => c.photoBlocker(),
      photoFloor: (q) => c.setPhotoFloor(q),
      photoSnapshot: () => c.photoSnapshot(),
    });
    setScene(c);
    return () => {
      setScene(null);
      registerViewport(null);
      mfgOverlay.current?.destroy();
      mfgOverlay.current = null;
      c.dispose();
      boards.dispose();
      boardDecor.current = null;
      ctl.current = null;
    };
  }, []);

  useEffect(() => {
    ctl.current?.setRenderSettings({ lighting: settings.lighting, lightAngle: settings.lightAngle, quality: settings.quality, photoreal: settings.photoreal, theme });
  }, [settings.lighting, settings.lightAngle, settings.quality, settings.photoreal, theme]);

  useEffect(() => {
    boardDecor.current?.setModel(model);
    if (model) ctl.current?.setParts(model.parts, meshes);
  }, [model, meshVersion]);

  // what moving parts carry with them (their screws, nuts and the parts bolted on), measured once the meshes settle
  useEffect(() => {
    if (!model?.parts.some((p) => turns(p.motion))) {
      ctl.current?.setHolds(null);
      return;
    }
    const t = window.setTimeout(() => ctl.current?.setHolds(findHolds(model, meshOf)), 400);
    return () => window.clearTimeout(t);
  }, [model, meshVersion]);

  useEffect(() => {
    if (stage === "refining" || stage === "done") ctl.current?.settle();
    ctl.current?.setModelSettling(stage !== "idle" && stage !== "done");
  }, [stage]);

  useEffect(() => {
    ctl.current?.setDisplay({
      hidden: new Set(view.hiddenIds),
      selected: new Set(view.selected),
      hovered: view.hovered,
      focus: new Set(view.focusParts),
      isolate: view.isolate,
      xray: view.xray,
      edges: settings.edges,
      grid: settings.grid,
      reduceMotion: settings.reduceMotion,
    });
  }, [view.hiddenIds, view.selected, view.hovered, view.focusParts, view.isolate, view.xray, settings.edges, settings.grid, settings.reduceMotion, model, meshVersion]);

  useEffect(() => ctl.current?.setSection(view.section), [view.section, model]);
  useEffect(() => ctl.current?.setExplode(view.explode), [view.explode]);
  useEffect(() => ctl.current?.setMotion(view.playing, view.speed), [view.playing, view.speed]);
  useEffect(() => ctl.current?.setTurntable(view.turntable), [view.turntable]);
  useEffect(() => {
    if (view.assemblyRequest) ctl.current?.playAssembly();
  }, [view.assemblyRequest]);
  useEffect(() => ctl.current?.setInterferences(interferences, view.focusCheck), [interferences, view.focusCheck]);
  // after setParts above, so overlays attach to the current part groups
  useEffect(() => {
    // a route hovered in the make tab shows only that process's issues on its part
    if (model) mfgOverlay.current?.update(model.parts, processPreview ?? processResults, view.focusCheck, showProcessIssues || !!processPreview, settings.reduceMotion);
    ctl.current?.setProcessMarks(!!mfgOverlay.current?.size);
  }, [model, meshVersion, processResults, processPreview, view.focusCheck, showProcessIssues, settings.reduceMotion]);
  const gap = useGap(view.selected);
  useEffect(() => ctl.current?.setMeasure(gap ? { a: gap.a, b: gap.b } : null), [gap]);
  useEffect(() => {
    if (view.cameraRequest) ctl.current?.fit(view.cameraRequest.preset === "fit" ? "current" : view.cameraRequest.preset);
  }, [view.cameraRequest]);

  const hasMotion = !!model?.parts.some((p) => turns(p.motion));
  const canFit = useMemo(() => !!model && hasFitting(model), [model]);
  const fitting = useFitView((f) => f.on);
  // the photoreal look hides the grid and CAD edges while it runs
  const photoLook = photo.state !== "off" && photo.state !== "paused";
  const visibleParts = model?.parts.length ?? 0;
  const selectedParts = useMemo(() => (model ? model.parts.filter((p) => view.selected.includes(p.id)) : []), [model, view.selected]);
  const empty = model && model.parts.length === 0 && kernelStatus === "ready";
  const spotOpen = useSpot((s) => s.spot !== null);
  const marking = useMarkup((s) => s.on);
  // a sketch takes the pointer, so the spot chat and view markup close while it lasts
  useEffect(() => {
    if (!sketching) return;
    closeSpot();
    toggleMarkup(false);
  }, [sketching]);

  return (
    <div className={`viewport ${inSketch ? "sketching" : ""}`} data-backdrop={lightingPreset(settings.lighting, theme).light ? "light" : "dark"}>
      <div className="vp-mount" ref={mount} />
      {hold && <div key={hold.n} className="vp-hold" style={{ left: hold.x, top: hold.y }} aria-hidden="true" />}

      <div className="vp-toolbar" role="toolbar" aria-label="View controls">
        {/* modelling it yourself comes first and is labelled, so it isn't lost among the view switches */}
        <div className="vp-make">
          <button className={`vp-lbtn ${settings.advanced ? "active" : ""}`} onClick={() => updateSettings({ advanced: !settings.advanced })} data-tip="Modelling tools: box, cylinder, hole, fillet, chamfer, shell, move, pattern, mirror, cut out. Model it yourself; Claude is optional" aria-label="Modelling tools" aria-pressed={settings.advanced}>
            <Icon.Tools size={15} />
            <span>Tools</span>
          </button>
          <button className={`vp-lbtn ${sketching ? "active" : ""}`} onClick={() => (sketching ? exitSketch() : startPicking())} data-tip={sketching ? "Leave the sketch" : "New sketch: draw a profile on a face or plane, then extrude or revolve it"} aria-label="Sketch" aria-pressed={sketching}>
            <T.Sketch size={15} />
            <span>Sketch</span>
          </button>
          <button className={`icon-btn ${marking ? "active" : ""}`} disabled={sketching} onClick={() => toggleMarkup()} data-tip={sketching ? "Leave the sketch to draw on the view" : "Draw on the view for Claude (M)"} aria-label="Draw on the view for Claude">
            <Icon.Edit />
          </button>
        </div>
        <div className="sep" />
        <Menu
          className="vp-cam"
          trigger={(open, toggle) => (
            <button className={`icon-btn ${open ? "active" : ""}`} onClick={toggle} data-tip="Camera view" aria-label="Camera view">
              <Icon.Cube />
            </button>
          )}
          width={190}
        >
          {(close) => (
            <>
              <div className="menu-label">Camera</div>
              {(["iso", "front", "back", "left", "right", "top", "bottom"] as ViewPreset[]).map((p) => (
                <MenuItem
                  key={p}
                  onClick={() => {
                    requestCamera(p);
                    close();
                  }}
                  hint={{ iso: "1", front: "2", back: "", left: "", right: "3", top: "4", bottom: "" }[p]}
                >
                  {p[0].toUpperCase() + p.slice(1)}
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
        <button className="icon-btn vp-cam" onClick={() => requestCamera("fit")} data-tip="Fit to view (F)" aria-label="Fit to view">
          <Icon.Fit />
        </button>
        <div className="sep" />
        <button className={`icon-btn ${view.section.on ? "active" : ""}`} onClick={() => useView.setState({ section: { ...view.section, on: !view.section.on } })} data-tip="Section view (S)" aria-label="Section view">
          <Icon.Scissors />
        </button>
        <button className={`icon-btn ${view.explode > 0 ? "active" : ""}`} onClick={() => useView.setState({ explode: view.explode > 0 ? 0 : 0.5 })} data-tip="Exploded view (E)" aria-label="Exploded view">
          <Icon.Explode />
        </button>
        <button className={`icon-btn ${view.xray ? "active" : ""}`} onClick={() => useView.setState({ xray: !view.xray })} data-tip="X-ray (X)" aria-label="X-ray">
          <Icon.Xray />
        </button>
        <button className={`icon-btn ${view.isolate ? "active" : ""}`} disabled={!view.selected.length && !view.isolate} onClick={() => useView.setState({ isolate: !view.isolate })} data-tip="Isolate selection (I)" aria-label="Isolate selection">
          <Icon.Target />
        </button>
        <MeasureButton />
        {hasWires && (
          <button className={`icon-btn ${wiring ? "active" : ""}`} onClick={() => toggleWiring()} data-tip="Wiring: every cable and plug (W)" aria-label="Wiring" aria-pressed={wiring}>
            <Icon.Plug />
          </button>
        )}
        {canFit && (
          <button className={`icon-btn ${fitting ? "active" : ""}`} onClick={() => (fitting ? useFitView.setState({ on: false }) : playFitting())} data-tip="How it goes on and what keeps it there" aria-label="How it goes on" aria-pressed={fitting}>
            <Icon.Assemble />
          </button>
        )}
        <div className="sep" />
        <button className={`icon-btn ${view.playing ? "active" : ""}`} disabled={!hasMotion} onClick={() => useView.setState({ playing: !view.playing })} data-tip={hasMotion ? "Run the mechanism (Space)" : "Nothing in this design moves"} aria-label="Run the mechanism">
          {view.playing ? <Icon.Pause /> : <Icon.Play />}
        </button>
        <div className="sep" />
        <div className="vp-look">
          <LightingMenu photoLook={photoLook} />
          <button className={`icon-btn vp-photo-btn ${settings.photoreal ? "active" : ""}`} onClick={() => updateSettings({ photoreal: !settings.photoreal })} data-tip="Photoreal view (P)" aria-label="Photoreal view" aria-pressed={settings.photoreal}>
            <Icon.Aperture />
          </button>
        </div>
        <button className={`icon-btn ${view.turntable ? "active" : ""}`} disabled={!visibleParts} onClick={() => useView.setState({ turntable: !view.turntable })} data-tip="Turntable (T)" aria-label="Turntable">
          <Icon.Orbit />
        </button>
      </div>

      <AnimatePresence>
        {(view.section.on || view.explode > 0 || view.playing) && (
          <motion.div className="vp-float" style={{ left: "50%", top: 54, x: "-50%", width: 300 }} initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
            <div className="col" style={{ gap: 10 }}>
              {view.section.on && (
                <div>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="field-label" style={{ margin: 0 }}>
                      Section
                    </span>
                    <div className="row" style={{ gap: 4 }}>
                      {(["x", "y", "z"] as const).map((a) => (
                        <button key={a} className={`btn sm ${view.section.axis === a ? "primary" : "ghost"}`} style={{ minWidth: 28 }} onClick={() => useView.setState({ section: { ...view.section, axis: a } })}>
                          {a.toUpperCase()}
                        </button>
                      ))}
                      <button className="btn sm ghost" onClick={() => useView.setState({ section: { ...view.section, flip: !view.section.flip } })} data-tip="Flip side">
                        ⇄
                      </button>
                    </div>
                  </div>
                  <Range value={view.section.t} onChange={(t) => useView.setState({ section: { ...view.section, t } })} label="Section position" />
                </div>
              )}
              {view.explode > 0 && (
                <div>
                  <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <span className="field-label" style={{ margin: 0 }}>
                      Explode
                    </span>
                    <button className="btn sm ghost" onClick={() => useView.setState((s) => ({ explode: 0, assemblyRequest: s.assemblyRequest + 1 }))} data-tip="Watch the parts go together in design order (A)">
                      <Icon.Assemble size={13} /> Play assembly
                    </button>
                  </div>
                  <Range value={view.explode} onChange={(explode) => useView.setState({ explode: Math.max(0.001, explode) })} label="Explode amount" />
                </div>
              )}
              {view.playing && (
                <div>
                  <span className="field-label">Motion speed · input shaft {fmtNum(15 * view.speed, 0)} rpm</span>
                  <Range value={view.speed / 4} onChange={(v) => useView.setState({ speed: Math.max(0.05, v * 4) })} label="Motion speed" />
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* the "How it goes on" card sits where this line is; the status bar still shows the same counts */}
      {!fitting && <Hud stage={stage} parts={visibleParts} />}
      <MeasureTool host={measureHost} />
      <AnimatePresence>{photo.state !== "off" && <PhotoPill key="photo" s={photo} />}</AnimatePresence>

      {scene && !inSketch && <ResultsLayer scene={scene} />}
      {scene && !inSketch && <AirflowLayer scene={scene} />}
      {scene && !inSketch && <SimLayer scene={scene} />}
      {scene && !inSketch && hasWires && <WiringLayer scene={scene} />}
      {scene && !inSketch && canFit && <FitLayer scene={scene} />}

      <AnimatePresence>{selectedParts.length > 0 && !spotOpen && !sketching && <SelectionCard key="sel" ids={view.selected} gap={gap} />}</AnimatePresence>

      {settings.advanced && !inSketch && <ModelTools host={mount} />}
      <SpotChat />
      <Markup />
      <MaterialCompareHost />

      {scene && <SketchLayer ctl={scene} />}

      {empty && !sketching && (
        <div className="vp-empty">
          <motion.div className="card" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <div style={{ display: "grid", placeItems: "center", marginBottom: 12, color: "var(--accent-2)" }}>
              <Icon.Cube size={34} />
            </div>
            <div style={{ fontWeight: 600, fontSize: 15 }}>Nothing to show yet</div>
            <div className="muted" style={{ marginTop: 6 }}>
              Describe what you want to make to Claude in the chat, or model it yourself.
            </div>
            <div className="vp-empty-actions">
              <button className="btn sm primary" onClick={() => document.getElementById("chat-input")?.focus()}>
                <Icon.Sparkle size={13} /> Describe it
              </button>
              <button className="btn sm" onClick={() => startPicking()}>
                <T.Sketch size={13} /> Sketch
              </button>
              <button className="btn sm" onClick={() => updateSettings({ advanced: true })}>
                <Icon.Tools size={13} /> Tools
              </button>
              <button className="btn sm ghost" onClick={openFind}>
                <Icon.Search size={13} /> Find
              </button>
            </div>
          </motion.div>
        </div>
      )}

      <AnimatePresence>
        {(kernelStatus === "loading" || kernelStatus === "error" || webglError) && (
          <motion.div className="vp-loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.4 } }}>
            {webglError ? (
              <div className="card" style={{ padding: 24, maxWidth: 420, textAlign: "center" }}>
                <div style={{ color: "var(--fail)", marginBottom: 8 }}>
                  <Icon.Alert size={26} />
                </div>
                <div style={{ fontWeight: 600 }}>3D graphics are unavailable</div>
                <div className="muted" style={{ marginTop: 6 }}>
                  Kerf needs WebGL 2. Turn on hardware acceleration in your browser settings, or try a current version of Chrome, Edge, Firefox or Safari.
                </div>
              </div>
            ) : kernelStatus === "error" ? (
              <div className="card" style={{ padding: 24, maxWidth: 440, textAlign: "center" }}>
                <div style={{ color: "var(--fail)", marginBottom: 8 }}>
                  <Icon.Alert size={26} />
                </div>
                <div style={{ fontWeight: 600 }}>The geometry kernel could not start</div>
                <div className="muted" style={{ marginTop: 6 }}>{kernelError}</div>
                <button className="btn primary" style={{ marginTop: 14 }} onClick={() => location.reload()}>
                  Reload Kerf
                </button>
              </div>
            ) : (
              <KernelBoot />
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Range({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return <input className="slider" type="range" min={0} max={1} step={0.001} value={value} aria-label={label} style={{ ["--p" as string]: `${value * 100}%` }} onChange={(e) => onChange(Number(e.target.value))} />;
}

function KernelBoot() {
  const lines = ["loading OpenCASCADE 7.x (WebAssembly)", "allocating B-rep kernel", "warming tessellator"];
  const [n, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((x) => Math.min(lines.length, x + 1)), 650);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <div className="card" style={{ padding: "22px 26px", width: 380 }}>
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="spinner" />
        <span style={{ fontWeight: 600 }}>Starting the geometry kernel</span>
      </div>
      <div className="mono" style={{ fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.8 }}>
        {lines.slice(0, n + 1).map((l, i) => (
          <motion.div key={l} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }}>
            <span style={{ color: i < n ? "var(--pass)" : "var(--accent-2)" }}>{i < n ? "✓" : "›"}</span> {l}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function Hud({ stage, parts }: { stage: string; parts: number }) {
  const progress = useDesign((s) => s.progress);
  const timings = useDesign((s) => s.timings);
  const busy = stage === "building" || stage === "checking";
  return (
    <div className="vp-hud" style={{ top: "auto", bottom: 104, left: 14 }}>
      <AnimatePresence mode="wait">
        {busy ? (
          <motion.div key="busy" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <span className="shimmer-text">{stage === "building" ? `building solids ${progress.done}/${progress.total}` : "running checks"}</span>
          </motion.div>
        ) : (
          <motion.div key="idle" className="vp-hud-rest" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <b>{parts}</b> solids · eval {fmtNum(timings.evalMs, 0)} ms · build {fmtNum(timings.buildMs, 0)} ms
            {timings.reused > 0 && (
              <>
                {" "}
                · <b>{timings.reused}</b> reused
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const PHOTO_LABEL: Record<PhotoStatus["state"], string> = {
  off: "",
  paused: "Photoreal is paused",
  waiting: "Photoreal",
  preparing: "Preparing the photoreal view",
  rendering: "Photoreal",
  done: "Photoreal",
};
/** read after the label, so a screen reader hears each change of state (the sample count is not read) */
const PHOTO_SPOKEN: Partial<Record<PhotoStatus["state"], string>> = {
  waiting: ", waiting for the view to hold still",
  rendering: ", rendering",
  done: ", finished",
};

/** Progress of the path traced view, bottom right of the viewport (the plan pill has the centre). */
function PhotoPill({ s }: { s: PhotoStatus }) {
  const p = s.max ? Math.min(1, s.samples / s.max) : 0;
  const label = s.reason || PHOTO_LABEL[s.state];
  return (
    <motion.div className={`vp-photo ${s.state}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}>
      {s.state === "preparing" ? <span className="spinner sm" aria-hidden /> : <Icon.Aperture size={13} />}
      <span role="status">
        {label}
        {!s.reason && PHOTO_SPOKEN[s.state] && <span className="sr-only">{PHOTO_SPOKEN[s.state]}</span>}
      </span>
      {!s.reason && (s.state === "rendering" || s.state === "waiting" || s.state === "done") && (
        <span className="vp-photo-count" aria-hidden>
          <span className="vp-photo-bar">
            <span style={{ transform: `scaleX(${p})` }} />
          </span>
          <span className="mono">
            {s.state === "done" ? (
              <>
                {s.max} <Icon.Check size={11} />
              </>
            ) : (
              <>
                {s.samples}/{s.max}
              </>
            )}
          </span>
        </span>
      )}
    </motion.div>
  );
}

function SelectionCard({ ids, gap }: { ids: string[]; gap: Gap | null }) {
  const model = useDesign((s) => s.model);
  const report = useDesign((s) => s.report);
  const parts = model?.parts.filter((p) => ids.includes(p.id)) ?? [];
  const setDraft = useChatDraft((s) => s.set);
  if (!parts.length) return null;
  const p = parts[0];
  const entry = meshes.get(p.hash);
  const vol = parts.reduce((s, q) => s + (meshes.get(q.hash)?.volume ?? 0), 0);
  const mass = parts.reduce((s, q) => s + ((meshes.get(q.hash)?.volume ?? 0) / 1000) * materialDensity(q.material), 0);
  // an imported part has no material until the design gives it one
  const massKnown = parts.every((q) => q.material);
  const issues = report?.items.filter((i) => (i.status === "fail" || i.status === "warn") && i.parts?.some((x) => ids.includes(x))) ?? [];
  const size = entry ? entry.bbox[1].map((v, i) => v - entry.bbox[0][i]) : null;
  return (
    <motion.div className="vp-float vp-selection" initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className="swatch" style={{ width: 10, height: 10, borderRadius: 3, background: p.color, display: "inline-block" }} />
        <div className="grow" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{parts.length > 1 ? `${parts.length} selected` : p.label}</div>
        <button className="icon-btn sm" onClick={() => select([])} aria-label="Clear selection">
          <Icon.X size={14} />
        </button>
      </div>
      <div className="mono" style={{ fontSize: 11, color: "var(--text-3)", lineHeight: 1.75 }}>
        {parts.length === 1 && (
          <>
            <div>
              id <span style={{ color: "var(--text-2)" }}>{p.id}</span> · {p.imported ? `step("${p.imported.file}")` : p.kind === "component" ? `lib.${p.libKind}` : "part"}
            </div>
            {p.imported && <ImportFacts part={p} />}
            <div>
              {p.group}
              {p.locked ? " · locked" : ""}
              {p.removable ? " · removable" : ""}
            </div>
            {size && (
              <div>
                {size.map((v) => fmtNum(v, 1)).join(" × ")} mm (local)
              </div>
            )}
          </>
        )}
        <div>
          {fmtNum(vol / 1000, 2)} cm³{massKnown ? ` · ${fmtNum(mass, 1)} g` : ""}
        </div>
        {gap && (
          <div className="gap-readout" data-tip="Smallest distance between the two, from the exact geometry">
            gap <b>{gap.distance < 1e-4 ? "0" : fmtNum(gap.distance, 3)} mm</b>
            {gap.distance < 1e-4 ? " · touching or overlapping" : ` · Δ ${gap.b.map((v, k) => fmtNum(Math.abs(v - gap.a[k]), 2)).join(", ")}`}
          </div>
        )}
        {p.motion && parts.length === 1 && <div>turns at {fmtNum(Math.abs(p.motion.ratio), 3)}× the input</div>}
      </div>
      <MaterialButton parts={parts} />
      {issues.length > 0 && (
        <div style={{ marginTop: 8 }}>
          {issues.slice(0, 3).map((i) => (
            <div key={i.id} className="row" style={{ fontSize: 11.5, color: i.status === "fail" ? "var(--fail-ink)" : "var(--warn-ink)", alignItems: "flex-start", marginTop: 3 }}>
              <span className={`dot ${i.status}`} style={{ marginTop: 5 }} />
              <span>{i.title}</span>
            </div>
          ))}
        </div>
      )}
      <div className="row" style={{ marginTop: 10, gap: 6, flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => revealSpan(p.span)}>
          <Icon.Code size={13} /> Source
        </button>
        <button className="btn sm" onClick={() => useView.setState((s) => ({ hiddenIds: [...new Set([...s.hiddenIds, ...ids])], selected: [] }))}>
          <Icon.EyeOff size={13} /> Hide
        </button>
        <button
          className="btn sm"
          onClick={() => (parts.length === 1 ? openSpot({ partId: p.id, label: p.label }) : setDraft(`About ${parts.map((q) => q.id).join(", ")}${gap ? ` (gap ${fmtNum(gap.distance, 2)} mm)` : ""}: `))}
          data-tip={parts.length === 1 ? "Ask Claude about this part, right here" : "Ask Claude about these parts"}
        >
          <Icon.Sparkle size={13} /> Ask
        </button>
        {parts.length === 1 &&
          model?.sketches
            .filter((sk) => sk.usedBy.includes(p.name))
            .map((sk) => (
              <button key={sk.name} className="btn sm" onClick={() => enterSketch(sk.name)} data-tip={`Edit the sketch ${p.name} is built from`}>
                <T.Sketch size={13} /> {sk.name}
              </button>
            ))}
      </div>
      <div className="dim" style={{ fontSize: 10.5, marginTop: 8 }}>
        Right-click a spot on the model to ask about it
      </div>
    </motion.div>
  );
}
