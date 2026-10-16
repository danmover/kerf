// Icons for the brief, references and sketches. Kept apart from icons.tsx so
// other work on the shared icon set does not collide with these.

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const BIcon = {
  Brief: (p: P) => (
    <I {...p}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4V3h6v1" />
      <path d="M8.5 10h7M8.5 13.5h7M8.5 17h4" />
    </I>
  ),
  Clip: (p: P) => (
    <I {...p}>
      <path d="m20 11.5-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.4 3.4 0 0 1 4.8 4.8l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9" />
    </I>
  ),
  Image: (p: P) => (
    <I {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.8" />
      <path d="m21 16-5-5-9 9" />
    </I>
  ),
  Pen: (p: P) => (
    <I {...p}>
      <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </I>
  ),
  Pdf: (p: P) => (
    <I {...p}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 13h7M8.5 16.5h5" />
    </I>
  ),
  Link: (p: P) => (
    <I {...p}>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1" />
      <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />
    </I>
  ),
  Thermo: (p: P) => (
    <I {...p}>
      <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" />
      <path d="M12 9v7" />
    </I>
  ),
  Hammer: (p: P) => (
    <I {...p}>
      <path d="m14 7-9.5 9.5a2.1 2.1 0 0 0 3 3L17 10" />
      <path d="m12 5 3-2 6 6-2 3z" />
    </I>
  ),
  Ruler: (p: P) => (
    <I {...p}>
      <path d="m3 16 13-13 5 5L8 21z" />
      <path d="m7 12 2 2M10 9l1.5 1.5M13 6l2 2" />
    </I>
  ),
  Flag: (p: P) => (
    <I {...p}>
      <path d="M5 21V4" />
      <path d="M5 4h11l-2 4 2 4H5" />
    </I>
  ),
  Pin: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3" />
    </I>
  ),
  Note: (p: P) => (
    <I {...p}>
      <path d="M5 4h14v11l-5 5H5z" />
      <path d="M14 20v-5h5" />
    </I>
  ),
  Line: (p: P) => (
    <I {...p}>
      <path d="M5 19 19 5" />
    </I>
  ),
  Rect: (p: P) => (
    <I {...p}>
      <rect x="4" y="6" width="16" height="12" rx="1" />
    </I>
  ),
  Circle: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="8" />
    </I>
  ),
  Text: (p: P) => (
    <I {...p}>
      <path d="M5 6V4h14v2M12 4v16M9 20h6" />
    </I>
  ),
  Eraser: (p: P) => (
    <I {...p}>
      <path d="m7 21-4-4L14 6l6 6-9 9z" />
      <path d="M7 21h13M9.5 10.5l6 6" />
    </I>
  ),
  Arrow: (p: P) => (
    <I {...p}>
      <path d="M5 19 19 5M10 5h9v9" />
    </I>
  ),
};
