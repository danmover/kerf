// Whether to keep motion down: the Settings switch, or the system's reduce-motion setting (which turns every effect
// off too, as the plan asks). The CSS answers the system's setting on its own (@media prefers-reduced-motion).

import { useEffect, useState } from "react";
import { useSettings } from "./settings";

const QUERY = "(prefers-reduced-motion: reduce)";

/** The system asks for less motion. */
export function systemReducesMotion(): boolean {
  return typeof matchMedia !== "undefined" && matchMedia(QUERY).matches;
}

/** Keep motion down now: the setting or the system's. */
export function reduceMotionNow(): boolean {
  return useSettings.getState().reduceMotion || systemReducesMotion();
}

/** The same, kept up to date as either changes. */
export function useReduceMotion(): boolean {
  const own = useSettings((s) => s.reduceMotion);
  const [system, setSystem] = useState(systemReducesMotion);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const m = matchMedia(QUERY);
    const on = () => setSystem(m.matches);
    m.addEventListener?.("change", on);
    return () => m.removeEventListener?.("change", on);
  }, []);
  return own || system;
}
