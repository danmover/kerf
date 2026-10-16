// Stroke icons for the sketch tools (kept here so the shared icon set stays untouched).

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const T = {
  Pencil: (p: P) => (
    <I {...p}>
      <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
      <path d="M14 6l3 3" />
    </I>
  ),
  Pointer: (p: P) => (
    <I {...p}>
      <path d="M5 3l14 8-6 1.5L10 19z" />
    </I>
  ),
  Line: (p: P) => (
    <I {...p}>
      <path d="M5 19L19 5" />
      <circle cx="5" cy="19" r="1.6" fill="currentColor" />
      <circle cx="19" cy="5" r="1.6" fill="currentColor" />
    </I>
  ),
  Rect: (p: P) => (
    <I {...p}>
      <rect x="4" y="6" width="16" height="12" rx="0.5" />
    </I>
  ),
  Circle: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </I>
  ),
  Arc: (p: P) => (
    <I {...p}>
      <path d="M4 18a8 8 0 0 1 16 0" />
      <circle cx="4" cy="18" r="1.4" fill="currentColor" />
      <circle cx="20" cy="18" r="1.4" fill="currentColor" />
    </I>
  ),
  Slot: (p: P) => (
    <I {...p}>
      <rect x="3" y="8" width="18" height="8" rx="4" />
    </I>
  ),
  Point: (p: P) => (
    <I {...p}>
      <path d="M12 4v4M12 16v4M4 12h4M16 12h4" />
      <circle cx="12" cy="12" r="1.8" fill="currentColor" />
    </I>
  ),
  Dim: (p: P) => (
    <I {...p}>
      <path d="M4 7v10M20 7v10M4 12h16" />
      <path d="M7 9.5L4 12l3 2.5M17 9.5l3 2.5-3 2.5" />
    </I>
  ),
  Construction: (p: P) => (
    <I {...p}>
      <path d="M4 20L20 4" strokeDasharray="3 3" />
      <circle cx="12" cy="12" r="2.2" />
    </I>
  ),
  Normal: (p: P) => (
    <I {...p}>
      <rect x="5" y="5" width="14" height="14" rx="1" />
      <circle cx="12" cy="12" r="2" />
    </I>
  ),
};
