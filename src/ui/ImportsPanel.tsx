// Imported STEP files: the list in the Structure tab, the facts shown for a
// selected imported body, and dropping STEP files onto the workspace.

import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useRef, useState, type DragEvent } from "react";
import { useDesign } from "../core/engine";
import { importUsers, useImports } from "../core/imports";
import type { EvalPart } from "../core/model";
import { mountingHoles, type ImportMeta, type ProjectImport } from "../kernel/imports";
import { fmtNum } from "../lang/values";
import { downloadImport, importStepFiles, isStepFile, placeImport, removeImport, replaceImport } from "../app/imports";
import { select, useView } from "../app/view";
import { useChatDraft } from "./chatDraft";
import { Menu, MenuItem } from "./common";
import { Icon } from "./icons";
import "../styles/imports.css";

export const STEP_ACCEPT = ".step,.stp,.p21";

const sizeText = (m: ImportMeta) => m.bbox[1].map((v, k) => fmtNum(v - m.bbox[0][k], 1)).join(" × ") + " mm";

function holeText(m: ImportMeta) {
  const holes = mountingHoles(m);
  if (!holes.length) return "";
  const ds = [...new Set(holes.map((h) => fmtNum(h.d, 2)))];
  return `${holes.length} hole${holes.length === 1 ? "" : "s"} Ø${ds.slice(0, 3).join("/")}`;
}

const mb = (n: number) => (n > 1e6 ? `${fmtNum(n / 1e6, 1)} MB` : `${fmtNum(n / 1e3, 0)} kB`);

/** The Imported files list at the bottom of the Structure tab. */
export function ImportsSection() {
  const list = useImports((s) => s.list);
  const status = useImports((s) => s.status);
  const model = useDesign((s) => s.model);
  const users = useMemo(() => importUsers(model), [model]);
  const pick = useRef<HTMLInputElement>(null);
  const swap = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState<string | null>(null);

  return (
    <div className="tree-group imports">
      <div className="tree-group-head imports-head">
        Imported files
        <span className="imports-count">{list.length || ""}</span>
        <button className="btn sm ghost imports-add" onClick={() => pick.current?.click()} data-tip="Import a STEP file (.step, .stp)">
          <Icon.Upload size={12} /> STEP
        </button>
      </div>
      <input ref={pick} type="file" accept={STEP_ACCEPT} multiple hidden onChange={(e) => void importStepFiles([...(e.target.files ?? [])]).finally(() => (e.target.value = ""))} />
      <input
        ref={swap}
        type="file"
        accept={STEP_ACCEPT}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f && replacing) void replaceImport(replacing, f);
          e.target.value = "";
          setReplacing(null);
        }}
      />
      {list.length === 0 ? (
        <div className="imports-empty">Design around a bought part or a circuit board: import its STEP file here, or drop it on the 3D view.</div>
      ) : (
        <AnimatePresence initial={false}>
          {list.map((i) => (
            <ImportRow
              key={i.name}
              imp={i}
              state={status[i.hash]?.state ?? "loading"}
              error={status[i.hash]?.error}
              users={users.get(i.name) ?? []}
              onReplace={() => {
                setReplacing(i.name);
                swap.current?.click();
              }}
            />
          ))}
        </AnimatePresence>
      )}
    </div>
  );
}

