// The design's groups of parts in the 3D view: show one on its own (say the
// nozzle, or the electronics), several at once, or every group again. The
// toolbar's menu lists the groups; while some are shown on their own, a key
// in the corner says which and puts everything back. Grouping selected parts
// writes `group:` into the design.

import { AnimatePresence, motion } from "framer-motion";
import { useMemo, useState } from "react";
import { useDesign } from "../core/engine";
import { useView, showGroups, soloGroup } from "../app/view";
import { partGroups } from "../app/partGroups";
import { withGroup, cleanGroupName } from "../app/groups";
import { commitSource } from "../app/project";
import { toast } from "../app/ui";
import { Menu, MenuItem } from "./common";
import { Icon } from "./icons";
import "../styles/view-groups.css";

/** The toolbar's group menu. */
export function GroupsMenu() {
  const model = useDesign((s) => s.model);
  const solo = useView((s) => s.soloGroups);
  const groups = useMemo(() => (model ? partGroups(model.parts) : []), [model]);
  return (
    <Menu
      trigger={(open, toggle) => (
        <button className={`icon-btn ${open || solo.length ? "active" : ""}`} onClick={toggle} disabled={!model?.parts.length} data-tip="Groups: show one group of parts on its own (G)" aria-label="Groups">
          <Icon.Layers />
        </button>
      )}
      width={250}
    >
      {(close) => (
        <div className="vg-menu">
          <div className="menu-label">Show a group on its own</div>
          {groups.map((g) => (
            <MenuItem
              key={g.name}
              icon={solo.includes(g.name) ? <Icon.Check size={13} /> : <Icon.Layers size={13} />}
              hint={String(g.ids.length)}
              onClick={() => {
                soloGroup(g.name);
                close();
              }}
            >
              {g.name}
            </MenuItem>
          ))}
          {solo.length > 0 && (
            <MenuItem
              icon={<Icon.Eye size={13} />}
              onClick={() => {
                showGroups([]);
                close();
              }}
            >
              Show every group
            </MenuItem>
          )}
          <div className="vg-menu-note">Groups come from the design. Select parts and press Group to make one, or ask Claude to group them.</div>
        </div>
      )}
    </Menu>
  );
}

/** Says which groups are shown on their own, adds or takes others, and shows them all again. */
export function GroupsKey() {
  const model = useDesign((s) => s.model);
  const solo = useView((s) => s.soloGroups);
  const groups = useMemo(() => (model ? partGroups(model.parts) : []), [model]);
  const shown = solo.filter((g) => groups.some((x) => x.name === g));
  return (
    <AnimatePresence>
      {shown.length > 0 && (
        <motion.div className="vp-float vg-key" initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ type: "spring", stiffness: 420, damping: 36 }}>
          <div className="vg-head">
            <Icon.Layers size={13} />
            <span className="vg-title">
              Showing <b>{shown.join(", ")}</b>
            </span>
            <button className="btn sm ghost" onClick={() => showGroups([])} data-tip="Show every group again (Shift+G)">
              Show all
            </button>
          </div>
          <div className="vg-chips">
            {groups.map((g) => (
              <button key={g.name} className={`vg-chip ${shown.includes(g.name) ? "on" : ""}`} aria-pressed={shown.includes(g.name)} onClick={() => soloGroup(g.name, true)} data-tip={shown.includes(g.name) ? "Take it away" : "Show it too"}>
                {g.name}
              </button>
            ))}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Put the selected parts into a group, new or existing: written into the design as `group:`. */
export function GroupButton({ ids }: { ids: string[] }) {
  const model = useDesign((s) => s.model);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const groups = useMemo(() => (model ? partGroups(model.parts).map((g) => g.name) : []), [model]);
  if (!model) return null;
  const apply = (g: string) => {
    const clean = cleanGroupName(g);
    if (!clean) return;
    const r = withGroup(useDesign.getState().source, model, ids, clean);
    if (r.changed.length) commitSource(r.src, "you", `Grouped ${r.changed.join(", ")} as ${clean}`);
    if (r.missing.length) toast({ kind: "warn", title: `${r.missing.join(", ")} kept ${r.missing.length === 1 ? "its" : "their"} group`, detail: "Made in a loop or inside another block: give it a group: in the code." });
    setEditing(false);
    setName("");
  };
  if (!editing)
    return (
      <button className="btn sm" onClick={() => setEditing(true)} data-tip="Put these parts in a group you can show on its own or hide">
        <Icon.Layers size={13} /> Group
      </button>
    );
  return (
    <form
      className="vg-group-form"
      onSubmit={(e) => {
        e.preventDefault();
        apply(name);
      }}
    >
      <input className="input sm" autoFocus list="vg-group-names" placeholder="Group name, e.g. Nozzle" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(false)} aria-label="Group name" />
      <datalist id="vg-group-names">
        {groups.map((g) => (
          <option key={g} value={g} />
        ))}
      </datalist>
      <button className="btn sm primary" type="submit" disabled={!cleanGroupName(name)}>
        Group
      </button>
    </form>
  );
}
