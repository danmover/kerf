// The card for a picked cable, wherever it was picked: what it is and what
// it carries (current against what its wire is rated for), and for each end
// the part and pin, a close-up of the plug in its socket, the housing's
// contacts with pin 1 marked and what every contact carries, which way the
// plug goes in, what holds it and how it comes off, how to make the end, and
// the firmware pin at a controller. Then how to make the cable, what the
// wiring checks found on it, and buttons to light its whole circuit, fly the
// camera to it, open it in the wiring tab, ask Claude or show it in the code.

import { motion } from "framer-motion";
import { useState } from "react";
import type { CableDetails, Contact, EndDetails } from "../../machine/harness/details";
import { wireHex } from "../../machine/wiring";
import { Icon } from "../icons";
import { kindColor, KIND_NAME } from "./colours";

export interface CableCardProps {
  d: CableDetails;
  /** what the wiring checks found on it, a line each */
  issues: string[];
  /** the drag chains and loops it runs through */
  flex: string[];
  note?: string;
  /** a close-up of each end's plug in its socket (a data URL), "wait" while it is drawn, null when there is none */
  shots: [string | null, string | null];
  /** the end picked, to open first */
  end: 0 | 1 | null;
  traced: boolean;
  /** the card is in the wiring tab (no button to open it) */
  inTab: boolean;
  onClose: () => void;
  onTrace: () => void;
  onFly: () => void;
  onTab: () => void;
  onAsk: () => void;
  onCode?: () => void;
}

