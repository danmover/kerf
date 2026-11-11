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
  /** a constrained profile: an outline with its corner points (told apart from the markup pen) */
  Sketch: (p: P) => (
    <I {...p}>
      <path d="M5 18V7h8l6 6v5z" />
      <circle cx="5" cy="7" r="1.6" />
      <circle cx="13" cy="7" r="1.6" />
      <circle cx="19" cy="13" r="1.6" />
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
  /** a rectangle drawn out from its centre */
  RectCenter: (p: P) => (
    <I {...p}>
      <rect x="4" y="6" width="16" height="12" rx="0.5" />
      <path d="M4 6l16 12M20 6L4 18" strokeDasharray="2 2.5" strokeWidth={1.2} />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
    </I>
  ),
  /** a rectangle at any angle, from three corners */
  Rect3: (p: P) => (
    <I {...p}>
      <path d="M3 14l8-9 10 8-8 9z" />
      <circle cx="3" cy="14" r="1.4" fill="currentColor" />
      <circle cx="11" cy="5" r="1.4" fill="currentColor" />
      <circle cx="21" cy="13" r="1.4" fill="currentColor" />
    </I>
  ),
  Polygon: (p: P) => (
    <I {...p}>
      <path d="M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
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
  /** a line cut back where another crosses it */
  Trim: (p: P) => (
    <I {...p}>
      <path d="M3 12h9" />
      <path d="M12 12h9" strokeDasharray="2 2.6" opacity="0.55" />
      <path d="M12 4v16" />
    </I>
  ),
  /** a line run on to a wall */
  Extend: (p: P) => (
    <I {...p}>
      <path d="M3 12h7" />
      <path d="M10 12h9" strokeDasharray="2 2.6" />
      <path d="M19 4v16" />
      <path d="M15 9l3 3-3 3" />
    </I>
  ),
  /** an outline and a copy just outside it */
  Offset: (p: P) => (
    <I {...p}>
      <rect x="8" y="8" width="8" height="8" rx="1" />
      <rect x="4" y="4" width="16" height="16" rx="3" strokeDasharray="2.5 2.5" />
    </I>
  ),
  /** a shape and its mirror image across a dashed line */
  Mirror: (p: P) => (
    <I {...p}>
      <path d="M12 3v18" strokeDasharray="2 2.4" />
      <path d="M9 7L4 17h5z" />
      <path d="M15 7l5 10h-5z" opacity="0.6" />
    </I>
  ),
  /** the same hole repeated in a row */
  Pattern: (p: P) => (
    <I {...p}>
      <circle cx="5.5" cy="12" r="2.5" />
      <circle cx="12" cy="12" r="2.5" opacity="0.75" />
      <circle cx="18.5" cy="12" r="2.5" opacity="0.5" />
    </I>
  ),
  /** a face's outline dropped onto the sketch plane */
  Project: (p: P) => (
    <I {...p}>
      <path d="M7 4h10l3 4H4z" />
      <path d="M12 9v6" strokeDasharray="1.6 2" />
      <path d="M9.5 13l2.5 2.5 2.5-2.5" />
      <path d="M4 19h16" />
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
