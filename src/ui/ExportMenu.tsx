// The Export button and its panel: every format Kerf can write, grouped by
// what you'll do with it, with an "only the selected parts" switch and the
// last format used offered first. The formats live in app/exportFormats.

import { useEffect, useState } from "react";
import { EXPORT_FORMATS, EXPORT_GROUPS, exportFormat, runExport, useExports, type ExportFormat } from "../app/exportFormats";
import { useView } from "../app/view";
import { useDesign } from "../core/engine";
import { Icon } from "./icons";
import { Menu, Toggle } from "./common";

const iconFor = (name: string) => (Icon as Record<string, (p: { size?: number }) => JSX.Element>)[name] ?? Icon.Doc;

export function ExportMenu() {
  const running = useExports((s) => s.running);
  const done = useExports((s) => s.done);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!done) return;
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 1600);
    return () => clearTimeout(t);
  }, [done]);
  return (
    <Menu
      align="right"
      width={600}
      trigger={(open, toggle) => (
        <button className={`tb-export ${open ? "open" : ""} ${running ? "running" : ""} ${flash ? "done" : ""}`} onClick={toggle} aria-haspopup="menu" aria-expanded={open} data-tip={running ? `Exporting ${exportFormat(running)?.label ?? ""}…` : undefined}>
          <span className="tb-export-icon">{flash ? <Icon.Check size={14} /> : running ? <span className="spinner" style={{ width: 12, height: 12, borderWidth: 1.5 }} /> : <Icon.Download size={14} />}</span>
          <span className="narrow-hide-sm">Export</span>
          <span className="tb-export-caret">
            <Icon.ChevronDown size={12} />
          </span>
        </button>
      )}
    >
      {(close) => <ExportPanel close={close} />}
    </Menu>
  );
}

function ExportPanel({ close }: { close: () => void }) {
  const selected = useView((s) => s.selected.length);
  const hasParts = useDesign((s) => !!s.model?.parts.length);
  const last = exportFormat(useExports((s) => s.last));
  const [onlySel, setOnlySel] = useState(false);
  const go = (f: ExportFormat) => {
    close();
    void runExport(f.id, { selectionOnly: onlySel });
  };
  let n = 0;
  return (
    <div className="xp" role="none">
      <div className="xp-head">
        <span className="xp-title">Export</span>
        {last && (
          <button className="xp-again" role="menuitem" onClick={() => go(last)} disabled={!hasParts && last.group !== "project"}>
            <Icon.Refresh size={12} /> Again: {last.label} <span className="xp-ext">{last.ext}</span>
          </button>
        )}
        <div className="grow" />
        {selected > 0 && (
          <label className="xp-sel">
            Only the {selected} selected
            <Toggle on={onlySel} onChange={setOnlySel} label="Only the selected parts" />
          </label>
        )}
      </div>
      <div className="xp-grid">
        {EXPORT_GROUPS.map((g) => {
          const items = EXPORT_FORMATS.filter((f) => f.group === g.id);
          if (!items.length) return null;
          return (
            <section key={g.id} className={`xp-group xp-${g.id}`}>
              <div className="xp-label">{g.label}</div>
              {items.map((f) => {
                const I = iconFor(f.icon);
                const why = f.unavailable?.() ?? (!hasParts && f.group !== "project" && f.group !== "document" ? "The design has no parts yet" : null);
                const dim = onlySel && !f.selection;
                return (
                  <button key={f.id} className={`xp-item ${dim ? "dim" : ""}`} role="menuitem" disabled={!!why} onClick={() => go(f)} data-tip={why ?? (dim ? "Exports the whole design" : undefined)} style={{ ["--i" as string]: n++ }}>
                    <span className="xp-icon">
                      <I size={15} />
                    </span>
                    <span className="xp-text">
                      <span className="xp-name">{f.label}</span>
                      <span className="xp-detail">{f.detail}</span>
                    </span>
                    <span className="xp-ext">{f.ext}</span>
                  </button>
                );
              })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
