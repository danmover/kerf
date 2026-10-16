// Settings for parallel subassembly agents (shown under Settings → Claude).

import { useEffect, useState } from "react";
import { useSettings, updateSettings, MODELS } from "../../app/settings";
import { defaultWorkers } from "../../agents/isolated";
import { Toggle } from "../common";

export function AgentSettings() {
  const s = useSettings();
  const [budget, setBudget] = useState(String(s.agentBudget));
  useEffect(() => setBudget(String(s.agentBudget)), [s.agentBudget]);
  const auto = defaultWorkers();
  return (
    <section style={{ marginBottom: 18 }}>
      <div className="section-label" style={{ marginTop: 0 }}>
        Parallel agents
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Agents' model</div>
          <div className="d">For large assemblies Claude can have one agent build each subassembly at the same time. A cheaper model lowers the cost of each run.</div>
        </div>
        <select className="select" value={s.agentModel} onChange={(e) => updateSettings({ agentModel: e.target.value })} aria-label="Model for parallel agents" style={{ height: 30, width: 170, flex: "none" }}>
          <option value="same">Same as chat</option>
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label.replace("Claude ", "")}
            </option>
          ))}
        </select>
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Review the plan first</div>
          <div className="d">Shows the subassemblies, their briefs and the estimated cost before any agent starts, so you can edit or leave some out.</div>
        </div>
        <Toggle on={s.agentReview} onChange={(v) => updateSettings({ agentReview: v })} label="Review the plan first" />
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Spending cap per run</div>
          <div className="d">Agents stop when a run reaches this amount. The work done so far is kept.</div>
        </div>
        <span className="row mono" style={{ gap: 4 }}>
          $
          <input
            className="input"
            style={{ width: 70, height: 30, flex: "none" }}
            inputMode="decimal"
            value={budget}
            aria-label="Spending cap per run in dollars"
            onChange={(e) => setBudget(e.target.value)}
            onBlur={() => {
              const v = Number(budget);
              if (Number.isFinite(v) && v >= 0.5 && v <= 100) updateSettings({ agentBudget: Math.round(v * 100) / 100 });
              else setBudget(String(s.agentBudget));
            }}
          />
        </span>
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Agents at once</div>
          <div className="d">How many agents call Claude at the same time. Lower it if your API key hits rate limits.</div>
        </div>
        <div className="row" style={{ gap: 8, minWidth: 170 }}>
          <input type="range" min={1} max={8} step={1} value={s.agentParallel} onChange={(e) => updateSettings({ agentParallel: Number(e.target.value) })} aria-label="Agents at once" style={{ flex: 1 }} />
          <span className="mono" style={{ width: 22, textAlign: "right" }}>
            {s.agentParallel}
          </span>
        </div>
      </div>
      <div className="setting">
        <div className="grow">
          <div className="t">Geometry workers</div>
          <div className="d">Extra OpenCASCADE workers that build and check agents' work in parallel. Each needs a few hundred MB of memory. Auto picks {auto} for this device.</div>
        </div>
        <div className="row" style={{ gap: 8, minWidth: 170 }}>
          <input type="range" min={0} max={4} step={1} value={s.agentWorkers} onChange={(e) => updateSettings({ agentWorkers: Number(e.target.value) })} aria-label="Geometry workers" style={{ flex: 1 }} />
          <span className="mono" style={{ width: 36, textAlign: "right" }}>
            {s.agentWorkers || "auto"}
          </span>
        </div>
      </div>
    </section>
  );
}
