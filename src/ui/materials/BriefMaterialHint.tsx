// Under the brief's material: how the chosen material fits where the design
// lives and how it is made, and the materials that fit better, one click away.

import { useMemo } from "react";
import type { BriefData } from "../../core/brief";
import { adviseMaterials } from "../../materials/advise";
import { briefFacts } from "../../materials/context";
import { editBrief } from "../briefEdit";

export function BriefMaterialHint({ data }: { data: BriefData }) {
  const advice = useMemo(() => adviseMaterials({ brief: briefFacts(data) }), [data]);
  const chosen = data.material ? advice.options.find((o) => o.name === data.material) : undefined;
  const picks = advice.options.filter((o) => o.verdict !== "unsuitable" && !o.otherWay && o.name !== data.material).slice(0, 3);
  const better = picks.filter((o) => !chosen || o.score > chosen.score + 0.03);
  const use = (name: string) => editBrief((d) => void ((d.material = name), (d.assumed = d.assumed.filter((k) => k !== "material"))), `material ${name}`);
  const fails = chosen?.criteria.filter((k) => k.grade === "fail") ?? [];
  // the weak points that matter most, in the advisor's own words
  const weak = (chosen?.criteria.filter((k) => k.grade === "poor" && k.weight > 0) ?? []).sort((x, y) => y.weight - x.weight).slice(0, 2);
  // with nothing to go on, a list of materials is noise
  if (!chosen && (!picks.length || (!data.process && !data.temp && !data.outdoor && !data.exposure.length))) return null;
  return (
    <div className="brief-hint mo-brief">
      {chosen && (
        <div>
          {fails.length ? (
            <span className="g-fail">{fails.map((k) => k.why).join(". ")}.</span>
          ) : weak.length ? (
            <span className="mo-brief-weak">{weak.map((k) => k.why).join(". ")}.</span>
          ) : (
            <>
              {chosen.label} suits this{chosen.pros.length ? `: ${chosen.pros.join(", ")}` : ""}.
            </>
          )}
        </div>
      )}
      {(chosen ? better : picks).length > 0 && (
        <div className="mo-brief-picks">
          <span className="muted">{chosen ? (fails.length ? "Instead:" : "Fits better:") : "Suggested:"}</span>
          {(chosen ? better : picks).map((o) => (
            <button key={o.name} className="mat-chip" onClick={() => use(o.name)} data-tip={o.criteria.filter((k) => k.weight > 0).map((k) => `${k.label} ${k.value}: ${k.why}`).join("\n")}>
              <span className={`mo-dot v-${o.verdict}`} />
              {o.label.replace(/ \(.*\)$/, "")}
              {o.summary && <span className="muted"> · {o.summary.split(";")[0]}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
