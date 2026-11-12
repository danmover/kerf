// Switching and saving the design's configurations, as commits the user can undo: what the Parameters tab's strip,
// the find palette and anything else that changes configurations by hand go through.

import { commitSource, realSource } from "./project";
import { saveConfig, showConfig } from "../core/configs";
import { evaluate } from "../lang/evaluator";

/** Show a configuration (null: the parameters as written). */
export function showConfiguration(label: string | null) {
  const src = realSource();
  const m = evaluate(src, { skipGeometry: true });
  if (!m.configs) return;
  commitSource(showConfig(src, m, label), "you", label === null ? "Showing the parameters as written" : `Showing configuration “${label}”`);
}

/** Save the values as they are now as a configuration (a new row, or the row of that name brought up to date), and show it. */
export function saveConfiguration(label: string) {
  const name = label.trim();
  if (!name) return;
  const src = realSource();
  const m = evaluate(src, { skipGeometry: true });
  commitSource(saveConfig(src, m, name, { show: true }), "you", `${m.configs?.rows.some((r) => r.label === name) ? "Updated" : "Saved"} configuration “${name}”`);
}
