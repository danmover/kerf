// Line drawings for the tutorial and feature sample cards on the home screen.

import { motion } from "framer-motion";

export const isLessonArt = (id: string) => id.startsWith("learn-") || id.startsWith("sample-");

export function LessonArt({ id }: { id: string }) {
  const accent = { stroke: "var(--accent)" };
  const line = { stroke: "var(--line-3)" };
  if (id.startsWith("learn-"))
    // a lesson card with its steps ticking off, beside what the lesson is about
    return (
      <svg viewBox="0 0 200 120" width="78%" height="78%">
        <TopicGlyph id={id} />
        <rect x="24" y="16" width="84" height="88" rx="8" style={{ ...line, fill: "rgb(var(--bg-2-rgb) / 0.6)" }} strokeWidth="1.2" />
        {[0, 1, 2, 3].map((i) => (
          <g key={i}>
            <motion.circle cx="38" cy={36 + i * 18} r="5" strokeWidth="1.3" style={accent} initial={{ fill: "rgb(var(--accent-rgb) / 0)" }} animate={{ fill: ["rgb(var(--accent-rgb) / 0)", "rgb(var(--accent-rgb) / 0.9)", "rgb(var(--accent-rgb) / 0.9)", "rgb(var(--accent-rgb) / 0)"] }} transition={{ duration: 5, times: [0.1 + i * 0.15, 0.18 + i * 0.15, 0.92, 1], repeat: Infinity }} />
            <path d={`M50 ${36 + i * 18}h${44 - (i % 2) * 14}`} style={line} strokeWidth="2" strokeLinecap="round" />
          </g>
        ))}
        <motion.path d="m0 0 0 13 3.5-3.4 2.4 5 2-1-2.3-4.8H10z" style={{ fill: "var(--text)", stroke: "var(--bg-2)" }} strokeWidth="0.8" animate={{ x: [150, 134, 150], y: [40, 72, 40] }} transition={{ duration: 3.6, repeat: Infinity, ease: "easeInOut" }} />
      </svg>
    );
  // the sample's design under a magnifier
  return (
    <svg viewBox="0 0 200 120" width="78%" height="78%">
      <SampleGlyph id={id} />
      <motion.g animate={{ x: [-26, 22, -26], y: [-6, 8, -6] }} transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}>
        <circle cx="100" cy="58" r="22" style={{ ...accent, fill: "rgb(var(--accent-rgb) / 0.1)" }} strokeWidth="1.6" />
        <path d="m116 74 14 14" style={accent} strokeWidth="4" strokeLinecap="round" />
        <path d="M90 58h20M100 48v20" style={accent} strokeWidth="1.2" strokeDasharray="2 2" />
      </motion.g>
    </svg>
  );
}

