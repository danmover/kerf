// App-wide confirm dialog, keyboard shortcut sheet (in ShortcutSheet) and notifications.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { dismissToast, useUi } from "../app/ui";
import { Modal } from "./common";
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

/** the keyboard shortcut sheet, with keys the user can move (see ShortcutSheet) */
export { ShortcutsModal } from "./ShortcutSheet";

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
