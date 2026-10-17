// Which processes you have, can order or cannot use. Settings hold your usual
// set for every design; a design's brief can carry its own (workshop: and
// can_order:), for a project made somewhere else.

import { useDesign } from "../../core/engine";
import { useSettings, updateSettings } from "../../app/settings";
import { PROCESSES, PROCESS_IDS } from "../../mfg/profiles";
import { availability, fullAccess, type Access, type Availability } from "../../mfg/availability";
import type { ProcessId } from "../../mfg/types";
import { editBrief } from "../briefEdit";
import { Segmented } from "../common";
import "../../styles/make.css";

const FAMILY: Record<string, string> = { additive: "3D printing", subtractive: "Machining", formative: "Moulding and casting", sheet: "Sheet and cutting" };
const ORDER = ["additive", "subtractive", "sheet", "formative"];

const OPTIONS: { value: Access; label: string; title: string }[] = [
  { value: "own", label: "have", title: "You have this machine or process: no shipping, your own time" },
  { value: "order", label: "order", title: "You can order parts made this way from a shop or online service" },
  { value: "none", label: "off", title: "Not available: Kerf will not recommend it" },
];

/** The access this design uses now, and whether its brief sets it. */
export function useAccess(): { access: Availability; fromBrief: boolean } {
  const brief = useDesign((s) => s.model?.brief);
  const saved = useSettings((s) => s.processAccess);
  return availability(brief ?? null, saved);
}

/** Write an access set into the brief as its workshop: and can_order: lists. */
function writeBrief(a: Availability, message: string) {
  editBrief((d) => {
    d.workshop = PROCESS_IDS.filter((id) => a[id] === "own");
    d.canOrder = PROCESS_IDS.filter((id) => a[id] === "order");
  }, message);
}

export function AccessEditor({ compact, settingsOnly }: { compact?: boolean; settingsOnly?: boolean }) {
  const project = useAccess();
  const saved = useSettings((s) => s.processAccess);
  const hasModel = useDesign((s) => !!s.model);
  const scope: "all" | "design" = !settingsOnly && project.fromBrief ? "design" : "all";
  const shown = scope === "design" ? project.access : fullAccess(saved);

  const set = (id: ProcessId, v: Access) => {
    if (scope === "design") writeBrief({ ...shown, [id]: v }, `${PROCESSES[id].short} ${v === "own" ? "in your workshop" : v === "order" ? "to order" : "not available"}`);
    else updateSettings({ processAccess: { ...saved, [id]: v } });
  };
  const setScope = (v: "all" | "design") => {
    if (v === scope) return;
    if (v === "design") writeBrief(fullAccess(saved), "processes for this design");
    else
      editBrief((d) => {
        d.workshop = undefined;
        d.canOrder = undefined;
      }, "use your usual processes");
  };

  const groups = ORDER.map((f) => ({ f, ids: PROCESS_IDS.filter((id) => PROCESSES[id].family === f) }))
    .concat([{ f: "other", ids: PROCESS_IDS.filter((id) => !ORDER.includes(PROCESSES[id].family)) }])
    .filter((g) => g.ids.length);

  return (
    <div className={`access ${compact ? "compact" : ""}`}>
      {!settingsOnly && hasModel && (
        <div className="access-scope">
          <Segmented
            id="access-scope"
            value={scope}
            onChange={setScope}
            options={[
              { value: "all", label: "All my designs", title: "Your usual processes, from Settings" },
              { value: "design", label: "Only this design", title: "This design's own list, kept in its brief (workshop: and can_order:)" },
            ]}
          />
          <span className="access-note">{scope === "design" ? "Saved in this design's brief." : "Saved in Settings for every design."}</span>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.f} className="access-group">
          <div className="access-family">{FAMILY[g.f] ?? "Other"}</div>
          {g.ids.map((id) => (
            <div key={id} className={`access-row a-${shown[id]}`}>
              <span className="access-name" data-tip={`${PROCESSES[id].summary} Best for ${PROCESSES[id].bestFor}.`}>
                {PROCESSES[id].label}
              </span>
              <Segmented id={`access-${id}`} value={shown[id]} onChange={(v) => set(id, v)} options={OPTIONS} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** "2 yours · 10 to order · 1 off", for the make tab's header. */
export function accessSummary(a: Availability): string {
  const n = (x: Access) => PROCESS_IDS.filter((id) => a[id] === x).length;
  return [n("own") ? `${n("own")} yours` : "", n("order") ? `${n("order")} to order` : "", n("none") ? `${n("none")} off` : ""].filter(Boolean).join(" · ") || "none";
}
