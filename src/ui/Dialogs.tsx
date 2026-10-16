// App-wide confirm dialog, keyboard shortcut sheet and notifications.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { dismissToast, useUi } from "../app/ui";
import { Kbd, Modal, mod } from "./common";
import { Icon } from "./icons";

export function ConfirmDialog() {
  const req = useUi((s) => s.confirm);
  const last = useRef(req);
  if (req) last.current = req;
  const shown = req ?? last.current;
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (req) setTimeout(() => btn.current?.focus(), 30);
  }, [req]);
  const answer = (ok: boolean) => {
    req?.resolve(ok);
    useUi.setState({ confirm: null });
  };
  return (
    <Modal
      open={!!req}
      onClose={() => answer(false)}
      title={shown?.title ?? ""}
      width={460}
      icon={shown?.danger ? <Icon.Alert size={16} style={{ color: "var(--fail)" }} /> : undefined}
      footer={
        <>
          <button className="btn ghost" onClick={() => answer(false)}>
            Cancel
          </button>
          <button ref={btn} className={`btn ${shown?.danger ? "danger" : "primary"}`} onClick={() => answer(true)}>
            {shown?.confirm ?? "OK"}
          </button>
        </>
      }
    >
      <div className="modal-body muted" style={{ lineHeight: 1.6 }}>
        {shown?.body}
      </div>
    </Modal>
  );
}

const SHORTCUTS: { group: string; items: [string[], string][] }[] = [
  {
    group: "General",
    items: [
      [[mod, "K"], "Focus the chat"],
      [["V"], "Talk to Claude (Enter finishes, Esc cancels)"],
      [[mod, "Z"], "Undo"],
      [[mod, "⇧", "Z"], "Redo"],
      [[mod, "S"], "Save now (Kerf also saves automatically)"],
      [["?"], "Show this sheet"],
      [["Esc"], "Clear selection, close dialogs"],
    ],
  },
  {
    group: "View",
    items: [
      [["F"], "Fit the model in view"],
      [["1"], "Isometric view"],
      [["2"], "Front view"],
      [["3"], "Right view"],
      [["4"], "Top view"],
      [["S"], "Toggle section plane"],
      [["E"], "Toggle exploded view"],
      [["X"], "Toggle x-ray"],
      [["I"], "Isolate the selection"],
      [["M"], "Draw on the view for Claude"],
      [["Space"], "Play or pause the mechanism"],
      [["A"], "Play the assembly animation"],
      [["T"], "Turntable"],
      [["L"], "Next lighting (Shift+L: previous)"],
      [["P"], "Photoreal view"],
    ],
  },
  {
    group: "Viewport mouse",
    items: [
      [["Left drag"], "Orbit"],
      [["Right drag"], "Pan"],
      [["Wheel"], "Zoom"],
      [["Alt", "drag"], "Turn the lighting"],
      [["Click"], "Select a part"],
      [["⇧", "Click"], "Add to the selection"],
      [["Double-click"], "Zoom to a part (empty space fits all)"],
      [["Right-click"], "Ask Claude about that spot"],
    ],
  },
  {
    group: "Chat and editor",
    items: [
      [["Enter"], "Send the message"],
      [["⇧", "Enter"], "New line"],
      [[mod, "F"], "Find in the design file"],
      [[mod, "Space"], "Autocomplete in the editor"],
    ],
  },
];

export function ShortcutsModal() {
  const open = useUi((s) => s.shortcutsOpen);
  return (
    <Modal open={open} onClose={() => useUi.setState({ shortcutsOpen: false })} title="Keyboard shortcuts" icon={<Icon.Keyboard size={16} />} width={720}>
      <div className="modal-body" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "6px 28px" }}>
        {SHORTCUTS.map((g) => (
          <div key={g.group}>
            <div className="section-label" style={{ marginTop: 6 }}>
              {g.group}
            </div>
            {g.items.map(([keys, label]) => (
              <div key={label} className="row" style={{ justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {label}
                </span>
                <span className="row" style={{ gap: 3 }}>
                  {keys.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </Modal>
  );
}

const TOAST_ICON = {
  success: <Icon.Check size={15} style={{ color: "var(--pass)" }} />,
  error: <Icon.Alert size={15} style={{ color: "var(--fail)" }} />,
  warn: <Icon.Alert size={15} style={{ color: "var(--warn)" }} />,
  info: <Icon.Info size={15} style={{ color: "var(--accent-2)" }} />,
};

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div key={t.id} layout className={`toast ${t.kind}`} initial={{ opacity: 0, x: 40, scale: 0.96 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }} transition={{ type: "spring", stiffness: 420, damping: 32 }}>
            <div style={{ paddingTop: 1 }}>{TOAST_ICON[t.kind]}</div>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="t">{t.title}</div>
              {t.detail && <div className="d">{t.detail}</div>}
              {t.action && (
                <button
                  className="btn sm"
                  style={{ marginTop: 8 }}
                  onClick={() => {
                    t.action!.run();
                    dismissToast(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
            <button className="icon-btn sm" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
              <Icon.X size={13} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
