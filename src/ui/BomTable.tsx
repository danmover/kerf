// Bill of materials from the evaluated design.

import { useMemo } from "react";
import { useDesign, meshes } from "../core/engine";
import { bomRows, bomCsv, download, safeFileName } from "../persist/files";
import { materialDensity } from "../library/standards";
import { fmtNum } from "../lang/values";
import { Icon } from "./icons";

export function BomTable() {
  const model = useDesign((s) => s.model);
  const meshVersion = useDesign((s) => s.meshVersion);
  const rows = useMemo(() => (model ? bomRows(model) : []), [model]);
  const totals = useMemo(() => {
    if (!model) return { mass: 0, printed: 0 };
    let mass = 0;
    let printed = 0;
    for (const p of model.parts) {
      const v = meshes.get(p.hash)?.volume ?? 0;
      const g = (v / 1000) * materialDensity(p.material);
      mass += g;
      if (p.kind === "part" && ["PLA", "PETG", "ABS", "ASA", "Nylon"].includes(p.material)) printed += g;
    }
    return { mass, printed };
    // meshVersion: volumes arrive with meshes
  }, [model, meshVersion]);
  if (!model) return null;
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto" }}>
      <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {rows.length} line items · {fmtNum(totals.mass, 0)} g total · {fmtNum(totals.printed, 0)} g printed
        </span>
        <div className="grow" />
        <button className="btn sm" onClick={() => download(bomCsv(model), safeFileName(model.name + " BOM", "csv"), "text/csv")}>
          <Icon.Download size={13} /> CSV
        </button>
      </div>
      {rows.length ? (
        <table className="bom">
          <thead>
            <tr>
              <th>Qty</th>
              <th>Make / buy</th>
              <th>Item</th>
              <th>Description</th>
              <th>Material</th>
              <th>Standard</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="qty">{r.qty}</td>
                <td>
                  <span className={`chip ${r.kind === "Make" ? "accent" : ""}`}>{r.kind}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {r.item}
                </td>
                <td>{r.description}</td>
                <td>{r.material}</td>
                <td className="mono dim">{r.standard}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-state" style={{ margin: 16 }}>
          No parts yet.
        </div>
      )}
    </div>
  );
}
