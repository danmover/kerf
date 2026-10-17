// App-level UI state: which screen is showing, dialogs and notifications.

import { create } from "zustand";

export type LegalDoc = "terms" | "privacy" | "acceptable-use" | "licenses";
export type Screen = { name: "onboarding" } | { name: "home" } | { name: "workspace" } | { name: "legal"; doc: LegalDoc; back: "home" | "workspace" | "onboarding" };

export interface Toast {
  id: number;
  kind: "info" | "success" | "error" | "warn";
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface ConfirmRequest {
  title: string;
  body: string;
  confirm: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

export type SettingsTab = "ai" | "account" | "voice" | "app" | "making" | "data" | "about";

interface UiState {
  screen: Screen;
  toasts: Toast[];
  settingsOpen: SettingsTab | null;
  shortcutsOpen: boolean;
  confirm: ConfirmRequest | null;
}

export const useUi = create<UiState>(() => ({
  screen: { name: "home" },
  toasts: [],
  settingsOpen: null,
  shortcutsOpen: false,
  confirm: null,
}));

let toastId = 0;
export function toast(t: Omit<Toast, "id">, ms = 5000) {
  const id = ++toastId;
  useUi.setState((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
  if (ms > 0) setTimeout(() => dismissToast(id), ms);
  return id;
}
export const dismissToast = (id: number) => useUi.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));

export function confirmDialog(req: Omit<ConfirmRequest, "resolve">): Promise<boolean> {
  return new Promise((resolve) => useUi.setState({ confirm: { ...req, resolve } }));
}

export const go = (screen: Screen) => useUi.setState({ screen });
export const openSettings = (tab: SettingsTab = "ai") => useUi.setState({ settingsOpen: tab });
export const closeSettings = () => useUi.setState({ settingsOpen: null });

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
