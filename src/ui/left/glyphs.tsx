// Small stroke glyphs used only by the left panel (same style as ui/icons).

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 14, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const G = {
  Search: (p: P) => (
    <I {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </I>
  ),
  /** a length */
  Length: (p: P) => (
    <I {...p}>
      <path d="M3 8v8M21 8v8M3 12h18" />
      <path d="m6.5 9.5-3 2.5 3 2.5M17.5 9.5l3 2.5-3 2.5" />
    </I>
  ),
  /** an angle */
  Angle: (p: P) => (
    <I {...p}>
      <path d="M4 20h16M4 20 15 6" />
      <path d="M10.5 20a6.5 6.5 0 0 0-2.4-5" />
    </I>
  ),
  /** a count */
  Count: (p: P) => (
    <I {...p}>
      <path d="M9 4 7 20M17 4l-2 16M4 9h16M3 15h16" />
    </I>
  ),
  /** text or a choice from a list */
  Text: (p: P) => (
    <I {...p}>
      <path d="M5 7V5h14v2M12 5v14M9 19h6" />
    </I>
  ),
  /** true / false */
  Switch: (p: P) => (
    <I {...p}>
      <rect x="2.5" y="7" width="19" height="10" rx="5" />
      <circle cx="16.5" cy="12" r="2.5" />
    </I>
  ),
  /** a plain number */
  Number: (p: P) => (
    <I {...p}>
      <path d="M5 18V6l5 12V6M14 12h6M17 9v6" />
    </I>
  ),
  Spin: (p: P) => (
    <I {...p}>
      <path d="M20 12a8 8 0 1 1-2.3-5.7" />
      <path d="M20 4v4h-4" />
    </I>
  ),
  Arrow: (p: P) => (
    <I {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </I>
  ),
  Check: (p: P) => (
    <I {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </I>
  ),
  Cross: (p: P) => (
    <I {...p}>
      <path d="M7 7l10 10M17 7 7 17" />
    </I>
  ),
  Collapse: (p: P) => (
    <I {...p}>
      <path d="m7 15 5-5 5 5" />
      <path d="M5 20h14M5 4h14" />
    </I>
  ),
  Expand: (p: P) => (
    <I {...p}>
      <path d="m7 9 5 5 5-5" />
      <path d="M5 20h14M5 4h14" />
    </I>
  ),
  Restore: (p: P) => (
    <I {...p}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.5" />
      <path d="M4 4v4.5h4.5" />
    </I>
  ),
  Diff: (p: P) => (
    <I {...p}>
      <path d="M12 4v7M8.5 7.5h7M8.5 17h7" />
      <rect x="3.5" y="2.5" width="17" height="19" rx="3" />
    </I>
  ),
};
