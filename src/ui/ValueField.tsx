// A compact value editor for option and parameter values: type a number,
// nudge it with the arrow keys, or drag the name sideways to scrub it.

import { useEffect, useRef, useState } from "react";
import { fmtNum } from "../lang/values";

type V = number | string | boolean;

export function stepFor(v: number): number {
  const a = Math.abs(v);
  return a >= 100 ? 1 : a >= 10 ? 0.5 : 0.1;
}

const tidy = (n: number) => Math.round(n * 1000) / 1000;

export function ValueField({
  name,
  value,
  from,
  unit,
  disabled,
  onLive,
  onCommit,
  accent,
}: {
  /** shown before the value; dragging it scrubs a number */
  name?: string;
  value: V;
  /** the value before this change, shown as "from →" */
  from?: V;
  unit?: string;
  disabled?: boolean;
  /** called continuously while scrubbing */
  onLive?: (v: V) => void;
  /** called once the value settles */
  onCommit: (v: V) => void;
  /** highlight the value (it differs from what was proposed) */
  accent?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [scrub, setScrub] = useState<number | null>(null);
  const drag = useRef<{ x: number; start: number; last: number; moved: boolean } | null>(null);
  const raf = useRef(0);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const isNum = typeof value === "number";
  const shown = scrub ?? value;

  const commitText = (text: string) => {
    if (typeof value === "number") {
      const n = Number(text.replace(/[a-z°%\s]+$/i, ""));
      if (Number.isFinite(n) && n !== value) onCommit(tidy(n));
    } else if (typeof value === "string") {
      const t = text.replace(/^"|"$/g, "");
      if (t !== value) onCommit(t);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!isNum || disabled || e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, start: value as number, last: value as number, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) < 3) return;
    d.moved = true;
    const step = stepFor(d.start) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    const next = tidy(d.start + Math.round(dx / 6) * step);
    if (next === d.last) return;
    d.last = next;
    setScrub(next);
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => onLive?.(next));
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    setScrub(null);
    cancelAnimationFrame(raf.current);
    if (d?.moved && d.last !== d.start) onCommit(d.last);
  };

  return (
    <span className={`vf ${disabled ? "disabled" : ""} ${accent ? "accent" : ""}`}>
      {name && (
        <span
          className={`vf-name ${isNum && !disabled ? "scrub" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          data-tip={isNum && !disabled ? "Drag to adjust · Shift for bigger steps" : undefined}
        >
          {name}
        </span>
      )}
      {from !== undefined && <span className="vf-from">{fmt(from)} →</span>}
      {typeof value === "boolean" ? (
        <button type="button" className={`toggle sm ${value ? "on" : ""}`} disabled={disabled} onClick={() => onCommit(!value)} aria-label={name ?? "value"} />
      ) : (
        <input
          className="vf-input"
          value={draft ?? fmt(shown)}
          size={Math.max(3, (draft ?? fmt(shown)).length)}
          disabled={disabled}
          aria-label={name ? `${name} value` : "value"}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            if (draft !== null) commitText(draft);
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              e.stopPropagation();
              setDraft(null);
              requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
            } else if (isNum && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
              e.preventDefault();
              const step = stepFor(value as number) * (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
              setDraft(null);
              onCommit(tidy((value as number) + (e.key === "ArrowUp" ? step : -step)));
            }
          }}
        />
      )}
      {unit && <span className="vf-unit">{unit}</span>}
    </span>
  );
}

function fmt(v: V): string {
  return typeof v === "number" ? fmtNum(v, 3) : String(v);
}
