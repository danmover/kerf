// A microSD card at the end of a simulation run: the files the firmware left on it, with the text of each one
// that is text, as a computer would show them once the card is taken out.

import type { SdCardRun } from "../../sim/engine/peripherals";

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

export function SdCardView({ card }: { card: SdCardRun }) {
  const files = card.files.filter((f) => !f.path.endsWith("/"));
  return (
    <div className="sim-screen">
      <div className="sim-h">
        {card.name}
        <span className="grow" />
        <span className="mono" style={{ fontSize: 10, color: "var(--text-4)", textTransform: "none", letterSpacing: 0 }}>
          microSD {card.gb} GB {card.format} · {card.blocksWritten} blocks written
        </span>
      </div>
      {!card.files.length && <div style={{ fontSize: 12, color: "var(--text-3)", padding: "4px 0" }}>The card is empty at the end of the run.</div>}
      {card.files
        .filter((f) => f.path.endsWith("/"))
        .map((f) => (
          <div key={f.path} className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
            {f.path}
          </div>
        ))}
      {files.map((f) => (
        <details key={f.path} style={{ fontSize: 12 }}>
          <summary className="mono" style={{ cursor: f.text === undefined ? "default" : "pointer" }}>
            {f.path} <span style={{ color: "var(--text-4)" }}>{size(f.bytes)}</span>
          </summary>
          {f.text !== undefined ? (
            <pre className="mono" style={{ maxHeight: 160, overflow: "auto", fontSize: 11, margin: "4px 0", whiteSpace: "pre-wrap" }}>
              {f.text}
              {f.bytes > 4096 ? `\n… ${size(f.bytes - 4096)} more` : ""}
            </pre>
          ) : (
            <div style={{ color: "var(--text-4)", fontSize: 11 }}>Binary data</div>
          )}
        </details>
      ))}
    </div>
  );
}
