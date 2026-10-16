// Small pieces shared by the left panel tabs.

import { Fragment } from "react";

/** Text with the filter match marked. */
export function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="lp-mark">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

type Tok = [kind: "kw" | "id" | "fn" | "num" | "str" | "sp" | "cm", text: string] | ["nl"];

/** A few lines of highlighted Kerf code, for empty states. */
export function CodeSample({ lines }: { lines: Tok[] }) {
  return (
    <pre className="lp-code" aria-hidden="true">
      {lines.map((t, i) => (t[0] === "nl" ? <br key={i} /> : <Fragment key={i}>{t[0] === "sp" ? t[1] : <span className={`tk-${t[0]}`}>{t[1]}</span>}</Fragment>))}
    </pre>
  );
}
