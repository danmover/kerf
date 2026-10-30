// "Make a creature": the Meshy / Tripo way in, for Kerf. Describe a creature
// (or paste a whole pet prompt), drop in reference pictures, pick a style and
// a triangle budget, and Claude models it as editable organic shapes in a new
// project.

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Modal } from "../../ui/common";
import { Icon } from "../../ui/icons";
import { createProject, openProject } from "../../app/project";
import { chatKey, nameFrom } from "../../app/startDesign";
import { sendMessage, useChat } from "../../ai/chat";
import { useChatDraft } from "../../ui/chatDraft";
import { chatFile, storeFiles } from "../../ui/Attachments";
import { toast, errorText } from "../../app/ui";
import type { OrganicStyle } from "./model";
import { ROBLOX_MAX_TRIS } from "./gameExport";
import "./creature.css";

export const useCreatureDialog = create<{ open: boolean }>(() => ({ open: false }));
export const openCreatureDialog = () => useCreatureDialog.setState({ open: true });

const STYLES: { id: OrganicStyle; label: string; detail: string; tris: number[] }[] = [
  { id: "lowpoly", label: "Low-poly game", detail: "Chunky facets and flat colours, like Roblox pets", tris: [1500, 2500, 4000, 8000] },
  { id: "smooth", label: "Smooth toy", detail: "Soft rounded forms for figurines and renders", tris: [10000, 20000, 40000] },
  { id: "detailed", label: "Detailed", detail: "Fur, scales, skin or feathers up close", tris: [80000, 160000, 300000] },
];

/** What Claude is asked to do, from the dialog's choices. */
export function creatureBrief(o: { text: string; style: OrganicStyle; tris: number; height: number; blankFace: boolean; pictures: number }): string {
  const style = STYLES.find((s) => s.id === o.style)!;
  const lines = [
    `Make this creature with organic.model(): style: "${o.style}" (${style.label.toLowerCase()}), tris: ${o.tris}, about ${o.height} mm tall, facing -Y and standing on z = 0.`,
    o.blankFace ? "Leave the face blank for expression decals: no painted eyes, eyebrows or mouth, but keep the muzzle, beak or nose shape." : "Give it its eyes and mouth as part of the model.",
    o.pictures ? `Match the attached reference picture${o.pictures > 1 ? "s" : ""}: the silhouette from the front, side, back and top, the colour regions and every count. Compare with capture_view from those sides before you finish.` : "",
    "",
    o.text.trim(),
  ];
  return lines.filter((l, i) => l || i === 3).join("\n");
}

async function chatReady(projectId: string, ms = 4000) {
  if (useChat.getState().projectId === projectId) return;
  await new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    const off = useChat.subscribe((s) => s.projectId === projectId && done());
    function done() {
      clearTimeout(t);
      off();
      resolve();
    }
  });
}

export function CreatureDialog() {
  const open = useCreatureDialog((s) => s.open);
  const [text, setText] = useState("");
  const [style, setStyle] = useState<OrganicStyle>("lowpoly");
  const [tris, setTris] = useState(2500);
  const [height, setHeight] = useState(100);
  const [blankFace, setBlankFace] = useState(true);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const pick = useRef<HTMLInputElement>(null);
  const urls = useRef(new Map<File, string>());
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  const close = () => useCreatureDialog.setState({ open: false });
  const urlOf = (f: File) => {
    let u = urls.current.get(f);
    if (!u) urls.current.set(f, (u = URL.createObjectURL(f)));
    return u;
  };
  const addFiles = (list: FileList | File[] | null) => {
    const imgs = [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    if (imgs.length) setFiles((cur) => [...cur, ...imgs].slice(0, 6));
  };
  const chooseStyle = (id: OrganicStyle) => {
    setStyle(id);
    const s = STYLES.find((x) => x.id === id)!;
    setTris(s.tris[Math.min(1, s.tris.length - 1)]);
    setBlankFace(id === "lowpoly");
  };

  const make = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const brief = creatureBrief({ text, style, tris, height, blankFace, pictures: files.length });
      const name = nameFrom(text.replace(/^(?:island pet|pet)\s+/i, ""));
      const p = await createProject("blank", name, `design "${name.replace(/"/g, "")}"\n`);
      await openProject(p.id);
      await chatReady(p.id);
      const stored = files.length ? await storeFiles(files) : [];
      if (chatKey()) await sendMessage(brief, { files: stored.map(chatFile) });
      else useChatDraft.getState().set(brief);
      close();
      setText("");
      setFiles([]);
    } catch (e) {
      toast({ kind: "warn", title: "Could not start the creature", detail: errorText(e) });
    } finally {
      setBusy(false);
    }
  };

  const s = STYLES.find((x) => x.id === style)!;
  return (
    <Modal
      open={open}
      onClose={close}
      title="Make a creature"
      width={620}
      icon={<Icon.Sparkle size={16} />}
      footer={
        <>
          <span className="muted" style={{ fontSize: 12, marginRight: "auto" }}>
            Claude builds it from editable shapes in a new project.
          </span>
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" disabled={!text.trim() || busy} onClick={() => void make()}>
            {busy ? <span className="spinner" /> : <Icon.Send size={13} />} Make it
          </button>
        </>
      }
    >
      <div className="modal-body creature-dialog">
        <label className="creature-label" htmlFor="creature-text">
          Describe it, or paste a whole pet prompt
        </label>
        <textarea
          id="creature-text"
          className="creature-text"
          rows={5}
          maxLength={20000}
          value={text}
          placeholder="A chubby sky-blue fox with white paws, big pointed ears and a tail that ends in a white cloud swirl…"
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => addFiles(e.clipboardData?.files ?? null)}
        />
        <div
          className="creature-drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer.files);
          }}
        >
          {files.map((f, i) => (
            <div key={i} className="creature-thumb">
              <img src={urlOf(f)} alt={f.name} />
              <button className="icon-btn" aria-label={`Remove ${f.name}`} onClick={() => setFiles((cur) => cur.filter((x) => x !== f))}>
                <Icon.X size={11} />
              </button>
            </div>
          ))}
          <button className="btn ghost small" onClick={() => pick.current?.click()}>
            <Icon.Upload size={12} /> {files.length ? "Add another picture" : "Add reference pictures (optional): a sheet, sketch or photo"}
          </button>
          <input ref={pick} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
        </div>
        <div className="creature-label">Style</div>
        <div className="creature-styles" role="radiogroup" aria-label="Style">
          {STYLES.map((x) => (
            <button key={x.id} role="radio" aria-checked={style === x.id} className={`creature-style ${style === x.id ? "active" : ""}`} onClick={() => chooseStyle(x.id)}>
              <b>{x.label}</b>
              <span>{x.detail}</span>
            </button>
          ))}
        </div>
        <div className="creature-row">
          <label>
            Triangles
            <select value={tris} onChange={(e) => setTris(Number(e.target.value))}>
              {s.tris.map((n) => (
                <option key={n} value={n}>
                  {n.toLocaleString()}
                  {n > ROBLOX_MAX_TRIS ? " (too many for one Roblox mesh)" : ""}
                </option>
              ))}
            </select>
          </label>
          <label>
            Height, mm
            <input type="number" min={10} max={2000} value={height} onChange={(e) => setHeight(Math.min(2000, Math.max(10, Number(e.target.value) || 100)))} />
          </label>
          <label className="creature-check">
            <input type="checkbox" checked={blankFace} onChange={(e) => setBlankFace(e.target.checked)} /> Blank face for decals
          </label>
        </div>
      </div>
    </Modal>
  );
}
