// A closer look at one reference: the full image or the PDF, its title and
// notes (what Claude read from it), and ways to talk about it or remove it.

import { useEffect, useState } from "react";
import { create } from "zustand";
import { Modal, Menu, MenuItem } from "./common";
import { Icon } from "./icons";
import { BIcon } from "./briefIcons";
import { useAssetUrl } from "../persist/assets";
import { useProject } from "../app/project";
import { useDesign } from "../core/engine";
import { useChatDraft } from "./chatDraft";
import { editBrief } from "./briefEdit";
import { confirmDialog } from "../app/ui";
import "../styles/brief.css";

interface Target {
  /** reference id in the brief, when the file is one */
  ref?: string;
  /** asset id of a stored file */
  file?: string;
  name?: string;
}

export const useRefViewer = create<{ target: Target | null }>(() => ({
  target: null,
}));
export const openRef = (t: Target) => useRefViewer.setState({ target: t });
const close = () => useRefViewer.setState({ target: null });

/** A small preview of a stored file: the image thumbnail or a PDF badge. */
export function RefThumb({ file, kind, size = 56, title }: { file?: string; kind?: "image" | "pdf" | "link"; size?: number; title?: string }) {
  const projectId = useProject((s) => s.current?.id);
  const a = useAssetUrl(projectId, file, "thumb");
  const k = kind ?? a.kind ?? (file ? undefined : "link");
  return (
    <span className="ref-thumb" style={{ width: size, height: size }} title={title}>
      {a.url ? (
        <img src={a.url} alt={title ?? "Reference image"} draggable={false} />
      ) : a.missing ? (
        <Icon.Alert size={16} />
      ) : k === "pdf" ? (
        <span className="col" style={{ alignItems: "center", gap: 2 }}>
          <BIcon.Pdf size={18} />
          <span className="mono" style={{ fontSize: 9 }}>
            PDF
          </span>
        </span>
      ) : k === "link" ? (
        <BIcon.Link size={18} />
      ) : (
        <span className="spinner" style={{ width: 12, height: 12 }} />
      )}
    </span>
  );
}

export function RefViewer() {
  const target = useRefViewer((s) => s.target);
  const projectId = useProject((s) => s.current?.id);
  const brief = useDesign((s) => s.model?.brief);
  const ref = target?.ref ? brief?.refs.find((r) => r.id === target.ref) : target?.file ? brief?.refs.find((r) => r.file === target.file) : undefined;
  const file = ref?.file ?? target?.file;
  const full = useAssetUrl(projectId, file, "full");
  const setDraft = useChatDraft((s) => s.set);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  useEffect(() => {
    setTitle(ref?.title ?? target?.name ?? "");
    setNotes(ref?.notes ?? "");
  }, [ref?.id, ref?.title, ref?.notes, target?.name]);

  const save = () => {
    if (!ref) return;
    const t = title.trim() || ref.title;
    const n = notes.trim() || undefined;
    if (t === ref.title && n === ref.notes) return;
    editBrief((d) => {
      const r = d.refs.find((x) => x.id === ref.id);
      if (r) {
        r.title = t;
        r.notes = n;
      }
    }, `edited reference “${t}”`);
  };
  const remove = async () => {
    if (!ref) return;
    if (
      !(await confirmDialog({
        title: `Remove “${ref.title}” from the brief?`,
        body: "Claude stops seeing it. Undo brings it back.",
        confirm: "Remove",
        danger: true,
      }))
    )
      return;
    editBrief((d) => {
      d.refs = d.refs.filter((x) => x.id !== ref.id);
    }, `removed reference “${ref.title}”`);
    close();
  };

  const heading = ref?.title ?? target?.name ?? "Reference";
  return (
    <Modal open={!!target} onClose={() => (save(), close())} title={heading} width={980} icon={<BIcon.Image size={16} />}>
      <div className="ref-viewer">
        <div className="ref-stage">
          {full.url && full.kind === "image" ? (
            <img src={full.url} alt={heading} />
          ) : full.url && full.kind === "pdf" ? (
            <div className="col" style={{ alignItems: "center", gap: 12, color: "var(--text-2)" }}>
              <BIcon.Pdf size={44} />
              <div>{full.name}</div>
              <div className="dim" style={{ fontSize: 12, maxWidth: 360, textAlign: "center" }}>
                Claude reads every page of this PDF. Open it in a new tab to read it yourself.
              </div>
              <div className="row">
                <a className="btn sm" href={full.url} target="_blank" rel="noreferrer">
                  Open PDF
                </a>
                <a className="btn sm ghost" href={full.url} download={full.name}>
                  <Icon.Download size={13} /> Download
                </a>
              </div>
            </div>
          ) : ref?.url ? (
            <div className="col" style={{ alignItems: "center", gap: 10, color: "var(--text-2)" }}>
              <BIcon.Link size={36} />
              <a
                href={ref.url}
                target="_blank"
                rel="noreferrer noopener"
                style={{
                  wordBreak: "break-all",
                  maxWidth: 420,
                  textAlign: "center",
                }}
              >
                {ref.url}
              </a>
              <div className="dim" style={{ fontSize: 12, maxWidth: 380, textAlign: "center" }}>
                Claude cannot open web links from here. Paste the important numbers into the notes, or attach a screenshot or the PDF.
              </div>
            </div>
          ) : full.missing ? (
            <div className="dim">This file is no longer stored in this browser.</div>
          ) : (
            <div className="spinner" />
          )}
        </div>
        <div className="ref-side">
          {ref ? (
            <>
              <label className="field-label" htmlFor="ref-title">
                Title
              </label>
              <input id="ref-title" className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} onBlur={save} />
              <label className="field-label" htmlFor="ref-notes" style={{ marginTop: 12 }}>
                What matters in it
              </label>
              <textarea
                id="ref-notes"
                className="textarea"
                rows={7}
                value={notes}
                maxLength={4000}
                placeholder="Dimensions, which side is up, what to copy or avoid. Claude writes what it reads from the file here."
                onChange={(e) => setNotes(e.target.value)}
                onBlur={save}
              />
              <div className="mono dim" style={{ fontSize: 10.5, marginTop: 8 }}>
                reference {ref.id}
                {file ? ` · ${file}` : ""}
              </div>
              <div className="grow" />
              <div className="col" style={{ gap: 6, marginTop: 14 }}>
                <button
                  className="btn sm"
                  onClick={() => {
                    save();
                    close();
                    setDraft(`Look at the reference “${ref.title}” (${ref.id}) and `);
                  }}
                >
                  <Icon.Sparkle size={13} /> Ask Claude about this
                </button>
                <Menu
                  align="left"
                  trigger={(_, toggle) => (
                    <button className="btn sm ghost" onClick={toggle}>
                      <Icon.More size={13} /> More
                    </button>
                  )}
                >
                  {(done) => (
                    <MenuItem
                      danger
                      icon={<Icon.Trash size={14} />}
                      onClick={() => {
                        done();
                        void remove();
                      }}
                    >
                      Remove from the brief
                    </MenuItem>
                  )}
                </Menu>
              </div>
            </>
          ) : (
            <div className="dim" style={{ fontSize: 12.5 }}>
              This file was attached in chat but is not in the brief.
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
