// The model panel's tabs as a rail down the left edge, for tablets and narrow
// windows. Tapping a tab opens the panel on it; tapping the open tab, or the
// fold button at the top, folds the panel away so the 3D view and the chat
// get the room. The panel's own tab row is hidden while the rail is shown.

import { motion } from "framer-motion";
import { useView } from "../app/view";
import { LEFT_TABS } from "./LeftPanel";
import { Icon } from "./icons";

export function LeftRail({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  const active = useView((s) => s.leftTab);
  return (
    <nav className="lp-rail" aria-label="Model panel">
      <button className={`lp-rail-fold ${open ? "open" : ""}`} onClick={() => onOpen(!open)} aria-expanded={open} aria-label={open ? "Fold the model panel away" : "Open the model panel"}>
        <Icon.PanelLeft size={17} />
      </button>
      {LEFT_TABS.map((t) => {
        const on = open && t.id === active;
        return (
          <button
            key={t.id}
            className={`lp-rail-tab ${on ? "active" : ""}`}
            aria-pressed={on}
            onClick={() => {
              if (on) return onOpen(false);
              useView.setState({ leftTab: t.id });
              onOpen(true);
            }}
          >
            <span className="lp-rail-icon">
              {t.icon}
              {t.Count && (
                <span className="lp-rail-count">
                  <t.Count />
                </span>
              )}
            </span>
            <span className="lp-rail-label">{t.label}</span>
            {on && <motion.span layoutId="lp-rail-line" className="lp-rail-line" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
          </button>
        );
      })}
    </nav>
  );
}
