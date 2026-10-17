// Design for assembly in the make tab: how long the design takes to put
// together and where the time goes, how close it is to the fewest parts it
// could have, and what would make it quicker. A finding shows its parts on
// the model.

import { motion } from "framer-motion";
import { useDesign } from "../../core/engine";
import { useView } from "../../app/view";
import { useDfa } from "../../mfg/dfaRuntime";
import { fmtTime, type DfaFinding } from "../../mfg/dfa";
import { useSettings } from "../../app/settings";
import { money } from "../../materials/advise";
import { StatusIcon } from "../icons";

/** Estimated hand assembly time for one design, seconds (none until the assembly checks have run). */
export function useAssemblySeconds(): number | undefined {
  const r = useDfa((s) => s.report);
  return r && r.counts.items ? r.time.seconds : undefined;
}

const pct = (x: number) => `${Math.round(x * 100)} %`;

export function AssemblyCard() {
  const r = useDfa((s) => s.report);
  const measuring = useDfa((s) => s.measuring);
  const labour = useSettings((s) => s.labourRate);
  const model = useDesign((s) => s.model);
  if (!r || !r.counts.items || !model) return null;
  const findings = r.findings.filter((f) => f.id !== "dfa:summary" && f.status !== "pass");
  const passes = r.findings.filter((f) => f.status === "pass");
  const max = Math.max(1, ...r.time.lines.map((l) => l.seconds));
  return (
    <div className="mk-asm">
      <div className="mk-h">Putting it together</div>
      <div className="mk-asm-grid">
        <div className="mk-asm-stats">
          <Stat k="Assembly" v={fmtTime(r.time.seconds)} s={`${fmtTime(r.time.low)}–${fmtTime(r.time.high)} by hand · ${money((r.time.seconds / 3600) * labour)} at ${money(labour)}/h`} />
          <Stat k="Items" v={String(r.counts.items)} s={`${r.counts.made} made · ${r.counts.bought} bought · ${r.counts.fasteners} fasteners`} />
          <Stat k="Fewest possible" v={String(r.minimumParts)} s="parts that move, differ in material, come off for service or are bought for a job" />
          <Stat k="DFA index" v={pct(r.efficiency)} s="5–10 % is usual for a first design, 20–30 % is lean" tone={r.efficiency >= 0.2 ? "pass" : r.efficiency < 0.08 ? "warn" : undefined} />
        </div>
        <div className="mk-asm-time" aria-label="Where the assembly time goes">
          {r.time.lines.slice(0, 6).map((l, i) => (
            <div key={l.label} className="mk-asm-line">
              <span className="mk-asm-l">
                {l.label} <span className="mk-why-in">×{l.count}</span>
              </span>
              <span className="mk-asm-bar">
                <motion.span initial={{ width: 0 }} animate={{ width: `${(l.seconds / max) * 100}%` }} transition={{ delay: i * 0.04, duration: 0.35 }} />
              </span>
              <span className="mk-asm-v">{fmtTime(l.seconds)}</span>
            </div>
          ))}
        </div>
      </div>
      {findings.length > 0 && (
        <div className="mk-asm-findings">
          {findings.map((f) => (
            <Finding key={f.id} f={f} />
          ))}
        </div>
      )}
      {passes.length > 0 && <div className="mk-fine">Good: {passes.map((f) => f.title.charAt(0).toLowerCase() + f.title.slice(1)).join("; ")}.</div>}
      {measuring > 0 && <div className="mk-fine">Measuring which parts touch; parts that could be combined may still change.</div>}
    </div>
  );
}

function Stat({ k, v, s, tone }: { k: string; v: string; s: string; tone?: "pass" | "warn" }) {
  return (
    <div className="mk-asm-stat" data-tip={s}>
      <span className="k">{k}</span>
      <span className={`v ${tone ?? ""}`}>{v}</span>
      <span className="s">{s}</span>
    </div>
  );
}

function Finding({ f }: { f: DfaFinding }) {
  const show = (on: boolean) => useView.setState({ focusParts: on ? f.parts : [] });
  return (
    <div className="mk-asm-f" onMouseEnter={() => show(true)} onMouseLeave={() => show(false)} onFocus={() => show(true)} onBlur={() => show(false)} tabIndex={0}>
      <StatusIcon status={f.status} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="mk-asm-ft">{f.title}</div>
        <div className="mk-asm-fd">{f.detail}</div>
        {f.fix && <div className="mk-asm-fx">{f.fix}</div>}
      </div>
    </div>
  );
}
