// Selection and viewport display state, shared by the viewport, the
// structure tree, the code editor and the checks panel.

import { create } from "zustand";
import type { Span } from "../lang/ast";

export type ViewPreset = "iso" | "front" | "back" | "top" | "bottom" | "left" | "right";
export type DockTab = "brief" | "code" | "checks" | "graph" | "bom";
export type LeftTab = "structure" | "params" | "history";

interface ViewState {
  /** selected part ids (instances) */
  selected: string[];
  hovered: string | null;
  /** part ids to emphasise while a check item is focused */
  focusParts: string[];
  /** check item in focus (draws interference volumes and probes) */
  focusCheck: string | null;
  /** parts hidden for this session (does not change the source) */
  hiddenIds: string[];
  isolate: boolean;
  xray: boolean;
  section: { on: boolean; axis: "x" | "y" | "z"; t: number; flip: boolean };
  explode: number;
  playing: boolean;
  speed: number;
  /** request the editor to reveal a span */
  reveal: { span: Span; nonce: number } | null;
  /** request the viewport to move the camera */
  cameraRequest: { preset: ViewPreset | "fit"; nonce: number } | null;
  dockTab: DockTab;
  leftTab: LeftTab;
  dockOpen: boolean;
}

export const useView = create<ViewState>(() => ({
  selected: [],
  hovered: null,
  focusParts: [],
  focusCheck: null,
  hiddenIds: [],
  isolate: false,
  xray: false,
  section: { on: false, axis: "x", t: 0.5, flip: false },
  explode: 0,
  playing: false,
  speed: 1,
  reveal: null,
  cameraRequest: null,
  dockTab: "code",
  leftTab: "structure",
  dockOpen: true,
}));

let nonce = 0;
export const revealSpan = (span: Span) => useView.setState({ reveal: { span, nonce: ++nonce } });
export const requestCamera = (preset: ViewPreset | "fit") => useView.setState({ cameraRequest: { preset, nonce: ++nonce } });
export const select = (ids: string[]) => useView.setState({ selected: ids });
export const resetView = () =>
  useView.setState({ selected: [], hovered: null, focusParts: [], focusCheck: null, hiddenIds: [], isolate: false, xray: false, section: { on: false, axis: "x", t: 0.5, flip: false }, explode: 0, playing: false });