export function CableCard(p: CableCardProps) {
  const { d } = p;
  const colours = [...new Set(d.wires.map((w) => w.color))];
  return (
    <motion.div
      className="vp-float wr-card cc"
      initial={{ opacity: 0, x: 14, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: 14, scale: 0.98 }}
      transition={{ type: "spring", stiffness: 420, damping: 36 }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="cc-head">
        <span className="wr-swatches" aria-hidden>
          {colours.map((c) => (
            <span key={c} style={{ background: c }} />
          ))}
        </span>
        <div className="cc-title">
          <div className="wr-title">
            <span className="mono">{d.id}</span> {d.title}
          </div>
          <div className="cc-sub">
            <span className="cc-kind" style={{ ["--k" as string]: kindColor(d.kind) }}>
              {KIND_NAME[d.kind]}
            </span>
            <span>{d.signal}</span>
          </div>
        </div>
        <button className="icon-btn sm" onClick={p.onClose} aria-label="Close">
          <Icon.X size={14} />
        </button>
      </div>
      <div className="cc-body">
        <Load d={d} />
        {d.ends.map((e, k) => (
          <End key={k} e={e} k={k as 0 | 1} shot={p.shots[k]} open={p.end === null ? true : p.end === k} />
        ))}
        <div className="cc-sec">
          <div className="cc-label">Cable</div>
          <div className="cc-facts">
            {d.lead ? (
              <div>
                runs in {d.lead}
                {d.run !== undefined && <span className="dim"> · has to cover {Math.round(d.run)} mm</span>}
              </div>
            ) : (
              <div>
                {d.gauge !== undefined && (
                  <>
                    {d.gauge} AWG
                    {d.insulation === "silicone" ? " silicone" : ""}
                    {d.gaugeSuggested && <span className="dim"> (suggested)</span>}
                    {" · "}
                  </>
                )}
                {d.wires.length > 1 ? d.wires.map((w) => w.name).join(", ") : d.color}
              </div>
            )}
            {d.cut !== undefined && !d.lead && (
              <div>
                cut <b>{d.cut} mm</b>
                <span className="dim">{d.run !== undefined ? ` · runs ${Math.round(d.run)} mm plug to plug` : d.estimated ? " · estimated from the parts" : ""}</span>
              </div>
            )}
            <div>
              net <span className="mono">{d.net}</span>
              {d.ties > 0 && <span className="dim"> · tied down at {d.ties === 1 ? "1 point" : `${d.ties} points`}</span>}
            </div>
            {p.flex.length > 0 && <div>moves through the {p.flex.join(" and ")}</div>}
          </div>
          {p.note && <div className="wr-note">{p.note}</div>}
        </div>
        <Steps steps={d.steps} />
        {p.issues.length > 0 && (
          <div className="cc-issues">
            {p.issues.map((t) => (
              <div key={t} className="wr-check warn">
                <Icon.Alert size={12} /> {t}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="cc-actions">
        <button className={`btn sm${p.traced ? " on" : ""}`} onClick={p.onTrace} data-tip="Light up every cable on this circuit, from the supply to ground">
          <Icon.Bolt size={13} /> Circuit
        </button>
        <button className="btn sm" onClick={p.onFly} data-tip="Move the camera to this cable">
          <Icon.Target size={13} /> Fly to
        </button>
        {!p.inTab && (
          <button className="btn sm" onClick={p.onTab} data-tip="Open the wiring tab with this cable picked">
            <Icon.Plug size={13} /> Wiring
          </button>
        )}
        {p.onCode && (
          <button className="icon-btn sm" onClick={p.onCode} data-tip="Show the wire in the code" aria-label="Show in the code">
            <Icon.Code size={13} />
          </button>
        )}
        <button className="icon-btn sm" onClick={p.onAsk} data-tip="Ask Claude about this cable" aria-label="Ask Claude">
          <Icon.Sparkle size={13} />
        </button>
      </div>
    </motion.div>
  );
}

/** What it carries against what its wire carries safely. */
function Load({ d }: { d: CableDetails }) {
  const tiny = d.amps !== undefined && d.amps < 0.05;
  const pct = d.amps !== undefined && d.rating ? d.amps / d.rating : undefined;
  const tone = pct === undefined ? "" : pct > 1 ? "fail" : pct > 0.8 ? "warn" : "pass";
  return (
    <div className="cc-load">
      <div className="cc-load-top">
        {(d.volts !== undefined || d.kind === "ground") && <span className="cc-big">{d.volts !== undefined ? `${fmt(d.volts)} V` : "0 V"}</span>}
        <span className="cc-big">{d.amps === undefined ? (d.watts ? `${fmt(d.watts)} W` : "–") : tiny ? "signal" : `${fmt(d.amps, d.amps < 1 ? 2 : 1)} A`}</span>
        <span className="cc-load-of">
          {d.rating !== undefined ? (
            <>
              {tiny ? "a few mA" : "carries"} · wire good for {fmt(d.rating)} A
            </>
          ) : tiny ? (
            "a few mA"
          ) : (
            "in normal running"
          )}
        </span>
      </div>
      {pct !== undefined && !tiny && (
        <div className={`cc-bar ${tone}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} aria-label="Current against the wire's rating">
          <motion.span initial={{ width: 0 }} animate={{ width: `${Math.min(100, pct * 100)}%` }} transition={{ type: "spring", stiffness: 140, damping: 22 }} />
          <i>{Math.round(pct * 100)} %</i>
        </div>
      )}
    </div>
  );
}

function End({ e, k, shot, open: first }: { e: EndDetails; k: 0 | 1; shot: string | null; open: boolean }) {
  const [open, setOpen] = useState(first);
  const housing = e.contacts.length > 1 || ["xh", "ph", "sh", "dupont"].includes(e.kind);
  // the part's own lead: nothing to make or plug in at this end
  const lead = e.kind === "lead";
  return (
    <div className="cc-sec cc-end">
      <div className="cc-label">{k === 0 ? "From" : "To"}</div>
      <div className="cc-end-head">
        <span className="mono cc-pin">
          {e.comp}.{e.pin}
        </span>
        {e.label !== e.pin && <span className="wr-lbl"> {e.label}</span>}
        <div className="wr-sub">
          {e.part} · {e.role}
        </div>
      </div>
      <div className="cc-plug">
        <div className={`cc-shot${shot === "wait" ? " wait" : ""}`}>
          {shot && shot !== "wait" ? <img src={shot} alt={`The plug in ${e.comp} ${e.label}`} draggable={false} /> : <span className="spinner sm" aria-hidden />}
        </div>
        <div className="cc-plug-text">
          <div className="cc-conn">{e.connector}</div>
          <div>{lead ? `leaves the part from ${e.approach}` : `goes in from ${e.approach}`}</div>
          {e.latch && <div>latch towards {e.latch}</div>}
          {e.firmware && (
            <div className="cc-fw" data-tip="The name the firmware uses for this pin">
              <Icon.Chip size={11} /> <span className="mono">{e.firmware}</span>
            </div>
          )}
        </div>
      </div>
      {housing && <Face contacts={e.contacts} keyed={e.guide.keyed} />}
      {!lead && (
        <button className="cc-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span style={{ transform: open ? "rotate(90deg)" : "none" }}>
            <Icon.Chevron size={11} />
          </span>
          How it plugs in
        </button>
      )}
      {open && !lead && (
        <motion.dl className="cc-guide" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={{ duration: 0.18 }}>
          <dt>Make</dt>
          <dd>
            {e.guide.strip ? `Strip ${e.guide.strip} mm, then ` : ""}
            {e.guide.make}
            {e.guide.tool && e.guide.tool !== "none" ? <span className="dim"> · {e.guide.tool}</span> : null}
          </dd>
          <dt>Fit</dt>
          <dd>{e.guide.mate}</dd>
          <dt>Holds</dt>
          <dd>{e.guide.hold}</dd>
          <dt>Off</dt>
          <dd>{e.guide.unplug}</dd>
        </motion.dl>
      )}
    </div>
  );
}

/** The housing seen from the back: its contacts in a row, pin 1 marked, each with what is wired into it. */
export function Face({ contacts, keyed }: { contacts: Contact[]; keyed: boolean }) {
  const n = contacts.length;
  const cell = n > 8 ? 20 : 28;
  const w = n * cell + 8;
  const many = n > 5;
  return (
    <div className="cc-face" aria-label={`Contacts: ${contacts.map((c) => `${c.slot + 1} ${c.label || "empty"}`).join(", ")}`}>
      <svg viewBox={`0 0 ${w} 30`} width="100%" style={{ maxWidth: w * 1.15 }} height={30} aria-hidden>
        <rect x={1} y={4} width={w - 2} height={22} rx={4} className="cc-face-body" />
        {keyed && <rect x={w / 2 - 9} y={0.5} width={18} height={4.5} rx={1.5} className="cc-face-body" />}
        {contacts.map((c, i) => {
          const x = 4 + i * cell + cell / 2;
          return (
            <g key={i}>
              <rect x={x - cell / 2 + 2} y={7} width={cell - 4} height={16} rx={2.5} className={`cc-cav${c.mine ? " mine" : ""}`} />
              {c.color && <circle cx={x} cy={15} r={c.mine ? 5 : 4} fill={wireHex(c.color)} className={c.mine ? "cc-dot mine" : "cc-dot"} />}
              {i === 0 && <path d={`M ${x - cell / 2 + 3} 24.5 l 4 0 l -2 -3.6 z`} className="cc-pin1" />}
            </g>
          );
        })}
      </svg>
      <div className={`cc-face-labels${many ? " many" : ""}`} style={{ gridTemplateColumns: `repeat(${n}, 1fr)`, maxWidth: w * 1.15 }}>
        {contacts.map((c, i) => (
          <span key={i} className={c.mine ? "mine" : c.wire ? "" : "empty"} title={`${i + 1}: ${c.label || "empty"}${c.wire ? ` (${c.wire})` : ""}`}>
            {many ? i + 1 : c.label || "–"}
          </span>
        ))}
      </div>
    </div>
  );
}

function Steps({ steps }: { steps: string[] }) {
  const [open, setOpen] = useState(false);
  if (!steps.length) return null;
  return (
    <div className="cc-sec">
      <button className="cc-more" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span style={{ transform: open ? "rotate(90deg)" : "none" }}>
          <Icon.Chevron size={11} />
        </span>
        How to make it
      </button>
      {open && (
        <ol className="cc-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

const fmt = (v: number, d = 1) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(d).replace(/0+$/, "").replace(/\.$/, ""));
