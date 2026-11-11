// The film maker: pick what a showcase film holds (sections in any order,
// each with its own length and captions), how it looks and sounds and its
// size, watch it in the live preview, then render it to an MP4. The
// assistant's make_film tool opens this too, with its choices filled in.

import { Reorder, useDragControls } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useDesign } from "../../core/engine";
import { download } from "../../persist/files";
import { Modal, Segmented, Toggle } from "../common";
import { Icon } from "../icons";
import { toast } from "../../app/ui";
import { closeFilmMaker, savedFilm, useFilm } from "../../film/store";
import { clearFilmJob, filmBusy, runFilmJob, watchFrames } from "../../film/job";
import { FilmPreview } from "../../film/render";
import { defaultFilm, defaultSection, sectionChoices, type FilmFacts } from "../../film/facts";
import { soundtrack } from "../../film/music";
import { planFilm, type FilmPlan } from "../../film/timeline";
import { ASPECTS, DEFAULT_ACCENT, filmSeconds, filmSize, LOOKS, mergeSpec, MUSIC, sectionInfo, type FilmSection, type FilmSpec, type SectionKind } from "../../film/spec";
import "../../styles/film.css";

interface Row {
  key: SectionKind;
  section: FilmSection;
  on: boolean;
  unavailable: string | null;
}

const ACCENTS = ["#ff7a1a", "#4f7cff", "#19c2a0", "#ff4d6d", "#f5c400", "#b46dff", "#e8ebf0"];
const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

export function FilmMaker() {
  const open = useFilm((s) => s.open);
  return (
    <Modal open={open} onClose={closeFilmMaker} title="Showcase film" icon={<Icon.Film size={16} />} width={1280}>
      {open && <FilmMakerBody />}
    </Modal>
  );
}

/** The rows the dialog starts with: the default film, then what was made last time, then what the assistant asked for. */
function startRows(facts: FilmFacts, spec: FilmSpec): Row[] {
  const choices = sectionChoices(facts);
  const byKind = new Map(choices.map((c) => [c.section.kind, c]));
  const rows: Row[] = [];
  for (const s of spec.sections) {
    const c = byKind.get(s.kind);
    if (!c || rows.some((r) => r.key === s.kind)) continue;
    rows.push({ key: s.kind, section: { ...c.section, ...s }, on: !c.unavailable, unavailable: c.unavailable });
  }
  for (const c of choices) if (!rows.some((r) => r.key === c.section.kind)) rows.push({ key: c.section.kind, section: c.section, on: false, unavailable: c.unavailable });
  return rows;
}

