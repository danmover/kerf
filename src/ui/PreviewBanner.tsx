// Shown over the 3D view while a preview is on screen: what is being shown,
// its checks, and the way back (or Apply, when the preview can be applied).

import { AnimatePresence, motion } from "framer-motion";
import { useEffect } from "react";
import { endPreview, useProject } from "../app/project";
import { CheckStrip } from "./CheckStrip";
import { Kbd } from "./common";

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function PreviewBanner() {
  const preview = useProject((s) => s.preview);
  const shown = preview && !preview.quiet;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !typing(e.target)) endPreview();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);
  return (
    <div className="preview-anchor">
      <AnimatePresence>
        {shown && (
          <motion.div className="preview-banner" role="status" initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }} transition={{ duration: 0.18 }}>
          <span className="live-dot" />
          <span className="pb-kind mono">preview</span>
          <span className="pb-label">{preview.label}</span>
          <CheckStrip />
          <button className="btn sm ghost" onClick={() => endPreview()}>
            Back <Kbd>Esc</Kbd>
          </button>
          {preview.apply && (
            <button className="btn sm primary" onClick={preview.apply}>
              Apply
            </button>
          )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
