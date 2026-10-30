// What a plugin can add to Kerf. Plugins live in their own folders under
// src/plugins and are listed in plugins/index.ts; the user can switch each
// one off in Settings → Plugins. Their .kerf functions (plugins/lang.ts) and
// kernel shapes (plugins/kernel.ts) stay available either way, so designs
// that use them keep building.

import type { Template } from "../demos/templates";
import type { ExportFormat } from "../app/exportFormats";

export interface KerfPlugin {
  id: string;
  name: string;
  /** one or two sentences for Settings → Plugins */
  description: string;
  /** starting points on the home screen */
  templates?: Template[];
  /** a section added to the design assistant's instructions */
  prompt?: () => string;
  /** entries in the Export menu */
  exports?: ExportFormat[];
}
