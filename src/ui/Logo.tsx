// The Kerf mark: a block with a saw cut through it. The cut draws itself in.

import { motion } from "framer-motion";

export function LogoMark({ size = 26, animate = true }: { size?: number; animate?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="kerf-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8fa8ff" />
          <stop offset="1" stopColor="#c792ff" />
        </linearGradient>
      </defs>
      <motion.path
        d="M6 9 16 4l10 5v14l-10 5-10-5z"
        fill="rgba(109,139,255,0.10)"
        stroke="url(#kerf-g)"
        strokeWidth={1.6}
        strokeLinejoin="round"
        initial={animate ? { pathLength: 0, opacity: 0.4 } : false}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
      <motion.path d="M6 9l10 5 10-5M16 14v14" fill="none" stroke="url(#kerf-g)" strokeWidth={1.2} strokeOpacity={0.55} initial={animate ? { pathLength: 0 } : false} animate={{ pathLength: 1 }} transition={{ duration: 0.8, delay: 0.3 }} />
      <motion.path
        d="M9.5 24.5 22.5 7.5"
        stroke="#ffcb6b"
        strokeWidth={2}
        strokeLinecap="round"
        initial={animate ? { pathLength: 0 } : false}
        animate={{ pathLength: 1 }}
        transition={{ duration: 0.5, delay: 0.75, ease: "easeInOut" }}
      />
    </svg>
  );
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <div className="row" style={{ gap: 9 }}>
      <LogoMark size={size} />
      <span className="logo-word">
        kerf<span className="slash">/</span>
      </span>
    </div>
  );
}
