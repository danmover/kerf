// Projects home: recent designs, starting points and import.

import { motion } from "framer-motion";
import { useLayoutEffect, useRef, useState } from "react";
import { useProject, openProject, createProject, duplicateProject, deleteProject, exportProject, importProject, renameProject } from "../app/project";
import { confirmDialog, go, openSettings, toast } from "../app/ui";
import { openCreatureDialog } from "../plugins/organic/CreatureDialog";
import { TEMPLATES, TEMPLATE_CATEGORIES, audienceById, templateById, type TemplateCategory } from "../demos/templates";
import { useSettings } from "../app/settings";
import { startDesign } from "../app/startDesign";
import { Logo, LogoMark } from "../ui/Logo";
import { Icon } from "../ui/icons";
import { Menu, MenuItem, timeAgo, useTick } from "../ui/common";
import { useApiKey } from "../ui/ChatPanel";
import { resetChat, useChat } from "../ai/chat";
import type { ProjectRecord } from "../persist/db";
import { AccountButton, CloudTag, UploadBanner, useCloudActions } from "../ui/Account";
import { useAccount } from "../cloud/account";
import { importStepFiles, isStepFile } from "../app/imports";
import { cleanName } from "../kernel/stepText";
import { ThemeSwitch } from "../ui/ThemeSwitch";

