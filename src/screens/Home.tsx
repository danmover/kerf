// Projects home: recent designs, starting points and import.

import { motion } from "framer-motion";
import { useRef, useState } from "react";
import { useProject, openProject, createProject, duplicateProject, deleteProject, exportProject, importProject, renameProject } from "../app/project";
import { confirmDialog, go, openSettings, toast } from "../app/ui";
import { TEMPLATES } from "../demos/templates";
import { Logo } from "../ui/Logo";
import { Icon } from "../ui/icons";
import { Menu, MenuItem, timeAgo, useTick } from "../ui/common";
import { useApiKey } from "../ui/ChatPanel";
import { resetChat, useChat } from "../ai/chat";
import type { ProjectRecord } from "../persist/db";
import { AccountButton, CloudTag, UploadBanner, useCloudActions } from "../ui/Account";
import { useAccount } from "../cloud/account";
import { importStepFiles, isStepFile } from "../app/imports";
import { cleanName } from "../kernel/stepText";

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
          <button className="icon-btn" onClick={() => openSettings("app")} aria-label="Settings" data-tip="Settings">
            <Icon.Settings />
          </button>
          <input ref={fileRef} type="file" accept=".kerf,.kerfproj,.kerfbackup,.json,.txt,.step,.stp" hidden onChange={(e) => void onFiles(e.target.files).finally(() => (e.target.value = ""))} />
        </div>

        <motion.div className="hero" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
          <h1>
            Describe it. <span style={{ color: "var(--accent-2)" }}>Claude models it.</span>
            <br />
            The checks keep it honest.
          </h1>
          <p>Kerf is mechanical CAD where the AI does the modelling and you direct the design. Every change, by you or by Claude, edits one design file that is rebuilt as exact solids and checked for fit, interference, tool access, motion and strength.</p>
        </motion.div>

        {save === "memory" && (
          <div className="banner" style={{ borderRadius: 10, border: "1px solid rgba(245,184,75,.35)", marginBottom: 10 }}>
            <Icon.Alert size={14} /> This browser is blocking local storage. Projects last only until you close the tab.
          </div>
        )}

        <div className="section-label">Start from</div>
        <div className="cards">
          {TEMPLATES.map((t, i) => (
            <motion.div key={t.id} className="card clickable" onClick={() => void startFrom(t.id)} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i + 0.15 }} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && void startFrom(t.id)}>
              <div className="thumb">
                <TemplateArt id={t.id} />
              </div>
              <div className="body">
                <div className="title">{t.name}</div>
                <div className="sub">{t.tagline}</div>
                <div className="foot">
                  <span className="chip">{t.stats}</span>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        <div className="section-label">Your projects</div>
        <UploadBanner />
        {!loaded ? (
          <div className="row dim">
            <div className="spinner" /> Loading…
          </div>
        ) : projects.length === 0 ? (
          <div className="empty-state">
            <div style={{ color: "var(--text-2)", fontWeight: 500 }}>No projects yet</div>
            <div style={{ marginTop: 4 }}>Pick a starting point above, or drop a .kerf, .kerfproj or backup file anywhere on this page.</div>
          </div>
        ) : (
          <div className="cards">
            {projects.map((p, i) => (
              <ProjectCard key={p.id} p={p} index={i} />
            ))}
          </div>
        )}

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
  const stroke = "#6d8bff";
  if (id === "reducer")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.circle cx="80" cy="62" r="34" fill="none" stroke={stroke} strokeWidth="1.3" strokeDasharray="5 3" animate={{ rotate: -360 }} transition={{ duration: 18, repeat: Infinity, ease: "linear" }} style={{ originX: "80px", originY: "62px" }} />
        <motion.circle cx="131" cy="62" r="17" fill="none" stroke="#c792ff" strokeWidth="1.3" strokeDasharray="4 3" animate={{ rotate: 360 }} transition={{ duration: 9, repeat: Infinity, ease: "linear" }} style={{ originX: "131px", originY: "62px" }} />
        <circle cx="80" cy="62" r="4" fill={stroke} />
        <circle cx="131" cy="62" r="3" fill="#c792ff" />
        <rect x="30" y="18" width="150" height="88" rx="6" fill="none" stroke="#39445c" />
      </svg>
    );
  if (id === "shelf")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <defs>
          <linearGradient id="tpl-stress" x1="0" x2="1">
            <stop offset="0" stopColor="#ff4d5e" />
            <stop offset="0.3" stopColor="#ffd25e" />
            <stop offset="0.65" stopColor="#3ddc97" />
            <stop offset="1" stopColor="#3b6cff" />
          </linearGradient>
        </defs>
        <path d="M46 12v98" stroke="#39445c" strokeWidth="2" />
        {[20, 34, 48, 62, 76, 90, 104].map((y) => (
          <path key={y} d={`M46 ${y}l-7 6`} stroke="#39445c" />
        ))}
        <rect x="48" y="22" width="8" height="78" fill="rgba(109,139,255,.12)" stroke={stroke} strokeWidth="1.2" />
        <path d="M56 30h50L56 78z" fill="rgba(109,139,255,.08)" stroke={stroke} strokeWidth="1.2" />
        <motion.path
          fill="url(#tpl-stress)"
          stroke="none"
          initial={{ d: "M56 22 Q110 22 164 22 L164 30 Q110 30 56 30 Z" }}
          animate={{ d: ["M56 22 Q110 22 164 22 L164 30 Q110 30 56 30 Z", "M56 22 Q110 23 164 29 L164 37 Q110 31 56 30 Z", "M56 22 Q110 22 164 22 L164 30 Q110 30 56 30 Z"] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
        <path d="M56 22h108v8H56" fill="none" stroke="#8fa8ff" strokeOpacity="0.25" strokeDasharray="3 3" />
        <motion.g animate={{ y: [0, 6, 0] }} transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}>
          <path d="M150 2v14" stroke="#ffb454" strokeWidth="1.6" />
          <path d="m146 12 4 5 4-5" fill="none" stroke="#ffb454" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </motion.g>
      </svg>
    );
  if (id === "enclosure")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.path d="M40 40 100 18l60 22v44l-60 22-60-22z" fill="rgba(109,139,255,.08)" stroke={stroke} strokeWidth="1.3" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4 }} />
        <path d="M40 40l60 22 60-22M100 62v44" fill="none" stroke="#39445c" />
        <motion.rect x="76" y="50" width="48" height="10" rx="2" fill="#3ddc97" opacity={0.6} animate={{ opacity: [0.3, 0.7, 0.3] }} transition={{ duration: 2.4, repeat: Infinity }} />
      </svg>
    );
  if (id === "bracket")
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <motion.path d="M62 20v76h84v-8H72a2 2 0 0 1-2-2V20z" fill="rgba(109,139,255,.08)" stroke={stroke} strokeWidth="1.3" initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4 }} />
        <path d="M72 64v20h20z" fill="none" stroke="#c792ff" strokeWidth="1.2" />
        <motion.g animate={{ opacity: [0.35, 0.9, 0.35] }} transition={{ duration: 2.6, repeat: Infinity }}>
          <path d="M62 106h84M62 102v8M146 102v8" stroke="#39445c" />
          <text x="104" y="116" fill="#7f8aa3" fontSize="8" textAnchor="middle" fontFamily="monospace">base_len</text>
        </motion.g>
        <path d="M52 20v76M48 20h8M48 96h8" stroke="#39445c" />
      </svg>
    );
  return (
    <svg viewBox="0 0 200 120" width="70%" height="70%">
      <motion.rect x="60" y="25" width="80" height="70" rx="6" fill="none" stroke="#39445c" strokeDasharray="6 5" animate={{ strokeDashoffset: [0, -22] }} transition={{ duration: 1.6, repeat: Infinity, ease: "linear" }} />
      <path d="M100 48v24M88 60h24" stroke={stroke} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
