// Keyboard shortcuts the user can move: the commands single keys run in the
// workspace, the keys they start on, and the keys the user gave them instead
// (Settings, kept as `keys`). A key is written as Kerf shows it, lower case:
// "f", "shift+2", "mod+1" (mod is Ctrl, or ⌘ on a Mac), "alt+e", "space",
// "f5", "?". Ctrl+K, Ctrl+S, undo and redo, / and Esc stay where they are.

export type KeyGroup = "General" | "View" | "Tools";

export interface KeyCommand {
  id: string;
  label: string;
  group: KeyGroup;
  keys: string[];
}

export const KEY_COMMANDS: KeyCommand[] = [
  { id: "voice", label: "Talk to Claude (Enter finishes, Esc cancels)", group: "General", keys: ["v"] },
  { id: "code", label: "Show design.kerf (again: back to the tab you were on)", group: "General", keys: ["c"] },
  { id: "shortcuts", label: "Show this sheet", group: "General", keys: ["?"] },
  { id: "fit", label: "Fit the model in view", group: "View", keys: ["f"] },
  { id: "view.iso", label: "Isometric view", group: "View", keys: ["1"] },
  { id: "view.front", label: "Front view", group: "View", keys: ["2"] },
  { id: "view.right", label: "Right view", group: "View", keys: ["3"] },
  { id: "view.top", label: "Top view", group: "View", keys: ["4"] },
  { id: "view.back", label: "Back view", group: "View", keys: ["shift+2"] },
  { id: "view.left", label: "Left view", group: "View", keys: ["shift+3"] },
  { id: "view.bottom", label: "Bottom view", group: "View", keys: ["shift+4"] },
  { id: "section", label: "Toggle section plane", group: "View", keys: ["s"] },
  { id: "explode", label: "Toggle exploded view", group: "View", keys: ["e"] },
  { id: "xray", label: "Toggle x-ray", group: "View", keys: ["x"] },
  { id: "isolate", label: "Isolate the selection", group: "View", keys: ["i"] },
  { id: "group.solo", label: "Show the selected part's group on its own", group: "View", keys: ["g"] },
  { id: "group.all", label: "Show every group", group: "View", keys: ["shift+g"] },
  { id: "wiring", label: "Show the wiring", group: "View", keys: ["w"] },
  { id: "drawings", label: "Switch between the 3D view and drawings", group: "View", keys: ["d"] },
  { id: "play", label: "Play or pause the mechanism", group: "View", keys: ["space"] },
  { id: "assembly", label: "Play the assembly animation", group: "View", keys: ["a"] },
  { id: "turntable", label: "Turntable", group: "View", keys: ["t"] },
  { id: "lighting.next", label: "Next lighting", group: "View", keys: ["l"] },
  { id: "lighting.prev", label: "Previous lighting", group: "View", keys: ["shift+l"] },
  { id: "photoreal", label: "Photoreal view", group: "View", keys: ["p"] },
  { id: "markup", label: "Draw on the view for Claude", group: "Tools", keys: ["m"] },
  { id: "measure", label: "Measure faces, edges and corners", group: "Tools", keys: ["r"] },
  { id: "filter.next", label: "Selection filter: click picks parts, faces, edges or corners", group: "Tools", keys: ["q"] },
  { id: "filter.back", label: "Selection filter, the other way", group: "Tools", keys: ["shift+q"] },
  { id: "box", label: "Box select: dragging draws a box instead of turning the view", group: "Tools", keys: ["b"] },
  { id: "handles", label: "Drag handles on a selected part: pull its sizes, slide it along X, Y or Z", group: "Tools", keys: ["h"] },
];

const BY_ID = new Map(KEY_COMMANDS.map((c) => [c.id, c]));

/** Keys that stay where they are (the browser's, the editor's and Kerf's fixed ones). */
const RESERVED = new Set(["escape", "enter", "tab", "/", "mod+k", "mod+s", "mod+z", "mod+shift+z", "mod+y", "mod+f", "mod+c", "mod+v", "mod+x", "mod+a", "mod+space", "shift+enter"]);

/** Ready-made sets: the standard views where other CAD programs keep them. */
export const KEY_PRESETS: { id: string; label: string; d: string; keys: Record<string, string[]> }[] = [
  { id: "kerf", label: "Kerf", d: "Kerf's own keys.", keys: {} },
  {
    id: "solidworks",
    label: "SolidWorks views",
    d: "Ctrl+1 front, 2 back, 3 left, 4 right, 5 top, 6 bottom, 7 isometric (in the desktop app: a browser keeps Ctrl+1 to 7 for its tabs).",
    keys: { "view.front": ["mod+1"], "view.back": ["mod+2"], "view.left": ["mod+3"], "view.right": ["mod+4"], "view.top": ["mod+5"], "view.bottom": ["mod+6"], "view.iso": ["mod+7"] },
  },
  {
    id: "onshape",
    label: "Onshape views",
    d: "Shift+1 front, 2 back, 3 left, 4 right, 5 top, 6 bottom, 7 isometric.",
    keys: { "view.front": ["shift+1"], "view.back": ["shift+2"], "view.left": ["shift+3"], "view.right": ["shift+4"], "view.top": ["shift+5"], "view.bottom": ["shift+6"], "view.iso": ["shift+7"] },
  },
];

type KeyEventLike = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "AltGraph", "OS", "Fn", "Dead", "Unidentified", "Process"]);

/**
 * The key a press makes, as a binding: digits by where they are on the
 * keyboard (Shift+2 is shift+2 whatever the layout puts there), letters as
 * typed (or by position on a keyboard that types no Latin letters), symbols
 * as typed (Shift is part of "?"). Null for a modifier on its own.
 */
