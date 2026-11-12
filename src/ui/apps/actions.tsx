// What the apps tab, the centre view and the find palette share: writing an
// app change into the design file, making a new app, the apps glyph.

import { useDesign } from "../../core/engine";
import { commitSource } from "../../app/project";
import { toast } from "../../app/ui";
import { openApp } from "../../apps/session";
import { appendApp, freshAppName, starterApp } from "../../apps/source";
import { useSim } from "../../sim/runtime";

/** Write a changed design file, as the user. */
export function commitApp(src: string, message: string) {
  if (src === useDesign.getState().source) return;
  commitSource(src, "you", message);
}

/** The channels a design's simulation records, from its last finished run. */
export function simChannels(scenario?: string | null): string[] {
  const runs = useSim.getState().runs;
  const pick = scenario ? runs.get(scenario) : [...runs.values()].find((r) => r.result?.variants.length);
  return Object.keys(pick?.result?.variants[0]?.frames.series ?? {});
}

/** Add a starter app to the design (from its firmware and simulation) and open it to build. */
export function newAppInDesign() {
  const d = useDesign.getState();
  const model = d.model;
  if (!model) return;
  const name = freshAppName(model);
  const twin = model.scenarios?.find((s) => s.spec.world.kind !== "printer" && !s.spec.physicsOnly)?.label;
  const src = appendApp(d.source, starterApp(model, name, simChannels(twin)));
  commitSource(src, "you", `Added the app ${name}`);
  if (!useDesign.getState().model?.apps?.some((a) => a.name === name)) {
    toast({ kind: "warn", title: "The new app has a problem", detail: "It is at the end of the design file: the code tab shows what to fix." });
    return;
  }
  openApp(name, { edit: true });
}

export function AppGlyph({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="1.5" y="2" width="13" height="12" rx="2" />
      <path d="M1.5 5.5h13" />
      <path d="M4 11l2-2.5 2 1.5 3-4" />
    </svg>
  );
}
