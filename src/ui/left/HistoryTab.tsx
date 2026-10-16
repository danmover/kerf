// History tab: every saved version, newest first and grouped by day, with
// who made it, how much it changed, its diff and a one-click restore.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useProject, restoreVersion, undo, redo, previewSource, endPreview } from "../../app/project";
import { hoverParts } from "../../app/view";
import { changesBetween } from "../../core/changes";
import { useChat } from "../../ai/chat";
import { useRealModel } from "../useRealModel";
import { lineDiff, diffStats } from "../../core/sourceEdit";
import type { VersionRecord } from "../../persist/db";
import { Icon } from "../icons";
import { mod, timeAgo, useTick } from "../common";
import { G } from "./glyphs";
import { dayLabel, shortHash } from "./insights";

export function HistoryTools() {
  const undoN = useProject((s) => s.undo.length);
  const redoN = useProject((s) => s.redo.length);
  const versions = useProject((s) => s.versions.length);
  return (
    <div className="lp-histtools">
      <button className="lp-tool-btn" disabled={!undoN} onClick={undo} data-tip={`Undo (${mod}Z)`}>
        <Icon.Undo size={13} /> Undo
      </button>
      <button className="lp-tool-btn" disabled={!redoN} onClick={redo} data-tip={`Redo (${mod}⇧Z)`}>
        <Icon.Redo size={13} /> Redo
      </button>
      <span className="grow" />
      <span className="lp-histcount">{versions === 1 ? "1 version" : `${versions} versions`}</span>
    </div>
  );
}

export function HistoryTab() {
  useTick();
  const versions = useProject((s) => s.versions);
  // the real design, not a version being previewed
  const { source } = useRealModel();
  const [open, setOpen] = useState<string | null>(null);
  const list = useMemo(() => [...versions].reverse(), [versions]);
  const currentId = list.find((v) => v.source === source)?.id;
  const days = useMemo(() => {
    const out: { label: string; items: { v: VersionRecord; prev?: VersionRecord }[] }[] = [];
    list.forEach((v, i) => {
      const label = dayLabel(v.ts);
      let d = out[out.length - 1];
      if (!d || d.label !== label) out.push((d = { label, items: [] }));
      d.items.push({ v, prev: list[i + 1] });
    });
    return out;
  }, [list]);

  if (!list.length) return <div className="lp-empty">No versions yet. Every change you or Claude make is saved here.</div>;
  return (
    <div className="lp-history">
      {source !== list[0]?.source && !currentId && (
        <div className="lp-unsaved">
          <span className="lp-dot pending" /> Live edits, not saved as a version yet
        </div>
      )}
      {days.map((d) => (
        <section key={d.label} className="lp-day">
          <div className="lp-day-head">{d.label}</div>
          <AnimatePresence initial={false}>
            {d.items.map(({ v, prev }) => (
              <motion.div key={v.id} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }} style={{ overflow: "hidden" }}>
                <VersionRow v={v} prev={prev} current={v.id === currentId} open={open === v.id} onToggle={() => setOpen(open === v.id ? null : v.id)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </section>
      ))}
    </div>
  );
}

const AUTHOR = { claude: "Claude", you: "You", system: "Kerf" } as const;

function VersionRow({ v, prev, current, open, onToggle }: { v: VersionRecord; prev?: VersionRecord; current: boolean; open: boolean; onToggle: () => void }) {
  const stats = useMemo(() => (prev ? diffStats(prev.source, v.source) : null), [prev, v]);
  const diff = useMemo(() => (open ? lineDiff(prev?.source ?? "", v.source, 1) : []), [open, prev, v]);
  const hash = useMemo(() => shortHash(v.source), [v.source]);
  const parts = useMemo(() => (open && prev ? changesBetween(prev.source, v.source).parts : []), [open, prev, v]);
  const key = `version:${v.id}`;
  const showing = useProject((s) => s.preview?.key === key);
  // Claude edits the design on screen, so no previews while it works
  const busy = useChat((s) => s.busy);
  useEffect(() => () => endPreview(key), [key]);
  return (
    <div className={`lp-ver ${current ? "current" : ""} ${open ? "open" : ""} ${v.author}`}>
      <div className="lp-ver-rail" aria-hidden="true">
        <span className="lp-ver-node">{v.author === "claude" ? <Icon.Sparkle size={11} /> : v.author === "you" ? <Icon.Edit size={10} /> : <span className="lp-ver-pip" />}</span>
      </div>
      <div className="lp-ver-body">
        <button className="lp-ver-head" onClick={onToggle} aria-expanded={open}>
          <span className="lp-ver-msg">{v.message}</span>
          <span className="lp-ver-meta">
            <span className={`lp-ver-who ${v.author}`}>{AUTHOR[v.author]}</span>
            <span>{timeAgo(v.ts)}</span>
            <span className="lp-ver-hash">{hash}</span>
            {stats && (stats.added > 0 || stats.removed > 0) && (
              <span className="lp-ver-stat">
                {stats.added > 0 && <span className="add">+{stats.added}</span>}
                {stats.removed > 0 && <span className="del">−{stats.removed}</span>}
              </span>
            )}
          </span>
        </button>
        {current && <span className="lp-ver-now">current</span>}
        {!current && (
          <button
            className={`lp-icon-btn lp-ver-preview ${showing ? "on" : ""}`}
            aria-pressed={showing}
            disabled={busy && !showing}
            onClick={() => (showing ? endPreview(key) : previewSource({ key, label: `Version: ${v.message}`, apply: () => restoreVersion(v) }, v.source))}
            aria-label={showing ? "Stop previewing" : "Preview this version in 3D"}
            data-tip={showing ? "Stop previewing" : "Show this version in the 3D view without restoring it"}
            data-tip-pos="left"
          >
            {showing ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
          </button>
        )}
        {!current && (
          <button className="lp-icon-btn lp-ver-restore" onClick={() => restoreVersion(v)} aria-label="Restore this version" data-tip="Restore this version" data-tip-pos="left">
            <G.Restore size={13} />
          </button>
        )}
        <AnimatePresence initial={false}>
          {open && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }} style={{ overflow: "hidden" }}>
              {parts.length > 0 && (
                <div className="turn-parts" onMouseLeave={() => hoverParts([])}>
                  {parts.slice(0, 8).map((c) => (
                    <span key={c.id} className={`tp ${c.kind}`} onMouseEnter={() => hoverParts([c.id])}>
                      <span className="m">{{ added: "+", removed: "−", changed: "~", moved: "→" }[c.kind]}</span>
                      {c.label}
                    </span>
                  ))}
                </div>
              )}
              <div className="diff lp-ver-diff">
                {diff.length ? (
                  diff.map((l, i) => (
                    <div key={i} className={`ln ${l.kind}`}>
                      <span className="n">{l.b ?? l.a ?? ""}</span>
                      <span>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
                      <span>{l.text}</span>
                    </div>
                  ))
                ) : (
                  <div className="dim" style={{ padding: 8 }}>
                    No source changes.
                  </div>
                )}
              </div>
              {!current && (
                <button className="btn sm lp-ver-restore-btn" onClick={() => restoreVersion(v)}>
                  <G.Restore size={12} /> Restore this version
                </button>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