function FilmMakerBody() {
  const job = useFilm((s) => s.job);
  const model = useDesign((s) => s.model);
  const [facts, setFacts] = useState<FilmFacts | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [opts, setOpts] = useState<Omit<FilmSpec, "sections"> | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<SectionKind | null>(null);
  const preview = useRef<FilmPreview | null>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const rendering = !!job;

  const spec: FilmSpec | null = useMemo(() => (opts ? { ...opts, sections: rows.filter((r) => r.on && !r.unavailable).map((r) => r.section) } : null), [opts, rows]);
  const duration = spec ? filmSeconds(spec.sections) : 0;
  // the strip's shots, from the film as it is now (the preview re-plans after this render)
  const plan = useMemo(() => {
    if (!spec || !facts) return null;
    const { width, height } = filmSize(spec.aspect, spec.size);
    return planFilm(spec, facts, width / height);
  }, [spec, facts]);

  const paint = useCallback((c: HTMLCanvasElement | OffscreenCanvas) => {
    const el = cv.current;
    if (!el) return;
    if (el.width !== c.width || el.height !== c.height) {
      el.width = c.width;
      el.height = c.height;
    }
    el.getContext("2d")?.drawImage(c, 0, 0, el.width, el.height);
  }, []);

  // open the preview (it hands the 3D view to the film maker) and build the first film from the design
  useEffect(() => {
    if (rendering) return;
    let dead = false;
    const st = useFilm.getState();
    const name = model?.name ?? "";
    const base0 = st.spec && st.design === name ? st.spec : null;
    (async () => {
      try {
        const look = base0?.look ?? (savedFilm(name)?.look as FilmSpec["look"]) ?? st.preset?.look ?? "studio";
        const p = await FilmPreview.open({ ...(base0 ?? defaultFilmShell()), look }, (c) => !dead && paint(c));
        if (dead) {
          void p.close();
          return;
        }
        preview.current = p;
        const f = p.facts;
        let spec = base0 ?? defaultFilm(f);
        if (!base0) {
          const saved = savedFilm(name);
          if (saved) spec = { ...spec, ...saved, sections: saved.sections?.length ? saved.sections : spec.sections };
          if (st.preset) spec = mergeSpec(spec, st.preset, (k) => defaultSection(k, f));
        }
        setFacts(f);
        setRows(startRows(f, spec));
        // open on the title card rather than the first frame's black
        setT(Math.min(1.6, Math.max(0, filmSeconds(spec.sections) - 0.01)));
        const { sections: _s, ...rest } = spec;
        void _s;
        setOpts(rest);
        useFilm.setState({ preset: null });
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      dead = true;
      setPlaying(false);
      const p = preview.current;
      preview.current = null;
      if (p) void p.close();
    };
    // the preview is opened once per editing session
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendering]);

  // a changed film: re-plan it and draw the frame under the playhead
  useEffect(() => {
    const p = preview.current;
    if (!p || !spec) return;
    // kept while the dialog is closed, for this design
    useFilm.setState({ spec, design: model?.name ?? "" });
    p.update(spec);
    void p.show(Math.min(t, Math.max(0, filmSeconds(spec.sections) - 0.01)));
    // t is drawn by the scrubber and the player themselves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  // playing: the clock runs at real speed and the preview draws what it can keep up with, with the music
  const audio = useRef<{ ctx: AudioContext; src: AudioBufferSourceNode } | null>(null);
  useEffect(() => {
    if (!playing || !spec) return;
    let raf = 0;
    let last = performance.now();
    let cur = t >= duration - 0.05 ? 0 : t;
    let stopped = false;
    const p = preview.current;
    if (spec.music !== "off" && p) {
      void soundtrack(p.plan, spec.music).then((buf) => {
        if (!buf || stopped) return;
        const ctx = new AudioContext();
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0, cur);
        audio.current = { ctx, src };
        last = performance.now();
      });
    }
    const step = () => {
      const now = performance.now();
      cur += (now - last) / 1000;
      last = now;
      if (cur >= duration) {
        cur = duration;
        setPlaying(false);
      }
      setT(cur);
      void preview.current?.show(Math.min(cur, duration - 0.01));
      if (cur < duration) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      const a = audio.current;
      audio.current = null;
      if (a) {
        try {
          a.src.stop();
        } catch {
          /* not started */
        }
        void a.ctx.close();
      }
    };
    // restarts only on play and pause
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing]);

  const seek = (to: number) => {
    const v = Math.max(0, Math.min(duration - 0.01, to));
    setPlaying(false);
    setT(v);
    void preview.current?.show(v);
  };

  const setRow = (k: SectionKind, f: (r: Row) => Row) => setRows((rs) => rs.map((r) => (r.key === k ? f(r) : r)));
  const set = <K extends keyof Omit<FilmSpec, "sections">>(k: K, v: FilmSpec[K]) => setOpts((o) => (o ? { ...o, [k]: v } : o));

  const render = async () => {
    if (!spec || !spec.sections.length || filmBusy()) return;
    setPlaying(false);
    const p = preview.current;
    preview.current = null;
    if (p) await p.close();
    try {
      await runFilmJob(spec);
    } catch {
      // the job view shows what went wrong
    }
  };

  if (rendering) return <JobView paint={paint} cv={cv} />;
  if (error)
    return (
      <div className="modal-body film-error">
        <Icon.Alert size={16} /> {error}
      </div>
    );
  if (!facts || !opts || !spec)
    return (
      <div className="modal-body film-loading">
        <span className="spinner" /> Setting up the film…
      </div>
    );

  const { width, height } = filmSize(opts.aspect, opts.size);
  const shot = plan?.shots.find((s) => t >= s.start && t < s.end);
  const tall = opts.aspect === "9:16" || opts.aspect === "4:5";
  return (
    <>
      <div className="film-body">
        <div className="film-stage">
          <div className={`film-screen${tall ? " tall" : ""}`} style={{ aspectRatio: `${width} / ${height}` }}>
            <canvas ref={cv} />
            {!playing && (
              <button className="film-play-big" onClick={() => setPlaying(true)} aria-label="Play the preview">
                <Icon.Play size={22} />
              </button>
            )}
          </div>
          <Scrubber spec={spec} t={t} duration={duration} playing={playing} onPlay={() => setPlaying((v) => !v)} onSeek={seek} plan={plan} />
          <div className="film-note">
            {shot ? (
              <>
                <b>{sectionInfo(shot.section.kind).label}</b> · {sectionInfo(shot.section.kind).detail}
              </>
            ) : (
              "Press play, or drag along the strip"
            )}
            <span className="grow" />
            <span className="muted">The preview is drawn small and quick; the film is rendered clean, with soft shadows{opts.motionBlur ? " and motion blur" : ""}.</span>
          </div>
        </div>
        <div className="film-side">
          <div className="film-group">
            <div className="field-label">Sections · drag to reorder</div>
            <Reorder.Group axis="y" values={rows} onReorder={setRows} className="film-rows">
              {rows.map((r) => (
                <SectionRow key={r.key} row={r} facts={facts} expanded={expanded === r.key} onExpand={() => setExpanded((e) => (e === r.key ? null : r.key))} onChange={(f) => setRow(r.key, f)} />
              ))}
            </Reorder.Group>
          </div>
          <div className="film-group">
            <div className="field-label">Story</div>
            <label className="film-field">
              <span>Title</span>
              <input className="input" value={opts.title} maxLength={70} onChange={(e) => set("title", e.target.value)} />
            </label>
            <label className="film-field">
              <span>Tagline</span>
              <input className="input" value={opts.tagline} maxLength={120} placeholder="One line on what it is for" onChange={(e) => set("tagline", e.target.value)} />
            </label>
            <label className="film-field">
              <span>Last line</span>
              <input className="input" value={opts.endLine} maxLength={90} onChange={(e) => set("endLine", e.target.value)} />
            </label>
            <label className="film-field">
              <span>Badge</span>
              <input className="input" value={opts.badge} maxLength={40} placeholder="None" onChange={(e) => set("badge", e.target.value)} />
            </label>
            <div className="film-field">
              <span>Captions</span>
              <Toggle on={opts.captions} onChange={(v) => set("captions", v)} label="Captions and cards" />
              <span className="muted small">{opts.captions ? "Captions, labels and number cards" : "Pictures only"}</span>
            </div>
          </div>
          <div className="film-group">
            <div className="field-label">Look</div>
            <div className="film-field">
              <span>Lighting</span>
              <Segmented id="film-look" value={opts.look} options={LOOKS.map((l) => ({ value: l.id, label: l.label }))} onChange={(v) => set("look", v)} />
            </div>
            <div className="film-field">
              <span>Accent</span>
              <div className="film-swatches">
                {ACCENTS.map((c) => (
                  <button key={c} className={`film-swatch${opts.accent.toLowerCase() === c ? " on" : ""}`} style={{ background: c }} onClick={() => set("accent", c)} aria-label={`Accent ${c}`} />
                ))}
                <input type="color" value={opts.accent} onChange={(e) => set("accent", e.target.value)} aria-label="Any accent colour" data-tip="Any colour" />
              </div>
            </div>
            <div className="film-field">
              <span>Music</span>
              <Segmented id="film-music" value={opts.music} options={MUSIC.map((m) => ({ value: m.id, label: m.label, title: m.detail }))} onChange={(v) => set("music", v)} />
            </div>
          </div>
          <div className="film-group">
            <div className="field-label">Video</div>
            <div className="film-field">
              <span>Shape</span>
              <Segmented id="film-aspect" value={opts.aspect} options={ASPECTS.map((a) => ({ value: a.id, label: a.id, title: `${a.label}: ${a.detail}` }))} onChange={(v) => set("aspect", v)} />
            </div>
            <div className="film-field">
              <span>Size</span>
              <Segmented
                id="film-size"
                value={String(opts.size) as "720" | "1080" | "1440" | "2160"}
                options={[
                  { value: "720", label: "720p" },
                  { value: "1080", label: "1080p" },
                  { value: "1440", label: "1440p" },
                  { value: "2160", label: "4K" },
                ]}
                onChange={(v) => set("size", Number(v) as FilmSpec["size"])}
              />
            </div>
            <div className="film-field">
              <span>Frames</span>
              <Segmented id="film-fps" value={String(opts.fps) as "24" | "30" | "60"} options={["24", "30", "60"].map((f) => ({ value: f as "24" | "30" | "60", label: `${f} fps` }))} onChange={(v) => set("fps", Number(v) as FilmSpec["fps"])} />
            </div>
            <div className="film-field">
              <span>Quality</span>
              <Segmented
                id="film-quality"
                value={opts.quality}
                options={[
                  { value: "draft", label: "Draft", title: "Quick: rough shadows and edges" },
                  { value: "good", label: "Good", title: "Clean shadows and edges" },
                  { value: "best", label: "Best", title: "Softest shadows; slowest" },
                ]}
                onChange={(v) => set("quality", v)}
              />
            </div>
            <div className="film-field">
              <span>Motion blur</span>
              <Toggle on={opts.motionBlur} onChange={(v) => set("motionBlur", v)} label="Motion blur" />
              <span className="muted small">{opts.quality === "draft" ? "Needs Good or Best" : "Fast moves smear like a real camera's"}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-foot film-foot">
        <span className="muted">
          {mmss(duration)} · {width} × {height} · {opts.fps} fps · {spec.sections.length} sections
        </span>
        <span className="grow" />
        <button
          className="btn ghost"
          onClick={() => {
            const d = defaultFilm(facts);
            setRows(startRows(facts, d));
            const { sections: _s, ...rest } = d;
            void _s;
            setOpts(rest);
          }}
        >
          Start over
        </button>
        <button className="btn primary" disabled={!spec.sections.length} onClick={() => void render()}>
          <Icon.Film size={14} /> Render film
        </button>
      </div>
    </>
  );
}

/** A shell film for opening the preview before the design's own film is known. */
function defaultFilmShell(): FilmSpec {
  return { title: "", tagline: "", sections: [], aspect: "16:9", size: 1080, fps: 30, look: "studio", accent: DEFAULT_ACCENT, music: "drive", captions: true, badge: "", endLine: "", quality: "good", motionBlur: true };
}

function Scrubber({ spec, t, duration, playing, onPlay, onSeek, plan }: { spec: FilmSpec; t: number; duration: number; playing: boolean; onPlay: () => void; onSeek: (t: number) => void; plan: FilmPlan | null }) {
  const bar = useRef<HTMLDivElement>(null);
  const at = (x: number) => {
    const r = bar.current?.getBoundingClientRect();
    return r ? ((x - r.left) / r.width) * duration : 0;
  };
  return (
    <div className="film-scrub">
      <button className="icon-btn" onClick={onPlay} aria-label={playing ? "Pause" : "Play"}>
        {playing ? <Icon.Pause size={15} /> : <Icon.Play size={15} />}
      </button>
      <span className="film-time">
        {mmss(t)} / {mmss(duration)}
      </span>
      <div
        ref={bar}
        className="film-strip"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          onSeek(at(e.clientX));
        }}
        onPointerMove={(e) => e.buttons === 1 && onSeek(at(e.clientX))}
      >
        {(plan?.shots ?? []).map((s) => (
          <div key={s.index} className={`film-block${t >= s.start && t < s.end ? " on" : ""}`} style={{ left: `${(s.start / duration) * 100}%`, width: `${((s.end - s.start) / duration) * 100}%` }}>
            <span>{sectionInfo(s.section.kind).label}</span>
          </div>
        ))}
        <div className="film-head" style={{ left: `${(t / Math.max(0.01, duration)) * 100}%`, background: spec.accent }} />
      </div>
    </div>
  );
}

function SectionRow({ row, facts, expanded, onExpand, onChange }: { row: Row; facts: FilmFacts; expanded: boolean; onExpand: () => void; onChange: (f: (r: Row) => Row) => void }) {
  const info = sectionInfo(row.key);
  const drag = useDragControls();
  const s = row.section;
  const edit = (p: Partial<FilmSection>) => onChange((r) => ({ ...r, section: { ...r.section, ...p } }));
  const parts = facts.parts.filter((p) => !p.hardware);
  const labels = row.key === "sim" ? facts.sims.map((x) => x.label) : row.key === "airflow" ? facts.airflow.map((x) => x.label) : row.key === "results" ? facts.structural.map((x) => x.label) : [];
  return (
    <Reorder.Item value={row} dragListener={false} dragControls={drag} className={`film-row${row.on && !row.unavailable ? " on" : ""}${row.unavailable ? " off" : ""}`}>
      <div className="film-row-head">
        <span className="film-grip" onPointerDown={(e) => drag.start(e)} aria-label="Drag to reorder">
          <Icon.Reorder size={13} />
        </span>
        <Toggle on={row.on && !row.unavailable} onChange={(v) => !row.unavailable && onChange((r) => ({ ...r, on: v }))} label={info.label} />
        <button className="film-row-name" onClick={onExpand} data-tip={row.unavailable ?? info.detail}>
          <b>{info.label}</b>
          <span className="muted small">{row.unavailable ?? (s.title && s.title !== info.label ? s.title : s.text || info.detail)}</span>
        </button>
        {!row.unavailable && (
          <span className="film-secs">
            <button className="icon-btn sm" onClick={() => edit({ seconds: Math.max(info.min, s.seconds - 1) })} aria-label="Shorter">
              −
            </button>
            <span>{s.seconds}s</span>
            <button className="icon-btn sm" onClick={() => edit({ seconds: Math.min(info.max, s.seconds + 1) })} aria-label="Longer">
              +
            </button>
          </span>
        )}
        {!row.unavailable && (
          <button className={`icon-btn sm film-chev${expanded ? " open" : ""}`} onClick={onExpand} aria-label="Edit this section">
            <Icon.ChevronDown size={13} />
          </button>
        )}
      </div>
      {expanded && !row.unavailable && (
        <div className="film-row-body">
          <>
              <label className="film-field">
                <span>{row.key === "title" || row.key === "end" ? "Title" : "Caption"}</span>
                <input className="input" value={s.title ?? ""} maxLength={90} placeholder={row.key === "title" || row.key === "end" ? "The film's title" : "None"} onChange={(e) => edit({ title: e.target.value })} />
              </label>
              <label className="film-field">
                <span>{row.key === "title" ? "Tagline" : row.key === "end" ? "Last line" : "Second line"}</span>
                <input className="input" value={s.text ?? ""} maxLength={140} placeholder={row.key === "title" ? "The film's tagline" : row.key === "end" ? "The film's last line" : "None"} onChange={(e) => edit({ text: e.target.value })} />
              </label>
          </>
          {row.key === "inside" && (
            <div className="film-field">
              <span>Cut across</span>
              <Segmented
                id="film-axis"
                value={s.axis ?? "y"}
                options={[
                  { value: "y", label: "front to back" },
                  { value: "x", label: "side to side" },
                  { value: "z", label: "top down" },
                ]}
                onChange={(v) => edit({ axis: v })}
              />
            </div>
          )}
          {labels.length > 1 && (
            <label className="film-field">
              <span>Run</span>
              <select className="select" value={s.label ?? labels[0]} onChange={(e) => edit({ label: e.target.value })}>
                {labels.map((l) => (
                  <option key={l}>{l}</option>
                ))}
              </select>
            </label>
          )}
          {row.key === "spotlight" && (
            <div className="film-field col">
              <span>Parts visited, in order</span>
              <div className="film-chips">
                {(s.parts ?? []).map((id) => {
                  const p = facts.parts.find((x) => x.id === id || x.name === id);
                  return (
                    <span key={id} className="chip">
                      {p?.label ?? id}
                      <button className="chip-x" onClick={() => edit({ parts: (s.parts ?? []).filter((x) => x !== id) })} aria-label={`Leave out ${p?.label ?? id}`}>
                        <Icon.X size={10} />
                      </button>
                    </span>
                  );
                })}
                {(s.parts ?? []).length < 6 && (
                  <select
                    className="select sm"
                    value=""
                    onChange={(e) => {
                      if (e.target.value) edit({ parts: [...(s.parts ?? []), e.target.value] });
                    }}
                  >
                    <option value="">Add a part…</option>
                    {parts
                      .filter((p) => !(s.parts ?? []).includes(p.id))
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                  </select>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </Reorder.Item>
  );
}

function JobView({ paint, cv }: { paint: (c: HTMLCanvasElement | OffscreenCanvas) => void; cv: React.RefObject<HTMLCanvasElement> }) {
  const job = useFilm((s) => s.job)!;
  const spec = useFilm((s) => s.spec);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => watchFrames(paint), [paint]);
  useEffect(() => {
    if (!job.result) return;
    const u = URL.createObjectURL(job.result.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [job.result]);
  const p = job.progress;
  const frac = p && p.frames ? p.frame / p.frames : 0;
  const { width, height } = spec ? filmSize(spec.aspect, spec.size) : { width: 16, height: 9 };
  const tall = height > width * 0.9;
  const save = () => {
    if (!job.result) return;
    download(job.result.blob, job.result.name, "video/mp4");
    toast({ kind: "success", title: "Film saved", detail: `${job.result.name}, ${(job.result.blob.size / 1e6).toFixed(1)} MB` });
  };
  return (
    <>
      <div className="film-body job">
        <div className="film-stage">
          <div className={`film-screen${tall ? " tall" : ""}`} style={{ aspectRatio: `${width} / ${height}` }}>
            {url ? <video src={url} controls autoPlay playsInline /> : <canvas ref={cv} />}
          </div>
          {!job.result && !job.error && (
            <div className="film-progress">
              <div className="film-bar">
                <div style={{ width: `${(frac * 100).toFixed(1)}%`, background: spec?.accent }} />
              </div>
              <div className="film-note">
                <b>{p?.stage === "frames" ? `Frame ${p.frame} of ${p.frames}` : p?.stage === "sound" ? "Writing the music" : p?.stage === "finishing" ? "Writing the file" : "Getting ready"}</b>
                <span className="grow" />
                <span className="muted">{p?.left != null ? `about ${mmss(p.left / 1000)} left` : ""}</span>
              </div>
            </div>
          )}
          {job.error && (
            <div className="film-error">
              <Icon.Alert size={16} /> {job.error === "Stopped" ? "Stopped before it finished." : `The film didn't finish: ${job.error}`}
            </div>
          )}
          {job.result && (
            <div className="film-note">
              <b>{job.result.name}</b> · {mmss(job.result.seconds)} · {job.result.width} × {job.result.height} · {job.result.codecs} · {(job.result.blob.size / 1e6).toFixed(1)} MB · made in {mmss(job.result.ms / 1000)}
            </div>
          )}
        </div>
      </div>
      <div className="modal-foot film-foot">
        {job.byAssistant && !job.result && !job.error && <span className="muted">The assistant asked for this film.</span>}
        <span className="grow" />
        {!job.result && !job.error ? (
          <button className="btn ghost" onClick={() => job.abort.abort()}>
            <Icon.Stop size={14} /> Stop
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={() => clearFilmJob()}>
              Back to editing
            </button>
            {job.result && (
              <button className="btn primary" onClick={save}>
                <Icon.Download size={14} /> Save film
              </button>
            )}
          </>
        )}
      </div>
    </>
  );
}
