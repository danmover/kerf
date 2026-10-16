// The Kerf mark: a block sawn in two. On first show the block rises, a laser
// runs down the cut and the halves part, leaving the sawn face glowing in the
// kerf. Hovering pulls the halves further apart; `busy` makes the cut pulse
// while the design rebuilds, and `idle` (the home page) lets the blade pass
// again now and then. All motion is CSS (styles/brand.css), so it
// stays smooth while the kernel keeps the main thread busy.

import { useId, type CSSProperties } from "react";
import { MARK, MARK_COLORS } from "./logoGeometry";

export function LogoMark({ size = 26, animate = true, busy = false, idle = false }: { size?: number; animate?: boolean; busy?: boolean; idle?: boolean }) {
  const uid = "km" + useId().replace(/[^A-Za-z0-9]/g, "");
  const url = (n: string) => `url(#${uid}-${n})`;
  const C = MARK_COLORS;
  // small marks need a wider kerf to read
  const split = size <= 20 ? 0.1 : size <= 28 ? 0.08 : 0.06;
  return (
    <svg className={`kerf-mark ${animate ? "intro" : ""} ${busy ? "busy" : ""} ${idle ? "idle" : ""}`} width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" style={{ "--split": split } as CSSProperties}>
      <defs>
        <linearGradient id={`${uid}-top`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={C.top[0]} />
          <stop offset="1" stopColor={C.top[1]} />
        </linearGradient>
        <linearGradient id={`${uid}-left`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={C.left[0]} />
          <stop offset="1" stopColor={C.left[1]} />
        </linearGradient>
        <linearGradient id={`${uid}-front`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={C.front[0]} />
          <stop offset="1" stopColor={C.front[1]} />
        </linearGradient>
        <linearGradient id={`${uid}-hot`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={C.hot[0]} />
          <stop offset="0.5" stopColor={C.hot[1]} />
          <stop offset="1" stopColor={C.hot[2]} />
        </linearGradient>
        <filter id={`${uid}-glow`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.6" />
        </filter>
      </defs>
      <g className="km-body">
        <g className="km-b">
          <polygon className="km-cut km-glow" points={MARK.b.cut} fill={url("hot")} filter={url("glow")} />
          <polygon className="km-cut" points={MARK.b.cut} fill={url("hot")} />
          <polygon points={MARK.b.top} fill={url("top")} />
          <polygon points={MARK.b.front} fill={url("front")} />
          <path className="km-rim" d={MARK.rimB} />
        </g>
        <g className="km-a">
          <polygon points={MARK.a.left} fill={url("left")} />
          <polygon points={MARK.a.top} fill={url("top")} />
          <polygon points={MARK.a.front} fill={url("front")} />
          <path className="km-rim" d={MARK.rimA} />
        </g>
      </g>
      <path className="km-laser km-laser-glow" d={MARK.laser} pathLength={1} filter={url("glow")} />
      <path className="km-laser" d={MARK.laser} pathLength={1} />
    </svg>
  );
}

export function Logo({ size = 24, busy = false, animate = true }: { size?: number; busy?: boolean; animate?: boolean }) {
  return (
    <span className="kerf-logo">
      <LogoMark size={size} busy={busy} animate={animate} />
      <span className={`logo-word ${animate ? "intro" : ""}`} style={{ fontSize: Math.round(size * 0.62) }}>
        kerf<span className="slash">/</span>
      </span>
    </span>
  );
}
