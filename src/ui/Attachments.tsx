// Attaching photos, screenshots, PDFs and sketches to a chat message. Files
// are stored with the project and added to the brief as references when the
// message is sent, so Claude can look at them again later.

import { motion, AnimatePresence } from "framer-motion";
import { useRef, useState } from "react";
import type { ChatFile } from "../ai/chat";
import { addAsset, ACCEPT } from "../persist/assets";
import type { AssetRecord } from "../persist/db";
import { useProject } from "../app/project";
import { importAnyFiles, isAnyImportFile } from "../app/imports";
import { toast, errorText } from "../app/ui";
import { Menu, MenuItem } from "./common";
import { Icon } from "./icons";
import { BIcon } from "./briefIcons";
import { RefThumb, openRef } from "./RefViewer";
import { openSketchPad } from "./SketchPad";
import "../styles/brief.css";

const MAX_FILES = 8;

export const chatFile = (a: AssetRecord): ChatFile => ({
  asset: a.id,
  kind: a.kind,
  name: a.name,
});

/** Store dropped or picked files for the current project; reports files Kerf cannot use. */
export async function storeFiles(files: File[]): Promise<AssetRecord[]> {
  const projectId = useProject.getState().current?.id;
  if (!projectId) return [];
  const out: AssetRecord[] = [];
  // a STEP file or a mesh dropped here is a part to design around, not a picture: import it as one
  // (and a DXF drawing as a sketch, left closed so the chat stays in front)
  const steps = files.filter(isAnyImportFile);
  if (steps.length) void importAnyFiles(steps, { open: false });
  for (const f of files) {
    if (isAnyImportFile(f)) continue;
    try {
      out.push(await addAsset(projectId, f, f.name || (f.type === "application/pdf" ? "document.pdf" : "pasted image.png")));
    } catch (e) {
      toast({
        kind: "warn",
        title: `${f.name || "That file"} was not added`,
        detail: errorText(e),
      });
    }
  }
  return out;
}

export function useAttachments() {
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [loading, setLoading] = useState(0);
  const [over, setOver] = useState(false);
  const add = async (list: File[]) => {
    const room = MAX_FILES - files.length;
    if (room <= 0)
      return toast({
        kind: "warn",
        title: `Up to ${MAX_FILES} files per message`,
      });
    if (list.length > room)
      toast({
        kind: "warn",
        title: `Only the first ${room} file${room > 1 ? "s were" : " was"} attached`,
        detail: `Up to ${MAX_FILES} files per message.`,
      });
    const take = list.slice(0, room);
    setLoading((n) => n + take.length);
    try {
      const recs = await storeFiles(take);
      setFiles((fs) => [...fs, ...recs.map(chatFile)].slice(0, MAX_FILES));
    } finally {
      setLoading((n) => n - take.length);
    }
  };
  const sketch = () => openSketchPad((rec) => setFiles((fs) => [...fs, chatFile(rec)].slice(0, MAX_FILES)));
  return {
    files,
    loading,
    over,
    add,
    sketch,
    remove: (asset: string) => setFiles((fs) => fs.filter((f) => f.asset !== asset)),
    clear: () => setFiles([]),
    /** paste and drag-and-drop handlers for the composer */
    bind: {
      onPaste: (e: React.ClipboardEvent) => {
        const list = [...e.clipboardData.files];
        if (!list.length) return;
        e.preventDefault();
        void add(list);
      },
      onDragOver: (e: React.DragEvent) => {
        if (![...e.dataTransfer.types].includes("Files")) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver(false);
      },
      onDrop: (e: React.DragEvent) => {
        setOver(false);
        const list = [...e.dataTransfer.files];
        if (!list.length) return;
        e.preventDefault();
        void add(list);
      },
    },
  };
}

export type Attachments = ReturnType<typeof useAttachments>;

export function AttachButton({ att, disabled }: { att: Attachments; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const list = [...(e.target.files ?? [])];
          e.target.value = "";
          if (list.length) void att.add(list);
        }}
      />
      <Menu
        align="left"
        width={230}
        trigger={(open, toggle) => (
          <button className={`icon-btn sm ${open ? "active" : ""}`} onClick={toggle} disabled={disabled} aria-label="Attach a reference" data-tip="Attach a photo, PDF or sketch">
            <BIcon.Clip size={14} />
          </button>
        )}
      >
        {(close) => (
          <>
            <MenuItem
              icon={<BIcon.Image size={14} />}
              onClick={() => {
                close();
                input.current?.click();
              }}
              hint="or paste, drop"
            >
              Photo, screenshot or PDF
            </MenuItem>
            <MenuItem
              icon={<BIcon.Pen size={14} />}
              onClick={() => {
                close();
                att.sketch();
              }}
            >
              Draw a sketch
            </MenuItem>
          </>
        )}
      </Menu>
    </>
  );
}

/** Files waiting to go with the next message. */
export function PendingFiles({ att }: { att: Attachments }) {
  if (!att.files.length && !att.loading) return null;
  return (
    <div className="attach-tray">
      <AnimatePresence initial={false}>
        {att.files.map((f) => (
          <motion.div key={f.asset} className="attach-item" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.9 }}>
            <button className="attach-open" onClick={() => openRef({ file: f.asset, name: f.name })} aria-label={`Preview ${f.name}`}>
              <RefThumb file={f.asset} kind={f.kind} size={46} title={f.name} />
            </button>
            <button className="attach-x" onClick={() => att.remove(f.asset)} aria-label={`Remove ${f.name}`}>
              <Icon.X size={10} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
      {Array.from({ length: att.loading }, (_, i) => (
        <div key={`l${i}`} className="attach-item">
          <span className="ref-thumb" style={{ width: 46, height: 46 }}>
            <span className="spinner" style={{ width: 12, height: 12 }} />
          </span>
        </div>
      ))}
    </div>
  );
}

/** Thumbnails on a sent message. */
export function MessageFiles({ files }: { files?: ChatFile[] }) {
  if (!files?.length) return null;
  return (
    <div className="msg-files">
      {files.map((f) => (
        <button key={f.asset} className="attach-open" onClick={() => openRef({ ref: f.ref, file: f.asset, name: f.name })} aria-label={`Open ${f.name}`}>
          <RefThumb file={f.asset} kind={f.kind} size={64} title={f.ref ? `${f.name} (reference ${f.ref})` : f.name} />
        </button>
      ))}
    </div>
  );
}