function ImportRow({ imp, state, error, users, onReplace }: { imp: ProjectImport; state: string; error?: string; users: string[]; onReplace: () => void }) {
  const model = useDesign((s) => s.model);
  const selected = useView((s) => s.selected);
  const ids = useMemo(() => (model?.parts ?? []).filter((p) => p.imported?.file === imp.name).map((p) => p.id), [model, imp.name]);
  const isSel = ids.length > 0 && ids.every((id) => selected.includes(id));
  const m = imp.meta;
  const ask = () => {
    const as = users.length ? ` (placed as \`${users[0]}\`)` : "";
    useChatDraft.getState().set(`About the imported file ${imp.name}${as}: `);
  };
  return (
    <motion.div layout initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, height: 0 }} className={`import-row ${isSel ? "selected" : ""}`}>
      <div className="tree-row" onClick={() => ids.length && select(ids)} onMouseEnter={() => ids[0] && useView.setState({ hovered: ids[0] })} onMouseLeave={() => useView.setState({ hovered: null })}>
        <span className={`import-state ${state}`} data-tip={state === "ready" ? "Loaded" : state === "loading" ? "Reading the file" : error}>
          {state === "loading" ? <span className="spinner tiny" /> : state === "ready" ? <Icon.Cube size={13} /> : <Icon.Alert size={13} />}
        </span>
        <span className="name" title={imp.file}>
          {imp.name}
        </span>
        <span className="meta">{users.length ? (users.length > 1 ? `×${users.length}` : "placed") : ""}</span>
        <span className="row-actions">
          {!users.length && m && (
            <button
              className="icon-btn sm"
              aria-label="Place in the design"
              data-tip="Place in the design"
              onClick={(e) => {
                e.stopPropagation();
                placeImport(imp.name);
              }}
            >
              <Icon.Plus size={13} />
            </button>
          )}
          <button
            className="icon-btn sm"
            aria-label="Ask Claude about it"
            data-tip="Ask Claude about it"
            onClick={(e) => {
              e.stopPropagation();
              ask();
            }}
          >
            <Icon.Sparkle size={13} />
          </button>
          <Menu
            align="right"
            width={230}
            trigger={(open, toggle) => (
              <button
                className={`icon-btn sm ${open ? "active" : ""}`}
                aria-label="More"
                onClick={(e) => {
                  e.stopPropagation();
                  toggle();
                }}
              >
                <Icon.More size={13} />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem icon={<Icon.Plus size={14} />} disabled={!m} onClick={() => (close(), placeImport(imp.name))}>
                  {users.length ? "Place another copy" : "Place in the design"}
                </MenuItem>
                <MenuItem icon={<Icon.Refresh size={14} />} onClick={() => (close(), onReplace())}>
                  Replace with a new version…
                </MenuItem>
                <MenuItem icon={<Icon.Download size={14} />} onClick={() => (close(), void downloadImport(imp.name))} hint=".step">
                  Download the original
                </MenuItem>
                <div className="menu-sep" />
                <MenuItem icon={<Icon.Trash size={14} />} danger onClick={() => (close(), void removeImport(imp.name))}>
                  Remove from project
                </MenuItem>
              </>
            )}
          </Menu>
        </span>
      </div>
      <div className="import-facts">
        {state === "error" || state === "missing" ? (
          <span className="import-error">{error}</span>
        ) : m ? (
          <>
            {m.bodies.length} bod{m.bodies.length === 1 ? "y" : "ies"} · {sizeText(m)}
            {holeText(m) && ` · ${holeText(m)}`} · {mb(imp.size)}
            {m.warnings.length > 0 && (
              <span className="import-warn" data-tip={m.warnings.join(" ")}>
                {" "}
                · <Icon.Info size={11} />
              </span>
            )}
          </>
        ) : (
          "Reading the file…"
        )}
      </div>
    </motion.div>
  );
}

/** Lines about an imported body for the selection card. */
export function ImportFacts({ part }: { part: EvalPart }) {
  const imp = useImports((s) => s.list.find((i) => i.name === part.imported?.file));
  const info = part.imported;
  if (!info || !imp?.meta) return null;
  const m = imp.meta;
  const body = m.bodies[info.body];
  const holes = m.cylinders.filter((c) => c.body === info.body && c.hole && c.sweep > 0.95 && c.d >= 1.5).length;
  return (
    <>
      {m.bodies.length > 1 && (
        <div>
          body {info.body + 1} of {m.bodies.length}: <span style={{ color: "var(--text-2)" }}>{info.bodyName}</span>
        </div>
      )}
      <div>
        from {imp.file}
        {body?.kind !== "solid" ? " · surfaces only, not checked for interference" : ""}
        {holes ? ` · ${holes} hole${holes === 1 ? "" : "s"}` : ""}
      </div>
    </>
  );
}

/** Drag-and-drop of STEP files onto the workspace. */
export function useStepDrop() {
  const [over, setOver] = useState(false);
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        setOver(true);
      },
      onDragLeave: (e: DragEvent) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setOver(false);
        const files = [...e.dataTransfer.files];
        if (files.some(isStepFile)) void importStepFiles(files);
        else void importStepFiles([]);
      },
    },
  };
}

export function StepDropOverlay({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="step-drop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="step-drop-card">
            <Icon.Upload size={22} />
            <div className="step-drop-title">Drop STEP files to import</div>
            <div className="step-drop-sub">Kerf reads the solids, their names and colours, and finds the holes to align to.</div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
