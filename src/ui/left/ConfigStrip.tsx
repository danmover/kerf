// The design's configurations (configs { config "Large" { … } }) above its parameters: show one, see how each
// fares in the checks, save the current values as a new one, and export them all together.

import { useState } from "react";
import { useDesign } from "../../core/engine";
import { revealSpan } from "../../app/view";
import { runExport } from "../../app/exportFormats";
import { saveConfiguration, showConfiguration } from "../../app/configs";
import type { Model } from "../../core/model";
import { Icon } from "../icons";

export function ConfigStrip({ model }: { model: Model }) {
  const report = useDesign((s) => s.report);
  const [naming, setNaming] = useState<string | null>(null);
  const t = model.configs;
  if (!t?.rows.length) return null;

  const statusOf = (label: string): "pass" | "warn" | "fail" | undefined => {
    if (label === t.active) {
      // the report is the shown one's, less the items about the other configurations
      const own = report?.items.filter((i) => !i.id.startsWith("config:"));
      return own ? (own.some((i) => i.status === "fail") ? "fail" : own.some((i) => i.status === "warn") ? "warn" : "pass") : undefined;
    }
    const s = report?.items.find((i) => i.id === `config:${label}`)?.status;
    return s === "fail" || s === "warn" || s === "pass" ? s : undefined;
  };
  const show = showConfiguration;
  const save = () => {
    if (naming?.trim()) saveConfiguration(naming);
    setNaming(null);
  };

  return (
    <section className="lp-configs" aria-label="Configurations">
      <div className="lp-section-head">
        <span className="lp-section-slashes">//</span>
        <span className="lp-section-title">{t.title}</span>
        <span className="lp-section-rule" />
        <span className="lp-section-count">{t.rows.length}</span>
      </div>
      <div className="lp-config-chips" role="radiogroup" aria-label={t.title}>
        {t.rows.map((r) => {
          const st = statusOf(r.label);
          const on = r.label === t.active;
          return (
            <button
              key={r.label}
              role="radio"
              aria-checked={on}
              className={`lp-config-chip ${on ? "on" : ""}`}
              onClick={() => (on ? revealSpan(r.span) : show(r.label))}
              data-tip={`${r.note ? `${r.note}. ` : ""}${r.sets.map((s) => `${s.param} ${s.text}`).join(", ") || "No values of its own"}${on ? " (shown: click to see its row)" : ""}`}
              data-tip-pos="top"
            >
              {st && <span className={`lp-config-dot ${st}`} aria-label={st === "pass" ? "passes its checks" : st === "warn" ? "has warnings" : "fails a check"} />}
              {r.label}
            </button>
          );
        })}
        {t.active !== undefined && (
          <button className="lp-config-chip ghost" onClick={() => show(null)} data-tip="Show the parameters as written, with no configuration" data-tip-pos="top">
            As written
          </button>
        )}
      </div>
      <div className="lp-config-actions">
        {naming === null ? (
          <button className="lp-config-act" onClick={() => setNaming("")} data-tip="Save the values as they are now as a configuration (a new row, or the row of that name brought up to date)" data-tip-pos="top">
            <Icon.Plus size={12} /> Save as…
          </button>
        ) : (
          <span className="lp-config-name">
            <input
              className="input"
              autoFocus
              value={naming}
              placeholder="Name, like Large"
              onChange={(e) => setNaming(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setNaming(null);
              }}
              aria-label="Configuration name"
            />
            <button className="lp-config-act" onClick={save} disabled={!naming.trim()}>
              Save
            </button>
          </span>
        )}
        <button className="lp-config-act" onClick={() => void runExport("configurations")} data-tip="Every configuration's parts to make (an STL each) and parts list, with the family table, as one zip" data-tip-pos="top">
          <Icon.Download size={12} /> Export all
        </button>
      </div>
    </section>
  );
}
