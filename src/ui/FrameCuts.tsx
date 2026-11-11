// The cut list for a design's frames (frame blocks), under the parts list:
// for each frame, the pieces to cut with their lengths and end cuts, the
// total stock and the bars to buy if you cut them yourself. Clicking a row
// selects those members in the 3D view. A frame of 2020/2040 whose joints
// nothing holds yet gets a button that puts corner brackets on them.

import type { FrameInfo, Model } from "../core/model";
import { select, revealSpan } from "../app/view";
import { fastenFrames, openJoints } from "../app/frameFasten";
import { useDesign } from "../core/engine";
import { csvEscape, download, safeFileName } from "../persist/files";
import { SAW_KERF } from "../lang/frames";
import { fmtNum } from "../lang/values";
import { Icon } from "./icons";

const endText = (ends: [string, string]) => (ends[0] === ends[1] ? `${ends[0]} both ends` : `${ends[0]}, ${ends[1]}`);

export function frameCutsCsv(frames: FrameInfo[]): string {
  const lines = [["Frame", "Stock", "Qty", "Cut length (mm)", "Ends", "Members", "Stock length (mm)", "Bars to buy"].join(",")];
  for (const f of frames)
    f.cuts.forEach((c, i) => lines.push([f.label, f.section, c.qty, c.length, endText(c.ends), c.members.join(" "), i === 0 ? f.stock.length : "", i === 0 ? f.stock.bars : ""].map(csvEscape).join(",")));
  return lines.join("\n") + "\n";
}

export function FrameCuts({ model }: { model: Model }) {
  const report = useDesign((s) => s.report);
  const frames = model.frames ?? [];
  if (!frames.length) return null;
  return (
    <div className="frame-cuts">
      <div className="row" style={{ padding: "10px 12px 6px" }}>
        <span className="frame-cuts-h">Cut list</span>
        <span className="mono dim" style={{ fontSize: 11 }}>
          {frames.length === 1 ? "one frame" : `${frames.length} frames`} · {fmtNum(frames.reduce((t, f) => t + f.total, 0) / 1000, 2)} m of stock · {SAW_KERF} mm allowed per saw cut
        </span>
        <div className="grow" />
        <button className="btn sm" onClick={() => download(frameCutsCsv(frames), safeFileName(model.name + " cut list", "csv"), "text/csv")}>
          <Icon.Download size={13} /> CSV
        </button>
      </div>
      {frames.map((f) => (
        <div key={f.name} className="frame-cut">
          <div className="row" style={{ paddingRight: 12 }}>
            <button className="frame-cut-title" onClick={() => revealSpan(f.span)} data-tip="Show the frame block in the design file">
              <b>{f.label}</b> <span className="dim">{f.section}</span>
              {f.ends === "miter" && <span className="chip">mitred</span>}
            </button>
            <div className="grow" />
            {f.catalogId && openJoints(report, model, f.name) > 0 && (
              <button className="btn sm" onClick={() => fastenFrames([f.name])} data-tip="Corner brackets (or joining plates where a bracket has no room) with screws into T-nuts at every joint nothing holds yet, as one change you can undo">
                <Icon.Screw size={13} /> Fasten {openJoints(report, model, f.name)} joints
              </button>
            )}
          </div>
          <div className="dim" style={{ fontSize: 11, padding: "0 12px 6px" }}>
            {f.members.length} pieces, {fmtNum(f.total / 1000, 2)} m in all: {f.stock.bars} {f.stock.bars === 1 ? "bar" : "bars"} of {fmtNum(f.stock.length, 0)} mm if you cut them yourself · about {fmtNum(f.mass / 1000, 2)} kg
          </div>
          <table className="bom">
            <thead>
              <tr>
                <th>Qty</th>
                <th>Length</th>
                <th>Ends</th>
                <th>Members</th>
              </tr>
            </thead>
            <tbody>
              {f.cuts.map((c, i) => (
                <tr key={i} className="frame-cut-row" onClick={() => select(c.members)} data-tip="Select these in the 3D view">
                  <td className="qty">{c.qty}</td>
                  <td className="mono">{fmtNum(c.length, 1)} mm</td>
                  <td>{endText(c.ends)}</td>
                  <td className="mono dim" style={{ fontSize: 11 }}>
                    {c.members.join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
