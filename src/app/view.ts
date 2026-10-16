// Selection and viewport display state, shared by the viewport, the
// structure tree, the code editor and the checks panel.

import { create } from "zustand";
import type { Span } from "../lang/ast";

export type ViewPreset = "iso" | "front" | "back" | "top" | "bottom" | "left" | "right";
export type DockTab = "brief" | "code" | "checks" | "graph" | "bom";
/** the built-in tabs; features can add more through LEFT_TABS in ui/LeftPanel */
export type LeftTab = "structure" | "params" | "decisions" | "history" | (string & {});

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
  /** slow turntable orbit for presenting the model */
  turntable: boolean;
  /** request the viewport to play the assembly animation */
  assemblyRequest: number;
  /** request the editor to reveal a span */
  reveal: { span: Span; nonce: number } | null;
  /** request the viewport to move the camera */
  cameraRequest: { preset: ViewPreset | "fit"; nonce: number } | null;
  dockTab: DockTab;
  leftTab: LeftTab;
  dockOpen: boolean;
  /** request the decisions panel to open and reveal a decision */
  decisionFocus: { name: string; nonce: number } | null;
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
  turntable: false,
  assemblyRequest: 0,
  reveal: null,
  cameraRequest: null,
  dockTab: "code",
  leftTab: "structure",
  dockOpen: true,
  decisionFocus: null,
}));

let nonce = 0;
export const revealSpan = (span: Span) => useView.setState({ reveal: { span, nonce: ++nonce } });
export const requestCamera = (preset: ViewPreset | "fit") => useView.setState({ cameraRequest: { preset, nonce: ++nonce } });
export const select = (ids: string[]) => useView.setState({ selected: ids });
export const showDecision = (name: string) => useView.setState({ leftTab: "decisions", decisionFocus: { name, nonce: ++nonce } });
export const resetView = () =>
  useView.setState({ selected: [], hovered: null, focusParts: [], focusCheck: null, hiddenIds: [], isolate: false, xray: false, section: { on: false, axis: "x", t: 0.5, flip: false }, explode: 0, playing: false, turntable: false });
/** Emphasise parts while something that shapes them is hovered (a focused check keeps the view). */
export const hoverParts = (ids: string[]) => {
  if (useView.getState().focusCheck) return;
  useView.setState({ focusParts: ids });
};
