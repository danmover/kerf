// The 3D panel of an app inside Kerf: the design's own parts and meshes, and
// the twin's scene while the twin runs.

import { meshes, useDesign } from "../../core/engine";
import { currentLink } from "../../apps/session";
import { modelView3d } from "../../apps/runtime/model3d";
import type { ModelView } from "../../apps/runtime/panels";
import type { PanelSpec } from "../../apps/spec";
import type { SignalStore } from "../../apps/store";

export function kerfModelView(into: HTMLElement, panel: Extract<PanelSpec, { kind: "model" }>, store: SignalStore): ModelView {
  return modelView3d(into, panel, store, { parts: useDesign.getState().model?.parts ?? [], meshes, scene: () => currentLink()?.info?.scene });
}
