// Shared UI primitives.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`toggle ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Segmented<T extends string>({ value, options, onChange, id }: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; id: string }) {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button key={o.value} type="button" role="tab" aria-selected={value === o.value} className={value === o.value ? "active" : ""} onClick={() => onChange(o.value)} data-tip={o.title}>
          {value === o.value && <motion.div layoutId={`seg-${id}`} className="seg-bg" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, width = 720, icon }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: number; icon?: ReactNode }) {
  // Presence is handled here rather than by AnimatePresence so a closing
  // dialog can never linger invisibly over the page and swallow clicks.
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const t = setTimeout(() => setMounted(false), 220);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);
  if (!mounted) return null;
  return createPortal(
    <motion.div
      className="overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: open ? 1 : 0 }}
      transition={{ duration: 0.16 }}
      style={{ pointerEvents: open ? "auto" : "none" }}
      aria-hidden={!open}
      onMouseDown={(e) => open && e.target === e.currentTarget && onClose()}
    >
      <motion.div
        className="modal"
        role="dialog"
        aria-modal="true"
        style={{ width: `min(${width}px, 100%)` }}
        initial={{ opacity: 0, y: 14, scale: 0.98 }}
        animate={open ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: 8, scale: 0.98 }}
        transition={open ? { type: "spring", stiffness: 420, damping: 34 } : { duration: 0.15 }}
      >
        <div className="modal-head">
          {icon}
          <h2>{title}</h2>
          <div className="grow" />
          <button className="icon-btn" onClick={onClose} aria-label="Close" tabIndex={open ? 0 : -1}>
            <Icon.X />
          </button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </motion.div>
    </motion.div>,
    document.body,
  );
}

/** Dropdown menu anchored to a trigger; closes on outside click and Escape. */
export function Menu({ trigger, children, align = "left", width }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: "left" | "right"; width?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    // wide menus shrink to fit a narrow window
    const w = Math.min(width ?? 240, window.innerWidth - 16);
    const left = align === "right" ? Math.max(8, r.right - w) : Math.max(8, Math.min(window.innerWidth - w - 8, r.left));
    setPos({ top: r.bottom + 6, left, width: w });
  }, [open, align, width]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node) && !menuRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ display: "inline-flex" }}>
      {trigger(open, () => setOpen((o) => !o))}
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div
              ref={menuRef}
              className="menu"
              role="menu"
              style={{ position: "fixed", top: pos.top, left: pos.left, width: pos.width, maxHeight: `calc(100dvh - ${Math.round(pos.top) + 10}px)`, overflowY: "auto", transformOrigin: align === "right" ? "top right" : "top left" }}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.14 }}
            >
              {children(() => setOpen(false))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </div>
  );
}

export function MenuItem({ icon, children, hint, onClick, disabled, danger }: { icon?: ReactNode; children: ReactNode; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button className="menu-item" role="menuitem" onClick={onClick} disabled={disabled} style={danger ? { color: "#ff9aa4" } : undefined}>
      <span style={{ width: 16, display: "inline-grid", color: "var(--text-3)" }}>{icon}</span>
      <span>{children}</span>
      {hint && <span className="hint">{hint}</span>}
    </button>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const mod = isMac ? "⌘" : "Ctrl";

export function timeAgo(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 8) return `${d} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Re-render every interval (for relative times). */
export function useTick(ms = 30000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

export function Splitter({ dir, onDrag, style, onEnd }: { dir: "v" | "h"; onDrag: (delta: number) => void; style?: React.CSSProperties; onEnd?: () => void }) {
  const [drag, setDrag] = useState(false);
  return (
    <div
      className={`splitter ${dir} ${drag ? "dragging" : ""}`}
      style={style}
      role="separator"
      aria-orientation={dir === "v" ? "vertical" : "horizontal"}
      onPointerDown={(e) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        setDrag(true);
        let last = dir === "v" ? e.clientX : e.clientY;
        const move = (ev: PointerEvent) => {
          const cur = dir === "v" ? ev.clientX : ev.clientY;
          onDrag(cur - last);
          last = cur;
        };
        const up = () => {
          setDrag(false);
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          onEnd?.();
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

export function usePersistentNumber(key: string, initial: number, min: number, max: number) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      const n = raw ? Number(raw) : NaN;
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : initial;
    } catch {
      return initial;
    }
  });
  const set = (n: number) => setV(Math.min(max, Math.max(min, n)));
  const persist = () => {
    try {
      localStorage.setItem(key, String(Math.round(v)));
    } catch {
      /* ignore */
    }
  };
  return [v, set, persist] as const;
}