/** what each tutorial is about, beside its steps */
function TopicGlyph({ id }: { id: string }) {
  const accent = { stroke: "var(--accent)" };
  const line = { stroke: "var(--line-3)" };
  const tint = { ...accent, fill: "rgb(var(--accent-rgb) / 0.1)" };
  const mono = { fill: "var(--text-3)", fontFamily: "var(--mono, monospace)" };
  switch (id) {
    case "learn-first-part":
      // a plate with two holes
      return (
        <g strokeWidth="1.3">
          <path d="M120 84 150 70l32 14-30 14z" style={tint} />
          <path d="M120 84v6l32 14 30-14v-6M152 98v6" fill="none" style={line} />
          <ellipse cx="136" cy="83" rx="4" ry="2.2" fill="none" style={accent} />
          <ellipse cx="166" cy="85" rx="4" ry="2.2" fill="none" style={accent} />
        </g>
      );
    case "learn-sketch":
      // an outline with a size on it
      return (
        <g strokeWidth="1.3">
          <rect x="124" y="70" width="52" height="32" rx="2" fill="none" style={accent} strokeDasharray="5 3" />
          <path d="M124 60h52M124 56v8M176 56v8" style={line} />
          <text x="150" y="55" fontSize="8" textAnchor="middle" style={mono}>
            60
          </text>
          {[[124, 70], [176, 70], [176, 102], [124, 102]].map(([x, y]) => (
            <rect key={`${x},${y}`} x={x - 2.5} y={y - 2.5} width="5" height="5" style={{ fill: "var(--accent)" }} />
          ))}
        </g>
      );
    case "learn-strength":
      // the bracket in stress colours, bending under a load
      return (
        <g strokeWidth="1.2">
          <defs>
            <linearGradient id="learn-stress" x1="0" x2="1">
              <stop offset="0" stopColor="#ff4d5e" />
              <stop offset="0.4" stopColor="#ffd25e" />
              <stop offset="1" stopColor="#3b6cff" />
            </linearGradient>
          </defs>
          <path d="M126 58v50" style={line} strokeWidth="2" />
          <path d="M128 64h50v7h-43l-7 30z" fill="url(#learn-stress)" stroke="none" />
          <motion.path d="M172 44v12m-3-4 3 4 3-4" fill="none" style={{ stroke: "var(--warn)" }} strokeWidth="1.5" animate={{ y: [0, 4, 0] }} transition={{ duration: 2.4, repeat: Infinity }} />
        </g>
      );
    case "learn-make":
      // a drawing sheet with a part and its sizes
      return (
        <g strokeWidth="1.2">
          <rect x="122" y="56" width="58" height="52" rx="3" style={{ ...line, fill: "rgb(var(--bg-2-rgb) / 0.5)" }} />
          <rect x="132" y="68" width="26" height="18" fill="none" style={accent} />
          <path d="M132 62h26M132 59v6M158 59v6M164 68v18M161 68h6M161 86h6" style={line} />
          <path d="M162 96h14M162 100h10M162 104h12" style={line} />
        </g>
      );
    case "learn-scripts":
      // code, and the table it made
      return (
        <g>
          <text x="124" y="76" fontSize="22" style={{ ...mono, fill: "var(--accent)" }}>
            {"{ }"}
          </text>
          {[0, 1, 2].map((i) => (
            <path key={i} d={`M124 ${88 + i * 7}h52`} style={line} strokeWidth="1.2" strokeDasharray={i ? "14 4" : undefined} />
          ))}
        </g>
      );
    case "learn-claude":
      // a message and the change it made
      return (
        <g strokeWidth="1.3">
          <path d="M122 62a6 6 0 0 1 6-6h44a6 6 0 0 1 6 6v20a6 6 0 0 1-6 6h-30l-10 8v-8h-4a6 6 0 0 1-6-6z" style={tint} />
          <motion.path d="M150 64v14M143 71h14" style={accent} strokeLinecap="round" animate={{ rotate: [0, 90, 0] }} transition={{ duration: 4, repeat: Infinity }} />
          <path d="M132 100h40M132 106h28" style={line} />
        </g>
      );
    default:
      // the wall bracket
      return (
        <g strokeWidth="1.3">
          <path d="M126 56v52" style={line} strokeWidth="2" />
          <path d="M128 60h48v8h-40l-8 34z" style={tint} />
        </g>
      );
  }
}

