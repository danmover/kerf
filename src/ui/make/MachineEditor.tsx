// The machine each process is checked against: a typical shop, a preset
// (a Prusa, a Bambu, a desktop router, a VMC...) or the user's own profile
// with its travel, tools, spindle, temperatures and so on. Parts are checked
// against these unless their process names another machine.

import { useState } from "react";
import { useSettings, updateSettings } from "../../app/settings";
import { PROCESSES, PROCESS_IDS, fmt, sortTools, MAX_TOOLS, type SettingDef } from "../../mfg/profiles";
import { fullAccess } from "../../mfg/availability";
import { MACHINE_PRESETS, machineSettings, newMachineId, type MachineProfile } from "../../mfg/machines";
import type { ProcessId, SettingValue, Tool } from "../../mfg/types";
import type { V3 } from "../../kernel/recipe";
import "../../styles/make.css";

const ORDER = ["additive", "subtractive", "sheet", "formative"];

export function MachineEditor() {
  const access = fullAccess(useSettings((s) => s.processAccess));
  const machines = useSettings((s) => s.machines);
  const machineFor = useSettings((s) => s.machineFor);
  const [open, setOpen] = useState<ProcessId | null>(null);
  const ids = ORDER.flatMap((f) => PROCESS_IDS.filter((id) => PROCESSES[id].family === f && access[id] !== "none" && machineSettings(id).length));

  const choose = (id: ProcessId, machine: string) => {
    const next = { ...machineFor };
    if (machine) next[id] = machine;
    else delete next[id];
    updateSettings({ machineFor: next });
  };
  /** A profile of the user's own, from a preset or the typical defaults, chosen for its process and opened. */
  const copy = (id: ProcessId, from?: MachineProfile) => {
    const m: MachineProfile = { id: newMachineId(), name: from ? `${from.name} (mine)` : `My ${PROCESSES[id].short}`, process: id, settings: { ...(from?.settings ?? {}) } };
    updateSettings({ machines: [...machines, m], machineFor: { ...machineFor, [id]: m.id } });
    setOpen(id);
  };
  const edit = (m: MachineProfile) => updateSettings({ machines: machines.map((x) => (x.id === m.id ? m : x)) });
  const remove = (m: MachineProfile) => {
    const next = { ...machineFor };
    for (const [k, v] of Object.entries(next)) if (v === m.id) delete next[k];
    updateSettings({ machines: machines.filter((x) => x.id !== m.id), machineFor: next });
  };

  return (
    <div className="machines">
      {ids.map((id) => {
        const mine = machines.filter((m) => m.process === id);
        const presets = MACHINE_PRESETS.filter((m) => m.process === id);
        const chosen = [...mine, ...presets].find((m) => m.id === machineFor[id]);
        const own = !!chosen && mine.includes(chosen);
        const isOpen = open === id;
        return (
          <div key={id} className={`machine-row ${isOpen ? "open" : ""}`}>
            <div className="machine-head">
              <span className="access-name">{PROCESSES[id].label}</span>
              <select value={chosen?.id ?? ""} onChange={(e) => choose(id, e.target.value)} aria-label={`Machine for ${PROCESSES[id].label}`}>
                <option value="">Typical shop</option>
                {mine.length > 0 && (
                  <optgroup label="Yours">
                    {mine.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Presets">
                  {presets.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <button className="btn ghost sm" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen}>
                {isOpen ? "Close" : "Details"}
              </button>
            </div>
            {isOpen && (
              <div className="machine-body">
                {chosen?.note && <div className="machine-note">{chosen.note}</div>}
                {own ? (
                  <label className="machine-field">
                    <span>Name</span>
                    <TextValue key={chosen.name} text={chosen.name} placeholder={`My ${PROCESSES[id].short}`} readOnly={false} parse={(t) => t.trim().slice(0, 60) || null} onCommit={(v) => typeof v === "string" && edit({ ...chosen, name: v })} />
                  </label>
                ) : (
                  <div className="machine-note">{chosen ? "A preset: make a copy to change it." : "Parts are checked against the usual values below. Make your own machine to change them."}</div>
                )}
                {machineSettings(id).map((sd) => (
                  <Field key={sd.key} sd={sd} value={chosen?.settings[sd.key]} readOnly={!own} onChange={(v) => own && edit({ ...chosen, settings: withValue(chosen.settings, sd.key, v) })} />
                ))}
                <div className="machine-actions">
                  {own ? (
                    <button className="btn danger sm" onClick={() => remove(chosen)}>
                      Delete this machine
                    </button>
                  ) : (
                    <button className="btn sm" onClick={() => copy(id, chosen)}>
                      {chosen ? "Make my own copy" : "Make my own machine"}
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function withValue(settings: Record<string, SettingValue>, key: string, v: SettingValue | undefined): Record<string, SettingValue> {
  const next = { ...settings };
  if (v === undefined) delete next[key];
  else next[key] = v;
  return next;
}

/** One machine setting; text fields commit on Enter or leaving them, so the checks re-run once per change. */
function Field({ sd, value, readOnly, onChange }: { sd: SettingDef; value: SettingValue | undefined; readOnly: boolean; onChange: (v: SettingValue | undefined) => void }) {
  const shown = value ?? sd.def ?? undefined;
  const label = <span data-tip={sd.doc}>{sd.key.replace(/_/g, " ")}</span>;
  if (sd.kind === "bool")
    return (
      <label className="machine-field">
        {label}
        <input type="checkbox" checked={!!shown} disabled={readOnly} onChange={(e) => onChange(e.target.checked)} />
      </label>
    );
  if (sd.kind === "choice")
    return (
      <label className="machine-field">
        {label}
        <select value={String(shown ?? "")} disabled={readOnly} onChange={(e) => onChange(e.target.value)}>
          {sd.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>
    );
  return (
    <label className="machine-field">
      {label}
      <TextValue key={JSON.stringify(shown ?? null)} text={toText(sd, shown)} placeholder={sd.kind === "tools" ? "6×25, 3×12, 1×4" : ""} readOnly={readOnly} parse={(t) => fromText(sd, t)} onCommit={onChange} />
      <small>{sd.doc}</small>
    </label>
  );
}

function TextValue({ text, placeholder, readOnly, parse, onCommit }: { text: string; placeholder: string; readOnly: boolean; parse: (t: string) => SettingValue | undefined | null; onCommit: (v: SettingValue | undefined) => void }) {
  const [draft, setDraft] = useState(text);
  const [bad, setBad] = useState(false);
  const commit = () => {
    if (draft === text) return;
    const v = parse(draft);
    setBad(v === null);
    if (v !== null) onCommit(v);
  };
  return (
    <input
      value={draft}
      placeholder={placeholder}
      readOnly={readOnly}
      className={bad ? "bad" : ""}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  );
}

function toText(sd: SettingDef, v: SettingValue | undefined): string {
  if (v === undefined || v === null) return "";
  if (sd.kind === "size") return (v as V3).map((x) => fmt(x)).join(" × ");
  if (sd.kind === "tools") return (v as Tool[]).map(([d, r]) => `${fmt(d, 3)}×${fmt(r)}`).join(", ");
  return typeof v === "number" ? fmt(v, 3) : String(v);
}

/** The value typed, undefined to clear it (back to the usual value), or null when it cannot be read. */
function fromText(sd: SettingDef, t: string): SettingValue | undefined | null {
  const s = t.trim();
  if (!s) return undefined;
  const nums = (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (sd.kind === "number") return nums.length === 1 && /^\d/.test(s) ? nums[0] : null;
  if (sd.kind === "size") return nums.length === 3 && nums.every((n) => n > 0) ? (nums as V3) : null;
  if (sd.kind === "tools") {
    if (!nums.length || nums.length % 2 || nums.length / 2 > MAX_TOOLS || nums.some((n) => n <= 0)) return null;
    const tools: Tool[] = [];
    for (let i = 0; i < nums.length; i += 2) tools.push([nums[i], nums[i + 1]]);
    return sortTools(tools);
  }
  return null;
}
