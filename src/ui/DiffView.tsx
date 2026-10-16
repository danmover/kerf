// A line diff of two versions of the source.

import { useMemo } from "react";
import { lineDiff } from "../core/sourceEdit";

export function DiffView({ before, after }: { before: string; after: string }) {
  const lines = useMemo(() => lineDiff(before, after, 2), [before, after]);
  return (
    <div className="diff">
      {lines.map((l, i) => (
        <div key={i} className={`ln ${l.kind}`}>
          <span className="n">{l.b ?? l.a ?? ""}</span>
          <span>{l.kind === "add" ? "+" : l.kind === "del" ? "−" : " "}</span>
          <span>{l.text}</span>
        </div>
      ))}
    </div>
  );
}