/** each feature sample's design, drawn simply */
function SampleGlyph({ id }: { id: string }) {
  const line = { stroke: "var(--line-3)", fill: "none" };
  const accent = { stroke: "var(--accent)", fill: "none" };
  const tint = { stroke: "var(--line-3)", fill: "rgb(var(--accent-rgb) / 0.06)" };
  switch (id) {
    case "sample-weldment":
      return (
        <g strokeWidth="3" style={line} strokeLinecap="square">
          <path d="M44 40h112M44 40v62M156 40v62M50 86h100M100 40v46" />
        </g>
      );
    case "sample-cnc":
      return (
        <g strokeWidth="1.3">
          <rect x="44" y="30" width="112" height="64" rx="4" style={tint} />
          <path d="M56 42h88v8H56v8h88v8H56v8h88" style={{ ...accent, strokeOpacity: 0.55 }} />
          <circle cx="132" cy="62" r="9" style={line} />
        </g>
      );
    case "sample-nesting":
      return (
        <g strokeWidth="1.3">
          <rect x="40" y="26" width="120" height="72" style={line} />
          <rect x="48" y="34" width="44" height="26" rx="2" style={tint} />
          <rect x="48" y="66" width="44" height="24" rx="2" style={tint} />
          <path d="M100 34h52v56h-22V60h-30z" style={tint} />
        </g>
      );
    case "sample-sheet-metal":
      return (
        <g strokeWidth="1.3">
          <path d="M40 46 100 24l60 22v40l-60 24-60-24z" style={tint} />
          <path d="M40 46l60 22 60-22M100 68v42" style={line} />
          {[0, 1, 2, 3, 4].map((i) => (
            <path key={i} d={`M${112 + i * 8} ${70 - i * 3}v14`} style={line} strokeWidth="2.2" strokeLinecap="round" />
          ))}
        </g>
      );
    case "sample-split":
      return (
        <g strokeWidth="1.3">
          <rect x="26" y="46" width="148" height="30" rx="5" style={tint} />
          <path d="M75 40v42M125 40v42" style={accent} strokeDasharray="4 3" />
          <path d="M70 61h10M120 61h10" style={line} strokeWidth="3" />
        </g>
      );
    case "sample-shaking":
      return (
        <g strokeWidth="1.3">
          <path d="M66 98h68M80 98V56h48v8H88v34" style={tint} />
          <path d="M30 108q8-8 16 0t16 0 16 0 16 0 16 0 16 0 16 0 16 0 16 0" style={line} />
        </g>
      );
    case "sample-plies":
      return (
        <g strokeWidth="1.3">
          <path d="M84 12h32v100H84z" style={tint} />
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <path key={i} d={`M84 ${26 + i * 14}l32 -10`} style={line} />
          ))}
        </g>
      );
    case "sample-configurations":
      return (
        <g strokeWidth="1.3" style={tint}>
          <rect x="34" y="70" width="30" height="20" rx="3" />
          <rect x="76" y="60" width="40" height="30" rx="3" />
          <rect x="128" y="48" width="44" height="42" rx="3" />
        </g>
      );
    case "sample-mates":
      return (
        <g strokeWidth="1.3">
          <rect x="52" y="60" width="96" height="40" rx="4" style={tint} />
          <path d="M52 58 136 22l6 6-86 36z" style={tint} />
          <circle cx="54" cy="60" r="4" style={accent} />
        </g>
      );
    case "sample-fillets":
      return (
        <g strokeWidth="1.3">
          <path d="M30 96h140" style={line} />
          <path d="M60 96V44a10 10 0 0 1 20 0v52" style={tint} />
          <path d="M44 96q16 0 16-6M80 90q0 6 36 6" style={accent} />
        </g>
      );
    case "sample-own-features":
      return (
        <g strokeWidth="1.3">
          <rect x="40" y="30" width="120" height="64" rx="8" style={tint} />
          {[[56, 46], [144, 46], [56, 78], [144, 78]].map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r="7" style={accent} />
          ))}
        </g>
      );
    case "sample-topology":
      return (
        <g strokeWidth="1.3">
          <path d="M40 28v68M44 30q50 4 112 26l-4 8q-40-10-70-6-20 4-38 30" style={tint} />
          <path d="M44 56q30-12 56-4M60 74q20-14 46-12" style={line} />
        </g>
      );
    default:
      return (
        <g strokeWidth="1.2">
          <path d="M40 44 100 20l60 24v40l-60 24-60-24z" style={tint} />
          <path d="M40 44l60 24 60-24M100 68v40" style={line} />
        </g>
      );
  }
}
