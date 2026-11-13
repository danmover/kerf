// The keyboard shortcut sheet (? or Settings → Mouse and keys): every key
// Kerf answers to, with the ones a user can move clickable to take a new key,
// ready-made sets of view keys from other CAD programs, and what the mouse
// does in the scheme chosen.

import { useCallback, useEffect, useState } from "react";
import { useUi } from "../app/ui";
import { updateSettings, useSettings } from "../app/settings";
import { KEY_COMMANDS, KEY_PRESETS, bindKey, bindingOf, keyCaps, presetKeys, presetOf, validBinding, type KeyGroup } from "../app/keymap";
import { MOUSE_SCHEMES, MOUSE_SCHEME_IDS, type MouseScheme } from "../app/mouse";
import { Kbd, Modal, isMac, mod } from "./common";
import { Icon } from "./icons";

type Row = [string[], string];

const FIXED: Row[] = [
  [[mod, "K"], "Find any tool, view, analysis or export, or ask Claude"],
  [["/"], "Find, when you're not typing"],
  [[mod, "Z"], "Undo"],
  [[mod, "⇧", "Z"], "Redo"],
  [[mod, "S"], "Save now (Kerf also saves automatically)"],
  [["Esc"], "Clear selection, close dialogs"],
];

const MOUSE_COMMON: Row[] = [
  [["Alt", "drag"], "Turn the lighting"],
  [["Click"], "Select a part"],
  [["⇧", "Click"], "Add to the selection"],
  [["Drag"], "With box select: left to right takes what is wholly inside, right to left whatever the box touches"],
  [["Double-click"], "Zoom to a part (empty space fits all)"],
  [["Right-click"], "Ask Claude about that spot"],
];

const EDITOR: Row[] = [
  [["Enter"], "Send the message"],
  [["⇧", "Enter"], "New line"],
  [[mod, "F"], "Find in the design file"],
  [[mod, "Space"], "Autocomplete in the editor"],
];

const GROUPS: KeyGroup[] = ["General", "View", "Tools"];
const LABEL = new Map(KEY_COMMANDS.map((c) => [c.id, c.label]));
const caps = (b: string) => keyCaps(b, isMac).join(" ");

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row" style={{ justifyContent: "space-between", gap: 10, padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
      <span className="muted" style={{ fontSize: 12.5 }}>
        {label}
      </span>
      <span className="row" style={{ gap: 3, flexShrink: 0 }}>
        {children}
      </span>
    </div>
  );
}

const Keys = ({ keys }: { keys: string[] }) => (
  <>
    {keys.map((k, i) => (
      <Kbd key={i}>{k}</Kbd>
    ))}
  </>
);

