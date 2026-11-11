// Bill of materials from the evaluated design, with prices and where to buy.

import { useMemo } from "react";
import { useDesign, meshes } from "../core/engine";
import { bomRows, bomCsv, bomTotal, download, safeFileName, type BomRow } from "../persist/files";
import { materialDensity } from "../library/standards";
import { isPrinted } from "../library/materials";
import { fmtNum } from "../lang/values";
import { Icon } from "./icons";
import { partMaterialCost } from "../materials/context";
import { FrameCuts } from "./FrameCuts";
import { cleanOnHand, updateSettings, useSettings } from "../app/settings";

const money = (n: number) => `$${n.toFixed(2)}`;

function WhereToBuy({ r }: { r: BomRow }) {
  if (!r.links.length) return null;
  const direct = r.links.filter((l) => l.direct);
  const search = r.links.filter((l) => !l.direct);
  return (
    <span className="buy-links">
      {direct.map((l) => (
        <a key={l.url} className="buy-link" href={l.url} target="_blank" rel="noopener noreferrer" data-tip={l.url}>
          {l.vendor}
          <span className="ext" aria-hidden="true">
            ↗
          </span>
        </a>
      ))}
      {search.map((l) => (
        <a key={l.url} className="chip buy-search" href={l.url} target="_blank" rel="noopener noreferrer" data-tip={`Search ${l.vendor}`}>
          {l.vendor}
        </a>
      ))}
    </span>
  );
}

/** Mark a bought row as something you have, or take it off the list again. */
function HaveToggle({ r, have }: { r: BomRow; have: string[] }) {
  if (r.kind !== "Buy" || !r.haveAs) return null;
  const mine = have.findIndex((h) => h.toLowerCase() === r.haveAs!.toLowerCase());
  if (r.onHand && mine < 0)
    return (
      <span className="chip" data-tip="Matches a line in Settings → Making → Parts you have">
        on hand
      </span>
    );
  return (
    <button
      className={`chip have-toggle${r.onHand ? " accent" : ""}`}
      data-tip={r.onHand ? "On hand: not counted in the cost. Click to take it off your list" : `I have this: adds "${r.haveAs}" to Settings → Making → Parts you have`}
      onClick={() => updateSettings({ onHand: cleanOnHand(mine >= 0 ? have.filter((_, i) => i !== mine) : [...have, r.haveAs!]) })}
    >
      {r.onHand ? "on hand ✓" : "I have it"}
    </button>
  );
}

export function BomTable() {
  const model = useDesign((s) => s.model);
  const meshVersion = useDesign((s) => s.meshVersion);
  const have = useSettings((s) => s.onHand);
  const rows = useMemo(() => (model ? bomRows(model, have) : []), [model, have]);
  const cost = useMemo(() => bomTotal(rows), [rows]);
  const totals = useMemo(() => {
    if (!model) return { mass: 0, printed: 0 };
    let mass = 0;
    let printed = 0;
    for (const p of model.parts) {
      const v = meshes.get(p.hash)?.volume ?? 0;
      const g = (v / 1000) * materialDensity(p.material);
      mass += g;
      if (p.kind === "part" && isPrinted(p.material)) printed += g;
    }
    return { mass, printed };
    // meshVersion: volumes arrive with meshes
  }, [model, meshVersion]);
  // what the material for each made part costs, from the material database (not print or machine time)
  const stock = useMemo(() => {
    const out = new Map<string, { each: number; note: string }>();
    if (!model) return out;
    for (const r of rows) {
      if (r.kind !== "Make" || out.has(r.item)) continue;
      const c = partMaterialCost(model, r.item);
      if (c && c.cost > 0) out.set(r.item, { each: c.cost / c.count, note: `${c.material} ${c.form === "stock" ? "bar or plate stock" : c.form} at ${money(c.perKg)}/kg. Material only, not print or machine time` });
    }
    return out;
    // meshVersion: volumes arrive with meshes
  }, [model, rows, meshVersion]);
  if (!model) return null;
  const priced = rows.some((r) => r.price !== undefined);
  const stockTotal = rows.reduce((t, r) => t + (r.kind === "Make" ? (stock.get(r.item)?.each ?? 0) * r.qty : 0), 0);
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "auto" }}>
      <div className="row" style={{ padding: "8px 12px", borderBottom: "1px solid var(--line)" }}>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {rows.length} line items · {fmtNum(totals.mass, 0)} g total · {fmtNum(totals.printed, 0)} g printed
          {priced && ` · about ${money(cost.total)} to buy`}
          {stockTotal > 0 && ` · about ${money(stockTotal)} of material for made parts`}
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
              <th style={{ textAlign: "right" }}>Price</th>
              <th>Where to buy</th>
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
                <td className="bom-price" data-tip={r.priceNote}>
                  {r.onHand ? (
                    <span className="dim" style={{ textDecoration: "line-through" }}>
                      {r.price !== undefined ? money(r.price * r.qty) : ""}
                    </span>
                  ) : r.price !== undefined ? (
                    <>
                      {money(r.price * r.qty)}
                      {r.qty > 1 && (
                        <div className="dim">
                          {r.qty} × {money(r.price)}
                        </div>
                      )}
                    </>
                  ) : r.kind === "Buy" ? (
                    <span className="dim">no price</span>
                  ) : stock.has(r.item) ? (
                    <span className="dim" data-tip={stock.get(r.item)!.note}>
                      {money(stock.get(r.item)!.each * r.qty)} material
                    </span>
                  ) : null}
                </td>
                <td>
                  <HaveToggle r={r} have={have} />
                  {!r.onHand && <WhereToBuy r={r} />}
                </td>
              </tr>
            ))}
          </tbody>
          {priced && (
            <tfoot>
              <tr className="bom-total">
                <td colSpan={6}>
                  Total for bought parts
                  {cost.saved > 0 && <span className="dim"> (less {money(cost.saved)} you have on hand)</span>}
                  {cost.unpriced > 0 && (
                    <span className="dim">
                      {" "}
                      ({cost.unpriced} {cost.unpriced === 1 ? "item has" : "items have"} no price)
                    </span>
                  )}
                </td>
                <td className="bom-price">{money(cost.total)}</td>
                <td className="dim" style={{ fontSize: 11 }}>
                  Typical prices, for budgeting
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      ) : (
        <div className="empty-state" style={{ margin: 16 }}>
          No parts yet.
        </div>
      )}
      <FrameCuts model={model} />
    </div>
  );
}
