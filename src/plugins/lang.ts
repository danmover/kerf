// Plugin namespaces in .kerf. They are always available, whether or not a
// plugin's panels and assistant guide are switched on, so a design that uses
// one never stops building.

import type { Obj } from "../lang/values";
import { organicNamespace } from "./organic/lang";

export function pluginNamespaces(): Record<string, Obj> {
  return { organic: organicNamespace() };
}
