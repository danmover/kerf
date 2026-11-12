// Right-click menus: one host for the whole app. openContextMenu() shows a menu at the pointer, kept on screen;
// arrow keys move through it, Enter runs an item, Esc or a click elsewhere closes it. A menu can also take typing:
// on a part, starting to type asks Claude about that spot with what was typed.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { create } from "zustand";
import { Icon } from "./icons";
import { menuItems, menuKey } from "./common";

export interface CtxItem {
  label: string;
  icon?: ReactNode;
  /** a shortcut, shown on the right */
  hint?: string;
  run: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** a toggle that is on */
  checked?: boolean;
}
export type CtxEntry = CtxItem | "sep" | { heading: string };

export interface CtxMenu {
  x: number;
  y: number;
  entries: CtxEntry[];
  /** typing a letter while the menu is open closes it and hands the letter on (asking Claude, on a part) */
  onType?: (text: string) => void;
  /** said at the foot of the menu when it takes typing */
  typeHint?: string;
  nonce: number;
}

export const useContextMenu = create<{ menu: CtxMenu | null }>(() => ({ menu: null }));

let nonce = 0;
/** Show a menu at a point on screen (client pixels). Separators at the ends or doubled are dropped. */
export function openContextMenu(at: { x: number; y: number }, entries: CtxEntry[], opts: { onType?: (text: string) => void; typeHint?: string } = {}) {
  const tidy = entries.filter((e, i, a) => e !== "sep" || (i > 0 && i < a.length - 1 && a[i - 1] !== "sep"));
  useContextMenu.setState({ menu: { x: at.x, y: at.y, entries: tidy, ...opts, nonce: ++nonce } });
}
export function closeContextMenu() {
  if (useContextMenu.getState().menu) useContextMenu.setState({ menu: null });
}

export function ContextMenuHost() {
  const menu = useContextMenu((s) => s.menu);
  return <AnimatePresence>{menu && <MenuAt key={menu.nonce} menu={menu} />}</AnimatePresence>;
}

function MenuAt({ menu }: { menu: CtxMenu }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  // where it opens: at the pointer, flipped left or up when it would run off the window
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth,
      h = el.offsetHeight;
    const W = window.innerWidth,
      H = window.innerHeight;
    const left = menu.x + w + 8 > W ? Math.max(8, menu.x - w) : menu.x;
    const top = menu.y + h + 8 > H ? Math.max(8, Math.min(menu.y - h, H - h - 8)) : menu.y;
    setPos({ left, top });
  }, [menu]);
  useEffect(() => {
    if (pos) menuItems(ref.current)[0]?.focus({ preventScroll: true });
  }, [!!pos]);
  useEffect(() => {
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeContextMenu();
      }
    };
    const gone = () => closeContextMenu();
    // (not on contextmenu: on Windows it comes after the button is let go, so after the view opened this menu)
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", gone);
    window.addEventListener("blur", gone);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", gone);
      window.removeEventListener("blur", gone);
    };
  }, []);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (menu.onType && e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // the letter is the start of a question, not a shortcut
      e.preventDefault();
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      closeContextMenu();
      menu.onType(e.key);
      return;
    }
    menuKey(e);
  };

  return (
    <motion.div
      ref={ref}
      className="menu ctx-menu"
      role="menu"
      aria-label="Actions"
      style={{ position: "fixed", left: pos?.left ?? menu.x, top: pos?.top ?? menu.y, visibility: pos ? "visible" : "hidden", maxHeight: "calc(100dvh - 16px)", overflowY: "auto" }}
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.08 } }}
      transition={{ duration: 0.12 }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.entries.map((e, i) =>
        e === "sep" ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : "heading" in e ? (
          <div key={i} className="menu-label">
            {e.heading}
          </div>
        ) : (
          <button
            key={i}
            className="menu-item"
            role={e.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={e.checked}
            disabled={e.disabled}
            style={e.danger ? { color: "var(--fail-ink)" } : undefined}
            onClick={() => {
              closeContextMenu();
              e.run();
            }}
          >
            <span className="ctx-icon">{e.checked ? <Icon.Check size={13} /> : e.icon}</span>
            <span>{e.label}</span>
            {e.hint && <span className="hint">{e.hint}</span>}
          </button>
        ),
      )}
      {menu.typeHint && <div className="ctx-type">{menu.typeHint}</div>}
    </motion.div>
  );
}