export function Home() {
  useTick();
  const projects = useProject((s) => s.projects);
  const loaded = useProject((s) => s.loaded);
  const save = useProject((s) => s.save);
  const key = useApiKey();
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const startFrom = async (templateId: string) => {
    const p = await createProject(templateId);
    await openProject(p.id);
  };
  const onFiles = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    // a STEP file starts a new design around that part
    const steps = [...(files ?? [])].filter(isStepFile);
    if (steps.length) {
      const part = cleanName(steps[0].name.replace(/\.(step|stp|p21)$/i, ""), 60).replace(/["\\]/g, "") || "imported part";
      const src = `design "Around ${part}"\nnote "Describe what to design around ${part} in the chat, or write it here."\n`;
      const p = await createProject("blank", part, src);
      await openProject(p.id);
      await importStepFiles(steps);
      return;
    }
    const p = await importProject(f);
    if (p) await openProject(p.id);
  };

  return (
    <div
      className={`screen drop-zone ${dragging ? "active" : ""}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.types].includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void onFiles(e.dataTransfer.files);
      }}
    >
      <div className="backdrop-glow" />
      <div className="backdrop-grid" />
      <div className="home">
        <div className="home-head">
          <Logo size={26} />
          <div className="grow" />
          {!key && (
            <button className="btn ghost" onClick={() => openSettings("ai")}>
              <Icon.Key size={14} /> Add Claude API key
            </button>
          )}
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Icon.Upload size={14} /> Import
          </button>
          <AccountButton />
          <ThemeSwitch />
          <button className="icon-btn" onClick={() => openSettings("app")} aria-label="Settings" data-tip="Settings">
            <Icon.Settings />
          </button>
          <input ref={fileRef} type="file" accept=".kerf,.kerfproj,.kerfbackup,.json,.txt,.step,.stp" hidden onChange={(e) => void onFiles(e.target.files).finally(() => (e.target.value = ""))} />
        </div>

        <motion.div className="hero" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <div className="hero-mark" aria-hidden="true">
            <LogoMark size={168} idle />
          </div>
          <h1>
            Describe it. <span style={{ color: "var(--accent-2)" }}>Claude models it.</span>
            <br />
            The checks keep it honest.
          </h1>
          <p>Kerf is mechanical CAD where the AI does the modelling and you direct the design. Every change, by you or by Claude, edits one design file that is rebuilt as exact solids and checked for fit, interference, tool access, motion and strength.</p>
        </motion.div>

        <DescribeBox hasKey={!!key} />

        {save === "memory" && (
          <div className="banner" style={{ borderRadius: 10, border: "1px solid rgb(var(--warn-rgb) / 0.35)", marginBottom: 10 }}>
            <Icon.Alert size={14} /> This browser is blocking local storage. Projects last only until you close the tab.
          </div>
        )}

        {/* someone coming back wants their own work first; the examples follow */}
        <UploadBanner />
        {!loaded ? (
          <>
            <div className="section-label">Your projects</div>
            <div className="row dim">
              <div className="spinner" /> Loading…
            </div>
          </>
        ) : (
          projects.length > 0 && <Projects projects={projects} />
        )}

        <Examples onStart={(id) => void startFrom(id)} />
        <div className="home-drop-note">
          <Icon.Upload size={12} /> Drop a .kerf, .kerfproj, backup or STEP file anywhere on this page to open it.
        </div>

        <footer className="row dim" style={{ marginTop: 50, fontSize: 12, flexWrap: "wrap", gap: 14 }}>
          <span>Kerf {__APP_VERSION__} · prototype</span>
          <StorageNote />
          <div className="grow" />
          <a href="#" onClick={(e) => (e.preventDefault(), go({ name: "legal", doc: "terms", back: "home" }))}>
            Terms
          </a>
          <a href="#" onClick={(e) => (e.preventDefault(), go({ name: "legal", doc: "privacy", back: "home" }))}>
            Privacy
          </a>
          <a href="#" onClick={(e) => (e.preventDefault(), go({ name: "legal", doc: "acceptable-use", back: "home" }))}>
            Acceptable use
          </a>
          <a href="#" onClick={(e) => (e.preventDefault(), go({ name: "legal", doc: "licenses", back: "home" }))}>
            Open-source licences
          </a>
        </footer>
      </div>
      {dragging && (
        <div className="overlay" style={{ pointerEvents: "none" }}>
          <div className="card" style={{ padding: 30, textAlign: "center" }}>
            <Icon.Upload size={28} />
            <div style={{ fontWeight: 600, marginTop: 8 }}>Drop to import</div>
            <div className="dim">.kerf source, .kerfproj project or Kerf backup</div>
          </div>
        </div>
      )}
    </div>
  );
}

function StorageNote() {
  const signedIn = useAccount((s) => s.status === "signed-in" || s.status === "unreachable");
  return <span>{signedIn ? "Projects are saved in this browser and synced to your account." : "Projects are stored only in this browser."}</span>;
}

/** Home's first question: what to make. The description becomes a new design and Claude's first message. */
function DescribeBox({ hasKey }: { hasKey: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const audience = useSettings((s) => s.audience);
  const ta = useRef<HTMLTextAreaElement>(null);
  const briefs = audienceById(audience)?.briefs ?? templateById("blank")?.prompts ?? [];
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(180, el.scrollHeight) + "px";
  }, [text]);
  const start = async (brief = text) => {
    if (!brief.trim() || busy) return;
    setBusy(true);
    try {
      await startDesign(brief);
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div className="describe" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.08 }}>
      <div className="describe-box">
        <Icon.Sparkle size={16} />
        <textarea
          ref={ta}
          rows={1}
          value={text}
          maxLength={20000}
          placeholder="What do you want to make? Say what it's for, the sizes that matter and what it must fit…"
          aria-label="Describe what you want to make"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <button className="btn primary" disabled={!text.trim() || busy} onClick={() => void start()}>
          {busy ? <span className="spinner" /> : <Icon.Send size={13} />} Start designing
        </button>
      </div>
      <div className="describe-foot">
        {briefs.slice(0, 3).map((b) => (
          <button key={b} className="describe-chip" onClick={() => (setText(b), ta.current?.focus())} data-tip="Use this brief (you can change it before starting)">
            {b}
          </button>
        ))}
      </div>
      {!hasKey && (
        <div className="describe-note">
          <Icon.Key size={12} /> Claude needs an API key to design by chat.{" "}
          <button className="link-btn" onClick={() => openSettings("ai")}>
            Add one
          </button>{" "}
          or start from an example below: the editor, checks and exports all work without one.
        </div>
      )}
    </motion.div>
  );
}

const RECENT = 8;

function Projects({ projects }: { projects: ProjectRecord[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? projects : projects.slice(0, RECENT);
  return (
    <>
      <div className="section-label">
        Your projects
        {projects.length > RECENT && (
          <button className="section-more" onClick={() => setAll(!all)}>
            {all ? "Show recent" : `Show all ${projects.length}`}
          </button>
        )}
      </div>
      <div className="cards">
        {shown.map((p, i) => (
          <ProjectCard key={p.id} p={p} index={i} />
        ))}
      </div>
    </>
  );
}

/** The starting points, grouped by what they are, in the order that suits who the user said they are. */
function Examples({ onStart }: { onStart: (id: string) => void }) {
  const audience = audienceById(useSettings((s) => s.audience));
  const [cat, setCat] = useState<TemplateCategory | "all">("all");
  const order = audience?.order ?? TEMPLATE_CATEGORIES.map((c) => c.id);
  const off = useSettings((s) => s.pluginsOff);
  const shown = TEMPLATES.filter((t) => t.id !== "blank" && !(t.plugin && off.includes(t.plugin)));
  const cats = [...TEMPLATE_CATEGORIES].filter((c) => shown.some((t) => (t.category ?? "parts") === c.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const list = shown.filter((t) => cat === "all" || t.category === cat)
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (cat === "all" ? order.indexOf(a.t.category ?? "parts") - order.indexOf(b.t.category ?? "parts") : 0) || a.i - b.i)
    .map((x) => x.t);
  return (
    <>
      <div className="section-label">Start from an example</div>
      <div className="example-filter" role="tablist" aria-label="Kinds of example">
        {[{ id: "all" as const, label: "All" }, ...cats].map((c) => (
          <button key={c.id} role="tab" aria-selected={cat === c.id} className={`example-chip ${cat === c.id ? "active" : ""}`} onClick={() => setCat(c.id)}>
            {c.label}
          </button>
        ))}
        <div className="grow" />
        {!off.includes("organic") && (
          <button className="example-chip blank" onClick={openCreatureDialog} data-tip="Describe an animal, person or pet, or drop in a reference sheet, like Meshy or Tripo">
            <Icon.Sparkle size={12} /> Make a creature
          </button>
        )}
        <button className="example-chip blank" onClick={() => onStart("blank")}>
          <Icon.Plus size={12} /> Blank design
        </button>
      </div>
      <div className="cards">
        {list.map((t, i) => (
          <motion.div key={t.id} className="card clickable" onClick={() => onStart(t.id)} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(0.04 * i, 0.3) }} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && onStart(t.id)}>
            <div className="thumb">
              <TemplateArt id={t.id} />
            </div>
            <div className="body">
              <div className="title">{t.name}</div>
              <div className="sub">{t.tagline}</div>
              <div className="foot">
                {t.id === audience?.recommended && <span className="chip accent">for you</span>}
                {(t.shows ?? []).map((x) => (
                  <span key={x} className="chip shows">
                    {x}
                  </span>
                ))}
                <span className="chip">{t.stats.split(" · ")[0]}</span>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </>
  );
}

function ProjectCard({ p, index }: { p: ProjectRecord; index: number }) {
  const cloud = useCloudActions(p.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  const finish = () => {
    setRenaming(false);
    if (name.trim() && name !== p.name) void renameProject(p.id, name);
    else setName(p.name);
  };
  return (
    <motion.div className="card clickable" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(0.03 * index, 0.3) }} onClick={() => !renaming && void openProject(p.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && !renaming && void openProject(p.id)}>
      <div className="thumb">{p.thumbnail ? <img src={p.thumbnail} alt="" /> : <TemplateArt id={p.template} />}</div>
      <CloudTag id={p.id} />
      <div className="body">
        {renaming ? (
          <input className="input" autoFocus value={name} onClick={(e) => e.stopPropagation()} onChange={(e) => setName(e.target.value)} onBlur={finish} onKeyDown={(e) => (e.key === "Enter" ? finish() : e.key === "Escape" && (setName(p.name), setRenaming(false)))} aria-label="Project name" />
        ) : (
          <div className="title">{p.name}</div>
        )}
        <div className="sub">Edited {timeAgo(p.updatedAt)}</div>
      </div>
      <div className="more" onClick={(e) => e.stopPropagation()}>
        <Menu
          align="right"
          width={200}
          trigger={(open, toggle) => (
            <button className={`icon-btn sm ${open ? "active" : ""}`} onClick={toggle} aria-label="Project actions">
              <Icon.More size={15} />
            </button>
          )}
        >
          {(close) => (
            <>
              <MenuItem icon={<Icon.Edit size={14} />} onClick={() => (close(), setRenaming(true))}>
                Rename
              </MenuItem>
              <MenuItem icon={<Icon.Copy size={14} />} onClick={() => (close(), void duplicateProject(p.id))}>
                Duplicate
              </MenuItem>
              <MenuItem icon={<Icon.Download size={14} />} onClick={() => (close(), void exportProject(p.id))}>
                Export project file
              </MenuItem>
              {cloud && (
                <MenuItem icon={<Icon.Upload size={14} />} onClick={() => (close(), void cloud.run())}>
                  {cloud.label}
                </MenuItem>
              )}
              <div className="menu-sep" />
              <MenuItem
                danger
                icon={<Icon.Trash size={14} />}
                onClick={async () => {
                  close();
                  if (await confirmDialog({ title: `Delete “${p.name}”?`, body: `The design, its version history and its chat are removed from this browser${cloud?.inAccount ? " and from your account" : ""}. This cannot be undone. Export it first if you may need it.`, confirm: "Delete project", danger: true })) {
                    if (useChat.getState().projectId === p.id) resetChat();
                    await deleteProject(p.id);
                    toast({ kind: "success", title: "Project deleted" });
                  }
                }}
              >
                Delete
              </MenuItem>
            </>
          )}
        </Menu>
      </div>
    </motion.div>
  );
}

/** Small animated line drawings for templates without a thumbnail. */
export function TemplateArt({ id }: { id: string }) {
  // theme tokens, set as styles: SVG colour attributes do not take var()
  const accent = { stroke: "var(--accent)" };
  const violet = { stroke: "var(--violet)" };
  const line = { stroke: "var(--line-3)" };
  const tint = (a: number) => ({ ...accent, fill: `rgb(var(--accent-rgb) / ${a})` });

  if (id === "fox" || id === "cloud-sheep") {
    const soft = (a: number) => ({ ...accent, fill: `rgb(var(--accent-rgb) / ${a})`, strokeWidth: 1.2 });
    return id === "cloud-sheep" ? (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        {[
          [78, 66, 15],
          [96, 60, 16],
          [116, 64, 15],
          [130, 74, 12],
          [88, 80, 14],
          [112, 82, 14],
        ].map(([cx, cy, r], i) => (
          <circle key={i} cx={cx} cy={cy} r={r} style={soft(0.1)} />
        ))}
        <circle cx="70" cy="44" r="18" style={soft(0.16)} />
        <ellipse cx="62" cy="52" rx="9" ry="10" style={{ ...line, fill: "rgb(var(--accent-rgb) / 0.05)", strokeWidth: 1 }} />
        <path d="M80 36 a8 8 0 1 1 -2 12 a4.5 4.5 0 1 1 3 -6" style={{ ...violet, fill: "none", strokeWidth: 2.2, strokeLinecap: "round" }} />
        <path d="M86 94 v12 M108 96 v12" style={{ ...accent, strokeWidth: 3, strokeLinecap: "round" }} />
      </svg>
    ) : (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <path d="M76 34 L72 8 L94 28 Z M124 34 L128 8 L106 28 Z" style={{ ...soft(0.24), strokeLinejoin: "round" }} />
        <ellipse cx="100" cy="46" rx="30" ry="25" style={soft(0.14)} />
        <path d="M70 56 l-10 4 l8 2 l-6 6 l14 -4 M130 56 l10 4 l-8 2 l6 6 l-14 -4" style={{ ...accent, fill: "none", strokeWidth: 1.1, strokeLinejoin: "round" }} />
        <circle cx="100" cy="60" r="3" style={{ fill: "var(--accent)" }} />
        <path d="M86 70 Q100 66 114 70 L116 100 L84 100 Z" style={soft(0.1)} />
        <path d="M114 88 C138 92 150 70 166 60 C168 76 150 98 120 98" style={{ ...soft(0.12), strokeLinejoin: "round" }} />
        <path d="M156 64 l4 8 l4 -10" style={{ ...violet, fill: "none", strokeWidth: 1.2 }} />
      </svg>
    );
  }  if (id === "reducer")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.circle cx="80" cy="62" r="34" fill="none" strokeWidth="1.3" strokeDasharray="5 3" animate={{ rotate: -360 }} transition={{ duration: 18, repeat: Infinity, ease: "linear" }} style={{ ...accent, originX: "80px", originY: "62px" }} />
        <motion.circle cx="131" cy="62" r="17" fill="none" strokeWidth="1.3" strokeDasharray="4 3" animate={{ rotate: 360 }} transition={{ duration: 9, repeat: Infinity, ease: "linear" }} style={{ ...violet, originX: "131px", originY: "62px" }} />
        <circle cx="80" cy="62" r="4" style={{ fill: "var(--accent)" }} />
        <circle cx="131" cy="62" r="3" style={{ fill: "var(--violet)" }} />
        <rect x="30" y="18" width="150" height="88" rx="6" fill="none" style={line} />
      </svg>
    );
  if (id === "shelf")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <defs>
          {/* a stress colour scale: the same on both themes */}
          <linearGradient id="tpl-stress" x1="0" x2="1">
            <stop offset="0" stopColor="#ff4d5e" />
            <stop offset="0.3" stopColor="#ffd25e" />
            <stop offset="0.65" stopColor="#3ddc97" />
            <stop offset="1" stopColor="#3b6cff" />
          </linearGradient>
        </defs>
        <path d="M46 12v98" style={line} strokeWidth="2" />
        {[20, 34, 48, 62, 76, 90, 104].map((y) => (
          <path key={y} d={`M46 ${y}l-7 6`} style={line} />
        ))}
        <rect x="48" y="22" width="8" height="78" style={tint(0.12)} strokeWidth="1.2" />
        <path d="M56 30h50L56 78z" style={tint(0.08)} strokeWidth="1.2" />
        <motion.path
          fill="url(#tpl-stress)"
          stroke="none"
          initial={{ d: "M56 22 Q110 22 164 22 L164 30 Q110 30 56 30 Z" }}
          animate={{ d: ["M56 22 Q110 22 164 22 L164 30 Q110 30 56 30 Z", "M56 22 Q110 23 164 29 L164 37 Q110 31 56 30 Z", "M56 22 Q110 22 164 22 L164 30 Q110 30 56 30 Z"] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
        <path d="M56 22h108v8H56" fill="none" style={{ stroke: "var(--accent-2)" }} strokeOpacity="0.25" strokeDasharray="3 3" />
        <motion.g animate={{ y: [0, 6, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}>
          <path d="M150 2v14" style={{ stroke: "var(--warn)" }} strokeWidth="1.6" />
          <path d="m146 12 4 5 4-5" fill="none" style={{ stroke: "var(--warn)" }} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </motion.g>
      </svg>
    );
  if (id === "canister")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.path d="M74 104V52q0-8 8-11h36q8 3 8 11v52q0 6-6 6H80q-6 0-6-6z" style={tint(0.08)} strokeWidth="1.3" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4 }} />
        <motion.g animate={{ y: [0, -6, 0] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}>
          <rect x="70" y="14" width="60" height="18" rx="3" style={{ stroke: "var(--warn)", fill: "rgb(var(--warn-rgb) / 0.12)" }} strokeWidth="1.3" />
          {Array.from({ length: 11 }, (_, i) => (
            <line key={i} x1={75 + i * 5} y1="17" x2={75 + i * 5} y2="29" style={{ stroke: "var(--warn)" }} strokeOpacity={0.5} />
          ))}
        </motion.g>
        {[0, 1, 2].map((i) => (
          <path key={i} d={`M84 ${36 + i * 4}l32 3`} style={line} strokeWidth="1.2" />
        ))}
      </svg>
    );
  if (id === "enclosure")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.path d="M40 40 100 18l60 22v44l-60 22-60-22z" style={tint(0.08)} strokeWidth="1.3" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4 }} />
        <path d="M40 40l60 22 60-22M100 62v44" fill="none" style={line} />
        <motion.rect x="76" y="50" width="48" height="10" rx="2" style={{ fill: "var(--pass)" }} opacity={0.6} animate={{ opacity: [0.3, 0.7, 0.3] }} transition={{ duration: 2.4, repeat: Infinity }} />
      </svg>
    );
  if (id === "bracket")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.path d="M62 20v76h84v-8H72a2 2 0 0 1-2-2V20z" style={tint(0.08)} strokeWidth="1.3" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4 }} />
        <path d="M72 64v20h20z" fill="none" style={violet} strokeWidth="1.2" />
        <motion.g animate={{ opacity: [0.35, 0.9, 0.35] }} transition={{ duration: 2.6, repeat: Infinity }}>
          <path d="M62 106h84M62 102v8M146 102v8" style={line} />
          <text x="104" y="116" style={{ fill: "var(--text-3)" }} fontSize="8" textAnchor="middle" fontFamily="monospace">base_len</text>
        </motion.g>
        <path d="M52 20v76M48 20h8M48 96h8" style={line} />
      </svg>
    );
  if (id === "seatpost-number")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <g transform="rotate(16 60 60)">
          <rect x="44" y="4" width="26" height="112" rx="12" fill="none" style={line} />
          <motion.rect x="66" y="40" width="14" height="34" rx="3" style={tint(0.1)} strokeWidth="1.3" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.2 }} />
          <rect x="69" y="42" width="2.4" height="30" rx="1" style={{ fill: "var(--line-3)" }} />
          <motion.ellipse cx="60" cy="57" rx="23" ry="3.8" fill="none" style={{ ...violet, originX: "60px", originY: "57px" }} strokeWidth="2.2" animate={{ scaleX: [0.86, 1.05, 1] }} transition={{ duration: 2.4, repeat: Infinity, repeatDelay: 1.2 }} />
        </g>
        <motion.g animate={{ x: [18, 0, 0] }} transition={{ duration: 3.6, repeat: Infinity, times: [0, 0.35, 1] }}>
          <path d="M92 50 104 38h64v44h-64L92 70z" style={tint(0.06)} strokeWidth="1.3" />
          <rect x="160" y="38.6" width="7.4" height="42.8" style={{ fill: "#f2c200", opacity: 0.8 }} />
          <rect x="104" y="42" width="58" height="13" rx="1.5" style={{ fill: "var(--line-3)", opacity: 0.7 }} />
          <text x="132" y="75" style={{ fill: "var(--text-2)" }} fontSize="15" fontWeight="700" textAnchor="middle">4004</text>
        </motion.g>
      </svg>
    );
  if (id === "sand-tunneller") {
    // two screw sections either side of the body; the flights scroll as if turning
    const flights = (x0: number, dir: number) => (
      <g clipPath={`url(#tun-${x0})`}>
        <motion.g animate={{ x: [0, 10 * dir] }} transition={{ duration: 0.9, repeat: Infinity, ease: "linear" }}>
          {Array.from({ length: 8 }, (_, i) => (
            <path key={i} d={`M${x0 - 10 + i * 10} 44l${6 * dir} 32`} style={{ stroke: "var(--warn)" }} strokeWidth="2" strokeLinecap="round" />
          ))}
        </motion.g>
      </g>
    );
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <defs>
          <clipPath id="tun-36"><rect x="36" y="40" width="44" height="40" /></clipPath>
          <clipPath id="tun-122"><rect x="122" y="40" width="44" height="40" /></clipPath>
        </defs>
        {[[24, 30], [62, 22], [104, 34], [150, 24], [182, 38], [40, 94], [96, 100], [138, 92], [176, 98]].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="1.6" style={{ fill: "var(--line-3)" }} />
        ))}
        <rect x="30" y="50" width="142" height="20" rx="4" style={tint(0.1)} strokeWidth="1.3" />
        <path d="M172 50l18 10-18 10" fill="none" style={accent} strokeWidth="1.3" />
        <rect x="84" y="50" width="34" height="20" style={{ ...line, fill: "rgb(var(--accent-rgb) / 0.22)" }} />
        {flights(36, 1)}
        {flights(122, -1)}
      </svg>
    );
  }
  if (id === "practice-amp")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <rect x="44" y="10" width="112" height="100" rx="5" style={{ ...line, fill: "rgb(var(--accent-rgb) / 0.06)" }} strokeWidth="1.6" />
        <rect x="50" y="16" width="100" height="20" rx="2" style={tint(0.12)} strokeWidth="1.1" />
        {[60, 72, 84, 96].map((x, i) => (
          <motion.g key={x} animate={{ rotate: [0, 40 - i * 25, 0] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut", delay: i * 0.2 }} style={{ originX: `${x}px`, originY: "26px" }}>
            <circle cx={x} cy="26" r="4" style={{ stroke: "var(--accent-2)", fill: "var(--bg-2)" }} strokeWidth="1" />
            <path d={`M${x} 26v-3.4`} style={{ stroke: "var(--text)" }} strokeWidth="1.2" />
          </motion.g>
        ))}
        {/* the tuner's OLED: the same on both themes */}
        <rect x="112" y="20" width="32" height="12" rx="1" fill="#020304" stroke="#1d3e66" />
        <text x="118" y="30" fill="#e9f6ff" fontSize="8" fontFamily="monospace">A</text>
        <motion.path d="M134 23v7" stroke="#e9f6ff" strokeWidth="1.4" animate={{ x: [-6, 2, 0, 0] }} transition={{ duration: 3.2, repeat: Infinity, ease: "easeOut" }} />
        <circle cx="100" cy="73" r="30" fill="none" style={line} strokeWidth="1.2" />
        {/* the cone pulses by scale: animating r logs "attribute r: Expected length" when the card unmounts mid-pulse */}
        <motion.circle cx="100" cy="73" r="21" style={{ ...tint(0.1), originX: "100px", originY: "73px" }} strokeWidth="1.3" animate={{ scale: [1, 1.12, 1] }} transition={{ duration: 0.5, repeat: Infinity, ease: "easeInOut" }} />
        <circle cx="100" cy="73" r="7" style={{ ...violet, fill: "rgb(var(--violet-rgb) / 0.25)" }} strokeWidth="1.1" />
      </svg>
    );
  if (id === "printer")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <path d="M58 104V16h84v88" fill="none" style={line} strokeWidth="2" />
        <motion.g animate={{ y: [0, -16, 0] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}>
          <path d="M50 58h100" style={accent} strokeWidth="1.6" />
          <motion.rect x="66" y="50" width="16" height="22" rx="2" style={tint(0.18)} strokeWidth="1.3" animate={{ x: [0, 52, 0] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }} />
        </motion.g>
        <motion.rect x="62" y="92" width="76" height="5" rx="1.5" style={{ stroke: "var(--warn)", fill: "rgb(var(--warn-rgb) / 0.35)" }} strokeWidth="1" animate={{ x: [-10, 10, -10] }} transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }} />
        <path d="M44 104h112" style={line} strokeWidth="2" />
      </svg>
    );
  if (id === "engine") {
    // the piston's height for 13 crank angles (throw 14, rod 42), so it rises and falls with the crank pin
    const ys = Array.from({ length: 13 }, (_, i) => {
      const a = (i / 12) * 2 * Math.PI;
      return -(14 * Math.cos(a) + Math.sqrt(42 * 42 - (14 * Math.sin(a)) ** 2)) + 56;
    });
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <path d="M80 6v62M120 6v62" style={line} strokeWidth="2" />
        <motion.rect x="82" y="0" width="36" height="20" rx="2" style={tint(0.18)} strokeWidth="1.3" animate={{ y: ys }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }} />
        <motion.g animate={{ rotate: 360 }} transition={{ duration: 2, repeat: Infinity, ease: "linear" }} style={{ originX: "100px", originY: "88px" }}>
          <circle cx="100" cy="88" r="20" fill="none" style={violet} strokeWidth="1.3" />
          <circle cx="100" cy="74" r="3" style={{ fill: "var(--violet)" }} />
        </motion.g>
        <circle cx="100" cy="88" r="3" style={{ fill: "var(--accent)" }} />
      </svg>
    );
  }
  if (id === "teacups")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.g animate={{ rotate: 360 }} transition={{ duration: 10, repeat: Infinity, ease: "linear" }} style={{ originX: "100px", originY: "60px" }}>
          <circle cx="100" cy="60" r="50" style={tint(0.06)} strokeWidth="1.3" />
          {[0, 120, 240].map((a) => {
            const cx = 100 + 28 * Math.cos((a * Math.PI) / 180);
            const cy = 60 + 28 * Math.sin((a * Math.PI) / 180);
            return (
              <motion.g key={a} animate={{ rotate: 360 }} transition={{ duration: 3.6, repeat: Infinity, ease: "linear" }} style={{ originX: `${cx}px`, originY: `${cy}px` }}>
                <circle cx={cx} cy={cy} r="15" fill="none" style={violet} strokeWidth="1.3" strokeDasharray="5 3" />
                <path d={`M${cx + 15} ${cy}h5`} style={violet} strokeWidth="2" />
              </motion.g>
            );
          })}
        </motion.g>
        <circle cx="100" cy="60" r="6" style={{ fill: "var(--accent)" }} />
      </svg>
    );
  if (id === "sheet-chassis") {
    // a flat blank folding up along its bend lines into a tray, and back
    const flat = "M24 86 L52 86 L148 86 L176 86";
    const bent = "M52 50 L52 86 L148 86 L148 50";
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.path fill="none" style={accent} strokeWidth="3" strokeLinejoin="round" initial={{ d: flat }} animate={{ d: [flat, bent, bent, flat] }} transition={{ duration: 4, times: [0, 0.4, 0.8, 1], repeat: Infinity, ease: "easeInOut" }} />
        <motion.path d="M47 66 L47 45 L153 45 L153 66" fill="none" style={violet} strokeWidth="1.4" strokeLinejoin="round" animate={{ opacity: [0, 0, 1, 1, 0] }} transition={{ duration: 4, times: [0, 0.35, 0.45, 0.8, 0.9], repeat: Infinity }} />
        {[52, 148].map((x) => (
          <path key={x} d={`M${x} 96V106`} style={line} strokeWidth="1.2" strokeDasharray="3 2" />
        ))}
        <circle cx="100" cy="86" r="2.5" style={{ fill: "var(--accent)" }} />
      </svg>
    );
  }
  if (id === "cast-knob")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        {/* the bottom half with its core, the knob, and the top half lifting off */}
        <rect x="56" y="76" width="88" height="30" rx="2" style={tint(0.08)} strokeWidth="1.3" />
        <motion.path d="M80 76 Q80 50 100 50 Q120 50 120 76 Z" style={{ ...violet, fill: "rgb(var(--violet-rgb) / 0.25)" }} strokeWidth="1.3" animate={{ opacity: [1, 1, 0.35, 1] }} transition={{ duration: 3.2, times: [0, 0.45, 0.7, 1], repeat: Infinity }} />
        <motion.g animate={{ y: [0, 0, -22, -22, 0] }} transition={{ duration: 3.2, times: [0, 0.2, 0.45, 0.75, 1], repeat: Infinity, ease: "easeInOut" }}>
          <path d="M56 76 V46 H144 V76 H120 Q120 50 100 50 Q80 50 80 76 Z" style={tint(0.12)} strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M100 50V40" style={accent} strokeWidth="3" />
        </motion.g>
      </svg>
    );
  if (id === "pirate-ship")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <path d="M60 112 100 14l40 98" fill="none" style={line} strokeWidth="2" />
        <motion.g animate={{ rotate: [-32, 32, -32] }} transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }} style={{ originX: "100px", originY: "16px" }}>
          <path d="M92 18 84 78M108 18l8 60" style={accent} strokeWidth="1.3" />
          <path d="M62 74h76l-8 16H70z" style={tint(0.18)} strokeWidth="1.3" />
          <path d="M100 74V54l12 10z" style={{ stroke: "var(--warn)", fill: "rgb(var(--warn-rgb) / 0.2)" }} strokeWidth="1.1" />
        </motion.g>
        <circle cx="100" cy="16" r="3" style={{ fill: "var(--accent)" }} />
      </svg>
    );
  if (id === "aero-road-bike")
    return (
      <svg viewBox="0 0 200 120" width="80%" height="80%">
        {[48, 152].map((cx) => (
          <motion.g key={cx} animate={{ rotate: 360 }} transition={{ duration: 3, repeat: Infinity, ease: "linear" }} style={{ originX: `${cx}px`, originY: "84px" }}>
            <circle cx={cx} cy="84" r="28" fill="none" style={line} strokeWidth="3" />
            <circle cx={cx} cy="84" r="21" fill="none" style={line} strokeWidth="1" opacity={0.5} />
            <path d={`M${cx - 21} 84h42M${cx} 63v42`} style={line} strokeWidth="0.8" opacity={0.5} />
          </motion.g>
        ))}
        <path d="M48 84 92 88 82 40M92 88 136 42 82 40M152 84 136 42M48 84 80 52" fill="none" style={accent} strokeWidth="3.2" strokeLinejoin="round" strokeLinecap="round" />
        <path d="M136 42l-3-10h16M78 32h16" fill="none" style={accent} strokeWidth="2.4" strokeLinecap="round" />
        <circle cx="92" cy="88" r="8" fill="none" style={line} strokeWidth="1.4" strokeDasharray="2.5 1.5" />
      </svg>
    );
  if (id === "ferris-wheel") {
    // the gondolas go round the rim but hang level, so each follows the circle without turning
    const round = (k: number, axis: "x" | "y") => Array.from({ length: 25 }, (_, i) => 42 * (axis === "x" ? Math.cos : Math.sin)(((i / 24) * 360 + k * 60) * (Math.PI / 180)));
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <path d="M70 116 100 58l30 58" fill="none" style={line} strokeWidth="2" />
        <motion.g animate={{ rotate: 360 }} transition={{ duration: 16, repeat: Infinity, ease: "linear" }} style={{ originX: "100px", originY: "58px" }}>
          <circle cx="100" cy="58" r="42" fill="none" style={accent} strokeWidth="1.3" />
          {[0, 60, 120].map((a) => (
            <path key={a} d={`M${100 - 42 * Math.cos((a * Math.PI) / 180)} ${58 - 42 * Math.sin((a * Math.PI) / 180)}L${100 + 42 * Math.cos((a * Math.PI) / 180)} ${58 + 42 * Math.sin((a * Math.PI) / 180)}`} style={line} />
          ))}
        </motion.g>
        {[0, 1, 2, 3, 4, 5].map((k) => (
          <motion.rect key={k} x="94" y="58" width="12" height="10" rx="2" style={tint(0.25)} strokeWidth="1.1" animate={{ x: round(k, "x"), y: round(k, "y") }} transition={{ duration: 16, repeat: Infinity, ease: "linear" }} />
        ))}
        <circle cx="100" cy="58" r="3" style={{ fill: "var(--accent)" }} />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 200 120" width="70%" height="70%">
      <motion.rect x="60" y="25" width="80" height="70" rx="6" fill="none" style={line} strokeDasharray="6 5" animate={{ strokeDashoffset: [0, -22] }} transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }} />
      <path d="M100 48v24M88 60h24" style={accent} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
