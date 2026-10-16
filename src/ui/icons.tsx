// Inline stroke icons (no icon font, no network requests).

import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 16, children, ...rest }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const Icon = {
  Undo: (p: P) => (
    <I {...p}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </I>
  ),
  Redo: (p: P) => (
    <I {...p}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </I>
  ),
  Settings: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </I>
  ),
  Download: (p: P) => (
    <I {...p}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </I>
  ),
  Upload: (p: P) => (
    <I {...p}>
      <path d="M12 21V9" />
      <path d="m7 14 5-5 5 5" />
      <path d="M5 3h14" />
    </I>
  ),
  Plus: (p: P) => (
    <I {...p}>
      <path d="M12 5v14M5 12h14" />
    </I>
  ),
  X: (p: P) => (
    <I {...p}>
      <path d="M18 6 6 18M6 6l12 12" />
    </I>
  ),
  Check: (p: P) => (
    <I {...p}>
      <path d="m5 12 5 5L20 7" />
    </I>
  ),
  Eye: (p: P) => (
    <I {...p}>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </I>
  ),
  EyeOff: (p: P) => (
    <I {...p}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.8 17.8 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </I>
  ),
  Lock: (p: P) => (
    <I {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </I>
  ),
  Unlock: (p: P) => (
    <I {...p}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 7.6-1.7" />
    </I>
  ),
  Cube: (p: P) => (
    <I {...p}>
      <path d="M12 2 3 7v10l9 5 9-5V7z" />
      <path d="m3 7 9 5 9-5M12 12v10" />
    </I>
  ),
  Box: (p: P) => (
    <I {...p}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </I>
  ),
  Gear: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1" />
    </I>
  ),
  Screw: (p: P) => (
    <I {...p}>
      <path d="M8 3h8v4H8z" />
      <path d="M10 7v12l2 2 2-2V7" />
      <path d="M10 11h4M10 15h4" />
    </I>
  ),
  Chip: (p: P) => (
    <I {...p}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
      <path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" />
    </I>
  ),
  Sliders: (p: P) => (
    <I {...p}>
      <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
    </I>
  ),
  Layers: (p: P) => (
    <I {...p}>
      <path d="m12 2 10 5-10 5L2 7z" />
      <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
    </I>
  ),
  History: (p: P) => (
    <I {...p}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5M12 7v5l3 3" />
    </I>
  ),
  Code: (p: P) => (
    <I {...p}>
      <path d="m16 18 6-6-6-6M8 6l-6 6 6 6" />
    </I>
  ),
  Shield: (p: P) => (
    <I {...p}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <path d="m9 12 2 2 4-4" />
    </I>
  ),
  Graph: (p: P) => (
    <I {...p}>
      <circle cx="5" cy="6" r="2" />
      <circle cx="5" cy="18" r="2" />
      <circle cx="19" cy="12" r="2" />
      <path d="M7 6.5 17 11M7 17.5 17 13" />
    </I>
  ),
  List: (p: P) => (
    <I {...p}>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </I>
  ),
  Send: (p: P) => (
    <I {...p}>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </I>
  ),
  Stop: (p: P) => (
    <I {...p}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </I>
  ),
  Mic: (p: P) => (
    <I {...p}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </I>
  ),
  MicOff: (p: P) => (
    <I {...p}>
      <path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5" />
      <path d="M18.5 11a6.5 6.5 0 0 1-1 3.4M5.5 11a6.5 6.5 0 0 0 10.2 5.4M12 17.5V21M8.5 21h7M3 3l18 18" />
    </I>
  ),
  Sparkle: (p: P) => (
    <I {...p}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.5 2.5M15.2 15.2l2.5 2.5M6.3 17.7l2.5-2.5M15.2 8.8l2.5-2.5" />
    </I>
  ),
  Play: (p: P) => (
    <I {...p}>
      <path d="M7 4v16l13-8z" fill="currentColor" stroke="none" />
    </I>
  ),
  Pause: (p: P) => (
    <I {...p}>
      <path d="M7 4h3v16H7zM14 4h3v16h-3z" fill="currentColor" stroke="none" />
    </I>
  ),
  Scissors: (p: P) => (
    <I {...p}>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12" />
    </I>
  ),
  Explode: (p: P) => (
    <I {...p}>
      <rect x="9" y="9" width="6" height="6" rx="1" />
      <path d="M4 4l3 3M20 4l-3 3M4 20l3-3M20 20l-3-3" />
    </I>
  ),
  Xray: (p: P) => (
    <I {...p}>
      <path d="M12 2 3 7v10l9 5 9-5V7z" strokeDasharray="3 2.5" />
      <circle cx="12" cy="12" r="2.5" />
    </I>
  ),
  Target: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </I>
  ),
  Grid: (p: P) => (
    <I {...p}>
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </I>
  ),
  More: (p: P) => (
    <I {...p}>
      <circle cx="5" cy="12" r="1.2" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
      <circle cx="19" cy="12" r="1.2" fill="currentColor" />
    </I>
  ),
  Chevron: (p: P) => (
    <I {...p}>
      <path d="m9 6 6 6-6 6" />
    </I>
  ),
  ChevronDown: (p: P) => (
    <I {...p}>
      <path d="m6 9 6 6 6-6" />
    </I>
  ),
  Key: (p: P) => (
    <I {...p}>
      <circle cx="8" cy="15" r="4" />
      <path d="m10.8 12.2 9.2-9.2M17 6l3 3M15 8l2 2" />
    </I>
  ),
  Alert: (p: P) => (
    <I {...p}>
      <path d="M12 3 2 21h20z" />
      <path d="M12 10v5M12 18h.01" />
    </I>
  ),
  Info: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </I>
  ),
  Trash: (p: P) => (
    <I {...p}>
      <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
    </I>
  ),
  Copy: (p: P) => (
    <I {...p}>
      <rect x="8" y="8" width="13" height="13" rx="2" />
      <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
    </I>
  ),
  Edit: (p: P) => (
    <I {...p}>
      <path d="M4 20h4L19 9l-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </I>
  ),
  Home: (p: P) => (
    <I {...p}>
      <path d="m3 11 9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </I>
  ),
  Doc: (p: P) => (
    <I {...p}>
      <path d="M14 3H6v18h12V7z" />
      <path d="M14 3v4h4M9 13h6M9 17h6" />
    </I>
  ),
  Keyboard: (p: P) => (
    <I {...p}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </I>
  ),
  Fit: (p: P) => (
    <I {...p}>
      <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    </I>
  ),
  Refresh: (p: P) => (
    <I {...p}>
      <path d="M20 11a8 8 0 1 0-2.3 5.7" />
      <path d="M20 4v7h-7" />
    </I>
  ),
  Sun: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </I>
  ),
  Material: (p: P) => (
    <I {...p}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M7.5 9.5a5 5 0 0 1 4-3" />
      <path d="M4 14.5c3 2 13 2 16 0" strokeOpacity={0.55} />
    </I>
  ),
  Orbit: (p: P) => (
    <I {...p}>
      <ellipse cx="12" cy="12" rx="9.5" ry="4" />
      <path d="m17.5 6.8 2.2 1.5-1.4 2.3" />
      <rect x="9.5" y="7" width="5" height="9" rx="1" />
    </I>
  ),
  Assemble: (p: P) => (
    <I {...p}>
      <rect x="8" y="12" width="8" height="8" rx="1" />
      <path d="M12 2v6M9 5l3 3 3-3" />
      <path d="M3 8h3M18 8h3" strokeOpacity={0.6} />
    </I>
  ),
  Fork: (p: P) => (
    <I {...p}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="6" r="2" />
      <path d="M6 7v10M18 8c0 5-7 4-11 9.5" />
    </I>
  ),
  PanelLeft: (p: P) => (
    <I {...p}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M9 4v16" />
    </I>
  ),
  Compare: (p: P) => (
    <I {...p}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M12 3v18" />
    </I>
  ),
  Pin: (p: P) => (
    <I {...p}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.3" />
    </I>
  ),
  Chat: (p: P) => (
    <I {...p}>
      <path d="M6 18l-3 3V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2z" />
    </I>
  ),
  Wrench: (p: P) => (
    <I {...p}>
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" />
    </I>
  ),
  /** a lab flask: a simulated test */
  Flask: (p: P) => (
    <I {...p}>
      <path d="M9 3h6" />
      <path d="M10 3v6.2L4.6 18.4A1.7 1.7 0 0 0 6.1 21h11.8a1.7 1.7 0 0 0 1.5-2.6L14 9.2V3" />
      <path d="M7.2 15h9.6" />
    </I>
  ),
  /** a beam fixed at a wall, bending under a load */
  Stress: (p: P) => (
    <I {...p}>
      <path d="M3 4v16" />
      <path d="M3 10c6.5 0 12 1.2 17 4.6" />
      <path d="M3 14c6 0 10.5 1 14.5 3.6" />
      <path d="M19 3v6.5" />
      <path d="m16.8 7.4 2.2 2.2 2.2-2.2" />
    </I>
  ),
};

export function StatusIcon({ status }: { status: "pass" | "fail" | "warn" | "pending" | "info" }) {
  const color = status === "pass" ? "var(--pass)" : status === "fail" ? "var(--fail)" : status === "warn" ? "var(--warn)" : status === "info" ? "var(--info)" : "var(--accent)";
  return (
    <svg className="status-icon" viewBox="0 0 16 16" aria-label={status}>
      <circle cx="8" cy="8" r="7" fill="none" stroke={color} strokeOpacity={0.35} />
      {status === "pass" && <path d="m4.8 8.2 2.2 2.2 4.2-4.6" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />}
      {status === "fail" && <path d="m5.5 5.5 5 5m0-5-5 5" stroke={color} strokeWidth={1.8} strokeLinecap="round" />}
      {status === "warn" && <path d="M8 4.5v4.2M8 11h.01" stroke={color} strokeWidth={1.8} strokeLinecap="round" />}
      {status === "info" && <path d="M8 7.2v4M8 4.8h.01" stroke={color} strokeWidth={1.8} strokeLinecap="round" />}
      {status === "pending" && <circle cx="8" cy="8" r="2.5" fill={color} />}
    </svg>
  );
}