export function bindingOf(e: KeyEventLike): string | null {
  if (MODIFIERS.has(e.key)) return null;
  let k: string;
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  const letter = /^Key([A-Z])$/.exec(e.code);
  if (digit) k = digit[1];
  else if (e.key === " " || e.code === "Space") k = "space";
  else if (e.key.length === 1) k = /^[\x21-\x7e]$/.test(e.key) ? e.key.toLowerCase() : letter ? letter[1].toLowerCase() : e.key.toLowerCase();
  else k = e.key.toLowerCase();
  // Shift makes a symbol of its own ("?", "@", "+") but is part of a letter, digit or named key
  const shift = e.shiftKey && (/^[a-z0-9]$/.test(k) || k.length > 1);
  if (k === "+") k = "plus";
  return [e.ctrlKey || e.metaKey ? "mod" : "", e.altKey ? "alt" : "", shift ? "shift" : "", k].filter(Boolean).join("+");
}

/** Whether a binding is one a command can take. */
export function validBinding(b: string): boolean {
  if (typeof b !== "string" || b.length > 24 || RESERVED.has(b)) return false;
  const parts = b.split("+");
  const key = parts.pop()!;
  if (!key || new Set(parts).size !== parts.length || parts.some((p) => p !== "mod" && p !== "alt" && p !== "shift")) return false;
  // modifiers in the order bindingOf writes them
  const order = ["mod", "alt", "shift"];
  if (parts.some((p, i) => i > 0 && order.indexOf(p) < order.indexOf(parts[i - 1]))) return false;
  return /^([a-z0-9]|[\x21-\x2a\x2c-\x7e]|plus|space|f[1-9]|f1[0-2]|arrow(up|down|left|right)|home|end|pageup|pagedown|insert|delete|backspace)$/.test(key);
}

/** The keys each command has: the user's where they moved it, else its own. */
export function effectiveKeys(user: Record<string, string[]> = {}): Map<string, string[]> {
  return new Map(KEY_COMMANDS.map((c) => [c.id, user[c.id] ?? c.keys]));
}

/** The command a binding runs (null for none). */
export function commandFor(binding: string | null, user: Record<string, string[]> = {}): string | null {
  if (!binding) return null;
  for (const [id, keys] of effectiveKeys(user)) if (keys.includes(binding)) return id;
  return null;
}

/**
 * Give a command a key (or none, with null), taking it off any command that
 * had it. Returns the new set of moved keys, and the command it was taken from.
 */
export function bindKey(user: Record<string, string[]>, id: string, binding: string | null): { keys: Record<string, string[]>; took: string | null } {
  if (!BY_ID.has(id)) return { keys: user, took: null };
  const next: Record<string, string[]> = { ...user };
  let took: string | null = null;
  if (binding) {
    for (const [other, keys] of effectiveKeys(user)) {
      if (other !== id && keys.includes(binding)) {
        next[other] = keys.filter((k) => k !== binding);
        took = other;
      }
    }
  }
  next[id] = binding ? [binding] : [];
  return { keys: tidy(next), took };
}

/** Drop moved keys that are back where they started. */
function tidy(user: Record<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, keys] of Object.entries(user)) {
    const own = BY_ID.get(id)?.keys;
    if (own && (keys.length !== own.length || keys.some((k, i) => k !== own[i]))) out[id] = keys;
  }
  return out;
}

/** A preset's keys over Kerf's own, with whatever the preset takes taken off the commands that had it. */
export function presetKeys(presetId: string): Record<string, string[]> {
  const p = KEY_PRESETS.find((x) => x.id === presetId);
  let keys: Record<string, string[]> = {};
  for (const [id, ks] of Object.entries(p?.keys ?? {})) keys = bindKey(keys, id, ks[0]).keys;
  return keys;
}

/** The preset the keys match exactly, if any. */
export function presetOf(user: Record<string, string[]>): string | null {
  const key = (x: Record<string, string[]>) => JSON.stringify(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)));
  return KEY_PRESETS.find((p) => key(presetKeys(p.id)) === key(user))?.id ?? null;
}

/** Moved keys as stored: known commands, valid keys, at most 3 each, no key on two commands. */
export function cleanKeys(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const [id, keys] of Object.entries(v as Record<string, unknown>)) {
    if (!BY_ID.has(id) || !Array.isArray(keys)) continue;
    out[id] = keys.filter((k): k is string => typeof k === "string" && validBinding(k) && !seen.has(k)).slice(0, 3);
    for (const k of out[id]) seen.add(k);
  }
  // a key moved to one command is no longer on the one it started on
  for (const c of KEY_COMMANDS) if (!out[c.id] && c.keys.some((k) => seen.has(k))) out[c.id] = c.keys.filter((k) => !seen.has(k));
  return tidy(out);
}

/** A binding's keys as shown on key caps: ["Ctrl", "⇧", "2"]. */
export function keyCaps(binding: string, mac: boolean): string[] {
  const parts = binding.split("+");
  const key = parts.pop()!;
  const names: Record<string, string> = { plus: "+", space: "Space", escape: "Esc", arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→", pageup: "PgUp", pagedown: "PgDn", delete: "Del", backspace: "⌫", insert: "Ins", home: "Home", end: "End" };
  const mods = parts.map((p) => (p === "mod" ? (mac ? "⌘" : "Ctrl") : p === "alt" ? (mac ? "⌥" : "Alt") : "⇧"));
  return [...mods, names[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key.length === 1 ? key.toUpperCase() : key)];
}