export function ShortcutsModal() {
  const open = useUi((s) => s.shortcutsOpen);
  const user = useSettings((s) => s.keys);
  const scheme = useSettings((s) => s.mouseScheme);
  const [taking, setTaking] = useState<string | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open) {
      setTaking(null);
      setNote("");
    }
  }, [open]);

  const give = useCallback((id: string, b: string | null) => {
    const { keys, took } = bindKey(useSettings.getState().keys, id, b);
    updateSettings({ keys });
    setTaking(null);
    setNote(b && took ? `${caps(b)} was on “${LABEL.get(took)}”, which has no key now.` : "");
  }, []);

  // the next key pressed goes to the command being changed: Backspace takes its key away, Esc leaves it
  useEffect(() => {
    if (!taking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Backspace" || e.key === "Delete") return give(taking, null);
      const b = bindingOf(e);
      if (!b) return;
      if (!validBinding(b)) return setNote(`${caps(b)} stays where it is. Try another key.`);
      give(taking, b);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [taking, give]);

  const close = useCallback(() => {
    // Esc while a key is being changed leaves it as it was
    if (taking) return setTaking(null);
    useUi.setState({ shortcutsOpen: false });
  }, [taking]);

  const preset = presetOf(user);
  const m = MOUSE_SCHEMES[scheme];
  const keysOf = (id: string, own: string[]) => user[id] ?? own;

  return (
    <Modal open={open} onClose={close} title="Keyboard shortcuts" icon={<Icon.Keyboard size={16} />} width={760}>
      <div className="modal-body">
        <div className="row" style={{ gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Keys
            </span>
            <select className="select" value={preset ?? "own"} onChange={(e) => (updateSettings({ keys: presetKeys(e.target.value) }), setNote(""))} aria-label="Key set">
              {KEY_PRESETS.map((p) => (
                <option key={p.id} value={p.id} title={p.d}>
                  {p.label}
                </option>
              ))}
              {!preset && <option value="own">Your own</option>}
            </select>
          </label>
          <label className="row" style={{ gap: 6 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Mouse
            </span>
            <select className="select" value={scheme} onChange={(e) => updateSettings({ mouseScheme: e.target.value as MouseScheme })} aria-label="Mouse scheme">
              {MOUSE_SCHEME_IDS.map((id) => (
                <option key={id} value={id}>
                  {MOUSE_SCHEMES[id].label}
                </option>
              ))}
            </select>
          </label>
          <div className="grow" />
          {preset !== "kerf" && (
            <button className="btn sm ghost" onClick={() => (updateSettings({ keys: {} }), setNote(""))}>
              <Icon.Refresh size={13} /> Kerf's keys
            </button>
          )}
        </div>
        <div className="dim" style={{ fontSize: 12, minHeight: 18, marginBottom: 4 }} role="status" aria-live="polite">
          {taking ? "Press the new key. Backspace leaves it with none, Esc keeps it as it was." : note || (preset ? KEY_PRESETS.find((p) => p.id === preset)?.d : "Click a key to change it.")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "6px 28px" }}>
          {GROUPS.map((g) => (
            <div key={g}>
              <div className="section-label" style={{ marginTop: 6 }}>
                {g}
              </div>
              {g === "General" && FIXED.map(([keys, label]) => (
                <Line key={label} label={label}>
                  <Keys keys={keys} />
                </Line>
              ))}
              {KEY_COMMANDS.filter((c) => c.group === g).map((c) => {
                const keys = keysOf(c.id, c.keys);
                const moved = !!user[c.id];
                return (
                  <Line key={c.id} label={c.label}>
                    <button
                      className={`key-take ${taking === c.id ? "taking" : ""}`}
                      onClick={() => (setTaking(taking === c.id ? null : c.id), setNote(""))}
                      aria-label={`${c.label}: ${keys.length ? keys.map(caps).join(" or ") : "no key"}. Change`}
                      data-tip="Change the key"
                    >
                      {taking === c.id ? <span className="dim">press a key…</span> : keys.length ? keys.map((k) => <Keys key={k} keys={keyCaps(k, isMac)} />) : <span className="dim">none</span>}
                    </button>
                    {moved && (
                      <button className="icon-btn sm" onClick={() => give(c.id, c.keys[0] ?? null)} aria-label={`Put ${c.label} back on ${c.keys.map(caps).join(" or ")}`} data-tip={`Back to ${c.keys.map(caps).join(" or ")}`}>
                        <Icon.Refresh size={12} />
                      </button>
                    )}
                  </Line>
                );
              })}
            </div>
          ))}
          <div>
            <div className="section-label" style={{ marginTop: 6 }}>
              Viewport mouse ({m.label})
            </div>
            {[...m.rows, ...MOUSE_COMMON].map(([keys, label]) => (
              <Line key={label} label={label}>
                <Keys keys={keys} />
              </Line>
            ))}
          </div>
          <div>
            <div className="section-label" style={{ marginTop: 6 }}>
              Chat and editor
            </div>
            {EDITOR.map(([keys, label]) => (
              <Line key={label} label={label}>
                <Keys keys={keys} />
              </Line>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
