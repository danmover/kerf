// Left panel: the model's parts, its parameters and its version history.
//
// Each tab is one entry in LEFT_TABS. A feature that needs its own place in
// the panel (sketches, a plan, decisions) adds an entry there: the tab bar,
// filter field, transitions and scroll handling come with it.

import { motion } from "framer-motion";
import { useRef, useState, type FC, type ReactNode } from "react";
import { useView, type LeftTab } from "../app/view";
import { useDesign } from "../core/engine";
import { useProject } from "../app/project";
import { Icon } from "./icons";
import { G } from "./left/glyphs";
import { PartsTab } from "./left/PartsTab";
import { ParamsTab } from "./left/ParamsTab";
import { HistoryTab, HistoryTools } from "./left/HistoryTab";
import "../styles/left-panel.css";

export interface LeftTabDef {
  id: LeftTab;
  label: string;
  icon: ReactNode;
  /** small count next to the label; a component so it can read stores */
  Count?: FC;
  /** placeholder for the filter field; leave out for tabs without filtering */
  filter?: string;
  /** replaces the filter field (the history tab puts undo and redo there) */
  Tools?: FC;
  Body: FC<{ filter: string }>;
}

const PartsCount: FC = () => {
  const n = useDesign((s) => (s.model ? new Set(s.model.parts.map((p) => p.name)).size : 0));
  return n ? <>{n}</> : null;
};
const ParamsCount: FC = () => {
  const n = useDesign((s) => s.model?.params.length ?? 0);
  return n ? <>{n}</> : null;
};
const HistoryCount: FC = () => {
  const n = useProject((s) => s.versions.length);
  return n > 1 ? <>{n}</> : null;
};

export const LEFT_TABS: LeftTabDef[] = [
  { id: "structure", label: "parts", icon: <Icon.Layers size={14} />, Count: PartsCount, filter: "Filter parts", Body: PartsTab },
  { id: "params", label: "params", icon: <Icon.Sliders size={14} />, Count: ParamsCount, filter: "Filter parameters", Body: ParamsTab },
  { id: "history", label: "history", icon: <Icon.History size={14} />, Count: HistoryCount, Tools: HistoryTools, Body: HistoryTab },
];

export function LeftPanel() {
  const active = useView((s) => s.leftTab);
  const tab = LEFT_TABS.find((t) => t.id === active) ?? LEFT_TABS[0];
  const index = LEFT_TABS.indexOf(tab);
  const prevIndex = useRef(index);
  const dir = index === prevIndex.current ? 0 : index > prevIndex.current ? 1 : -1;
  prevIndex.current = index;
  const [filters, setFilters] = useState<Record<string, string>>({});
  const filter = filters[tab.id] ?? "";
  const setFilter = (v: string) => setFilters((f) => ({ ...f, [tab.id]: v }));

  return (
    <div className="panel panel-left lp">
      <div className="lp-tabs" role="tablist" aria-label="Model panel">
        {LEFT_TABS.map((t) => {
          const on = t.id === tab.id;
          return (
            <button key={t.id} role="tab" id={`lp-tab-${t.id}`} aria-selected={on} aria-controls="lp-body" className={`lp-tab ${on ? "active" : ""}`} onClick={() => useView.setState({ leftTab: t.id })}>
              <span className="lp-tab-icon">{t.icon}</span>
              <span className="lp-tab-label">{t.label}</span>
              {t.Count && (
                <span className="lp-tab-count">
                  <t.Count />
                </span>
              )}
              {on && <motion.span layoutId="lp-tab-line" className="lp-tab-line" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
            </button>
          );
        })}
      </div>
      {(tab.filter || tab.Tools) && (
        <div className="lp-tools">
          {tab.Tools ? <tab.Tools /> : <FilterField value={filter} onChange={setFilter} placeholder={tab.filter!} />}
        </div>
      )}
      <div className="lp-body" id="lp-body" role="tabpanel" aria-labelledby={`lp-tab-${tab.id}`}>
        {/* keyed so each switch replays a compositor-only entrance, smooth even while a rebuild keeps the main thread busy */}
        <div key={tab.id} className={`lp-page ${dir > 0 ? "from-right" : dir < 0 ? "from-left" : ""}`}>
          <tab.Body filter={filter.trim().toLowerCase()} />
        </div>
      </div>
    </div>
  );
}

function FilterField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <label className={`lp-filter ${value ? "has-value" : ""}`}>
      <G.Search size={13} />
      <input
        value={value}
        placeholder={placeholder}
        aria-label={placeholder}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            if (value) onChange("");
            else (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {value && (
        <button className="lp-filter-clear" onClick={() => onChange("")} aria-label="Clear filter">
          <Icon.X size={12} />
        </button>
      )}
    </label>
  );
}
