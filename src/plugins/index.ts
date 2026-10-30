// The plugins Kerf ships with, and which of them the user has switched on.

import { useSettings } from "../app/settings";
import type { KerfPlugin } from "./types";
import { organicPlugin } from "./organic/plugin";

export type { KerfPlugin } from "./types";

export const PLUGINS: KerfPlugin[] = [organicPlugin];

export const pluginOn = (id: string) => !useSettings.getState().pluginsOff.includes(id);

/** Plugins that are switched on. */
export const activePlugins = () => PLUGINS.filter((p) => pluginOn(p.id));

/** Assistant instructions from the plugins that are on, each a section of its own. */
export function pluginPromptSections(): string {
  return activePlugins()
    .map((p) => p.prompt?.())
    .filter(Boolean)
    .join("\n\n");
}
