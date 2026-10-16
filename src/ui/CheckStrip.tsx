// Check results at a glance: an instant verdict from the parametric
// requirements (no geometry needed), and the full checks once the kernel has
// built what the viewport is showing.

import { useDesign } from "../core/engine";
import type { Model } from "../core/model";
import { StatusIcon } from "./icons";

export interface Verdict {
  /** hard parametric requirements that fail, with their detail */
  failing: { label: string; detail: string }[];
  soft: number;
  pass: number;
  total: number;
  errors: number;
}

/** What the parametric requirements say about a design, without building it. */
export function verdictFor(model: Model | null): Verdict {
  const reqs = (model?.requirements ?? []).filter((r) => r.geo.length === 0);
  return {
    failing: reqs.filter((r) => r.level === "hard" && (r.status === "fail" || r.status === "error")).map((r) => ({ label: r.label, detail: r.detail })),
    soft: reqs.filter((r) => r.level === "soft" && r.status === "fail").length,
    pass: reqs.filter((r) => r.status === "pass").length,
    total: reqs.length,
    errors: model?.diagnostics.filter((d) => d.severity === "error").length ?? 0,
  };
}

export function VerdictBadge({ v, compact }: { v: Verdict; compact?: boolean }) {
  if (v.errors) return <span className="verdict fail">source error</span>;
  if (!v.total) return null;
  if (v.failing.length)
    return (
      <span className="verdict fail" data-tip={v.failing.map((f) => `${f.label}: ${f.detail}`).join("\n")}>
        <StatusIcon status="fail" /> {compact ? v.failing.length : `${v.failing.length} requirement${v.failing.length > 1 ? "s" : ""} fail${v.failing.length > 1 ? "" : "s"}`}
      </span>
    );
  return (
    <span className="verdict pass" data-tip="Every parametric requirement holds. Geometry checks run when it is built.">
      <StatusIcon status="pass" /> {compact ? `${v.pass}/${v.total}` : `${v.pass}/${v.total} requirements`}
    </span>
  );
}

/** Live state of the checks for the design on screen. */
export function CheckStrip() {
  const model = useDesign((s) => s.model);
  const report = useDesign((s) => s.report);
  const reportRev = useDesign((s) => s.reportRev);
  const rev = useDesign((s) => s.rev);
  const kernelStatus = useDesign((s) => s.kernelStatus);
  const v = verdictFor(model);
  const fresh = report && reportRev >= rev;
  return (
    <span className="check-strip">
      <VerdictBadge v={v} />
      {kernelStatus === "error" ? null : fresh ? (
        <span className={`verdict ${report.counts.fail ? "fail" : "pass"}`}>
          {report.counts.fail ? `${report.counts.fail} check${report.counts.fail > 1 ? "s" : ""} failing` : `all ${report.counts.pass} checks pass`}
        </span>
      ) : (
        <span className="verdict pending">
          <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> checking geometry
        </span>
      )}
    </span>
  );
}
