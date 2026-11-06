// The brief tab: what the design is for, what it must do, where it lives, how
// it is made, its limits, the fixed sizes it must meet and the references it
// came from. Everything here is written into the brief block of the design
// file, so Claude reads it, the checks use it, and undo covers it.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useDesign, meshes } from "../core/engine";
import { useView, revealSpan } from "../app/view";
import { useProject } from "../app/project";
import { useChat, sendMessage, briefKey } from "../ai/chat";
import { openSettings } from "../app/ui";
import {
  EXPOSURES,
  PRIORITIES,
  PROCESSES,
  briefChanges,
  briefData,
  briefHasErrors,
  confirmAssumption,
  emptyBrief,
  loadText,
  openAssumptions,
  processInfo,
  slugId,
  validId,
  type BriefData,
  type BriefUseData,
  type FieldKey,
} from "../core/brief";
import { assemblyStats } from "../core/briefChecks";
import type { CheckItem, CheckStatus } from "../core/checks";
import { MATERIALS } from "../library/standards";
import { BriefMaterialHint } from "./materials/BriefMaterialHint";
import { AccessEditor, accessSummary, useAccess } from "./make/AccessEditor";
import { fmtNum } from "../lang/values";
import type { V3 } from "../kernel/recipe";
import { Icon } from "./icons";
import { BIcon } from "./briefIcons";
import { Menu, MenuItem, Toggle } from "./common";
import { useChatDraft } from "./chatDraft";
import { editBrief, numOrUndef } from "./briefEdit";
import { RefThumb, openRef } from "./RefViewer";
import { openSketchPad } from "./SketchPad";
import { chatFile, storeFiles } from "./Attachments";
import { useApiKey } from "./ChatPanel";
import { ACCEPT } from "../persist/assets";
import type { ChatFile } from "../ai/chat";
import "../styles/brief.css";

const DIRS: { v: string; label: string; d: V3 }[] = [
  { v: "-Z", label: "down", d: [0, 0, -1] },
  { v: "Z", label: "up", d: [0, 0, 1] },
  { v: "X", label: "+X", d: [1, 0, 0] },
  { v: "-X", label: "−X", d: [-1, 0, 0] },
  { v: "Y", label: "+Y", d: [0, 1, 0] },
  { v: "-Y", label: "−Y", d: [0, -1, 0] },
];
const dirKey = (d?: V3) => DIRS.find((x) => d && x.d.every((c, i) => Math.abs(c - d[i]) < 1e-6))?.v ?? "";

export function BriefPanel() {
  const model = useDesign((s) => s.model);
  const source = useDesign((s) => s.source);
  const data = useMemo(() => briefData(model?.brief), [model]);
  const broken = briefHasErrors(source, model);

  if (broken)
    return (
      <div className="brief">
        <div className="banner error" style={{ borderRadius: 8 }}>
          <Icon.Alert size={14} />
          <span className="grow">The brief in the code has a typing error, so it can’t be edited here until that line is fixed.</span>
          <button
            className="btn sm"
            onClick={() => {
              const err = model?.diagnostics.find((d) => d.severity === "error");
              useView.setState({ dockTab: "code" });
              if (err) setTimeout(() => revealSpan({ start: err.start, end: err.end }), 30);
            }}
          >
            <Icon.Code size={13} /> Show in code
          </button>
        </div>
      </div>
    );
  if (!data) return <Intake hasParts={!!model?.parts.length} />;
  return (
    <div className="brief">
      <ChangeBar data={data} />
      <Header data={data} />
      <ToConfirm data={data} />
      <div className="brief-cols">
        <UsesCard data={data} />
        <RefsCard data={data} />
        <EnvCard data={data} />
        <MakeCard data={data} />
        <LimitsCard data={data} />
        <GivensCard data={data} />
        <NotesCard data={data} />
      </div>
    </div>
  );
}

// ---------- small editors ----------

function InlineText({
  value,
  placeholder,
  onSave,
  multiline,
  className,
  maxLength = 600,
  label,
}: {
  value?: string;
  placeholder: string;
  onSave: (v: string) => void;
  multiline?: boolean;
  className?: string;
  maxLength?: number;
  label: string;
}) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(value ?? "");
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  useEffect(() => {
    if (!edit) setText(value ?? "");
  }, [value, edit]);
  useEffect(() => {
    if (edit) requestAnimationFrame(() => ref.current?.select());
  }, [edit]);
  const done = (save: boolean) => {
    setEdit(false);
    if (save && text.trim() !== (value ?? "")) onSave(text.trim());
  };
  if (!edit)
    return (
      <button className={`inline-text ${value ? "" : "empty"} ${className ?? ""}`} onClick={() => setEdit(true)} aria-label={`Edit ${label}`}>
        {value || placeholder}
        <Icon.Edit size={11} className="inline-pen" />
      </button>
    );
  const props = {
    ref,
    className: `inline-edit ${className ?? ""}`,
    value: text,
    maxLength,
    placeholder,
    "aria-label": label,
    onChange: (e: React.ChangeEvent<HTMLInputElement & HTMLTextAreaElement>) => setText(e.target.value),
    onBlur: () => done(true),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && (!multiline || !e.shiftKey)) {
        e.preventDefault();
        done(true);
      }
      if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    },
  };
  return multiline ? <textarea rows={2} {...props} /> : <input {...props} />;
}

function NumField({ value, onCommit, placeholder, width = 64, label, suffix }: { value?: number; onCommit: (n: number | undefined) => void; placeholder?: string; width?: number; label: string; suffix?: string }) {
  const [text, setText] = useState(value === undefined ? "" : fmtNum(value, 2));
  useEffect(() => setText(value === undefined ? "" : fmtNum(value, 2)), [value]);
  const commit = () => {
    const n = numOrUndef(text);
    if (n === value || (n === undefined && text.trim())) return setText(value === undefined ? "" : fmtNum(value, 2));
    onCommit(n);
  };
  return (
    <span className="num-field">
      <input
        className="input mono"
        style={{ width }}
        inputMode="decimal"
        value={text}
        placeholder={placeholder}
        aria-label={label}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      />
      {suffix && <span className="dim mono">{suffix}</span>}
    </span>
  );
}

function VecField({ value, onCommit, placeholders, label }: { value?: V3; onCommit: (v: V3 | undefined) => void; placeholders?: V3; label: string }) {
  const set = (i: number, n: number | undefined) => {
    const base: (number | undefined)[] = value ? [...value] : [undefined, undefined, undefined];
    base[i] = n;
    if (base.every((x) => x === undefined)) return onCommit(undefined);
    const full = base.map((x, k) => x ?? value?.[k] ?? placeholders?.[k]);
    if (full.some((x) => x === undefined || !(x > 0))) return;
    onCommit(full as V3);
  };
  return (
    <span className="row" style={{ gap: 4 }}>
      {(["X", "Y", "Z"] as const).map((ax, i) => (
        <NumField key={ax} value={value?.[i]} placeholder={placeholders ? fmtNum(placeholders[i], 0) : ax} width={52} label={`${label} ${ax}`} onCommit={(n) => set(i, n)} />
      ))}
      <span className="dim mono">mm</span>
    </span>
  );
}

function Assumed({ field, data }: { field: FieldKey; data: BriefData }) {
  if (!data.assumed.includes(field)) return null;
  return (
    <button
      className="chip warn assumed-chip"
      onClick={() => editBrief((d) => Object.assign(d, confirmAssumption(d, "field", field)), `confirmed ${field.replace("_", " ")}`)}
      data-tip="Claude assumed this. Click to confirm it."
    >
      assumed <Icon.Check size={10} />
    </button>
  );
}

function Card({ title, icon, count, children, aside, id, onDrop }: { title: string; icon: ReactNode; count?: ReactNode; children: ReactNode; aside?: ReactNode; id: string; onDrop?: (files: File[]) => void }) {
  const [over, setOver] = useState(false);
  return (
    <section
      className={`brief-card ${over ? "drop-over" : ""}`}
      id={`brief-${id}`}
      onDragOver={
        onDrop &&
        ((e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setOver(true);
        })
      }
      onDragLeave={onDrop && ((e) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && setOver(false))}
      onDrop={
        onDrop &&
        ((e) => {
          setOver(false);
          const files = [...e.dataTransfer.files];
          if (!files.length) return;
          e.preventDefault();
          onDrop(files);
        })
      }
    >
      <header className="brief-card-head">
        <span className="brief-card-icon">{icon}</span>
        <span className="brief-card-title">{title}</span>
        {count !== undefined && (
          <span className="dim mono" style={{ fontSize: 11 }}>
            {count}
          </span>
        )}
        <span className="grow" />
        {aside}
      </header>
      {children}
    </section>
  );
}

const DOT: Record<CheckStatus, string> = {
  pass: "pass",
  fail: "fail",
  warn: "warn",
  pending: "pending",
  info: "info",
};

function useReportItems(prefix: string) {
  const report = useDesign((s) => s.report);
  return useMemo(() => {
    const m = new Map<string, CheckItem>();
    for (const i of report?.items ?? []) if (i.id.startsWith(prefix)) m.set(i.id.slice(prefix.length), i);
    return m;
  }, [report, prefix]);
}

const focusCheck = (id: string) => {
  const item = useDesign.getState().report?.items.find((i) => i.id === id);
  useView.setState({
    dockTab: "checks",
    dockOpen: true,
    focusCheck: id,
    focusParts: item?.parts ?? [],
  });
};

// ---------- the empty brief ----------

function Intake({ hasParts }: { hasParts: boolean }) {
  const key = useApiKey();
  const busy = useChat((s) => s.busy);
  const [purpose, setPurpose] = useState("");
  const [setting, setSetting] = useState("");
  const [process, setProcess] = useState<string>("");
  const [files, setFiles] = useState<ChatFile[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const addFiles = async (list: File[]) => {
    const recs = await storeFiles(list);
    setFiles((fs) => [...fs, ...recs.map(chatFile)]);
  };

  const save = (): boolean => {
    const err = editBrief((d) => {
      if (purpose.trim()) d.purpose = purpose.trim();
      if (setting.trim()) d.setting = setting.trim();
      if (process) d.process = process;
      files.forEach((f, i) => {
        const base = f.kind === "pdf" ? "doc" : /^sketch/i.test(f.name) ? "sketch" : "photo";
        let n = i + 1;
        while (d.refs.some((r) => r.id === `${base}${n}`)) n++;
        d.refs.push({
          id: `${base}${n}`,
          title: f.name.replace(/\.[a-z0-9]{2,5}$/i, ""),
          file: f.asset,
        });
      });
    }, "started the brief");
    return !err;
  };
  const design = () => {
    if (!key) return openSettings("ai");
    if (!save()) return;
    const ask = hasParts
      ? "I started the brief. Fill in the rest from what this design already does and what I wrote (mark what you infer as assumed), link the existing requirements to the uses, then tell me what you assumed."
      : `Here is what I need${purpose.trim() ? `: ${purpose.trim()}` : ""}.${setting.trim() ? ` It is used ${setting.trim().replace(/^used\s+/i, "")}.` : ""}${process ? ` I will make it by ${process}.` : ""} Fill in the rest of the brief with sensible assumptions marked as assumed, then design it.`;
    void sendMessage(ask, { files, design: true });
  };
  const ready = !!purpose.trim() || files.length > 0;

  return (
    <div className="brief">
      <div
        className={`brief-intake ${over ? "drop-over" : ""}`}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={(e) => !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node) && setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const list = [...e.dataTransfer.files];
          if (!list.length) return;
          e.preventDefault();
          void addFiles(list);
        }}
      >
        <div className="intake-head">
          <span className="brief-card-icon">
            <BIcon.Brief size={18} />
          </span>
          <div>
            <div className="intake-title">{hasParts ? "This design has no brief yet" : "Start with the brief"}</div>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Say what it’s for and where it’s used. Claude designs from the brief and Kerf turns it into checks. Anything you leave out, Claude assumes and marks for you to confirm.
            </div>
          </div>
        </div>
        <div className="intake-grid">
          <div>
            <label className="field-label" htmlFor="intake-purpose">
              What is it for?
            </label>
            <textarea id="intake-purpose" className="textarea" rows={3} maxLength={600} value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="Hold a 25 mm steel tube 40 mm off a workshop wall" />
          </div>
          <div>
            <label className="field-label" htmlFor="intake-setting">
              Where and how is it used?
            </label>
            <textarea
              id="intake-setting"
              className="textarea"
              rows={3}
              maxLength={600}
              value={setting}
              onChange={(e) => setSetting(e.target.value)}
              placeholder="Indoors, screwed into plywood, the tube is lifted out daily"
            />
          </div>
          <div>
            <div className="field-label">How will you make it?</div>
            <div className="chip-row">
              {PROCESSES.filter((p) => p.kind !== "other").map((p) => (
                <button key={p.kind} className={`chip pick ${process === p.label ? "accent" : ""}`} aria-pressed={process === p.label} onClick={() => setProcess(process === p.label ? "" : p.label)}>
                  {p.label}
                </button>
              ))}
            </div>
            <div className="field-label" style={{ marginTop: 12 }}>
              References
            </div>
            <div className="chip-row">
              {files.map((f) => (
                <span key={f.asset} className="attach-item">
                  <button className="attach-open" onClick={() => openRef({ file: f.asset, name: f.name })} aria-label={`Preview ${f.name}`}>
                    <RefThumb file={f.asset} kind={f.kind} size={40} title={f.name} />
                  </button>
                  <button className="attach-x" onClick={() => setFiles((fs) => fs.filter((x) => x.asset !== f.asset))} aria-label={`Remove ${f.name}`}>
                    <Icon.X size={10} />
                  </button>
                </span>
              ))}
              <input
                ref={input}
                type="file"
                accept={ACCEPT}
                multiple
                hidden
                onChange={(e) => {
                  const list = [...(e.target.files ?? [])];
                  e.target.value = "";
                  if (list.length) void addFiles(list);
                }}
              />
              <button className="btn sm" onClick={() => input.current?.click()}>
                <BIcon.Image size={13} /> Photo or PDF
              </button>
              <button className="btn sm" onClick={() => openSketchPad((r) => setFiles((fs) => [...fs, chatFile(r)]))}>
                <BIcon.Pen size={13} /> Sketch
              </button>
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" disabled={busy || (!ready && !hasParts)} onClick={design}>
            <Icon.Sparkle size={14} /> {!key ? "Add your API key to design with Claude" : hasParts ? "Ask Claude to write the brief" : "Design it with Claude"}
          </button>
          <button className="btn" disabled={!ready && !process} onClick={() => save()}>
            Save the brief
          </button>
          <button className="btn ghost" onClick={() => editBrief((d) => Object.assign(d, emptyBrief()), "added an empty brief")}>
            Fill it in myself
          </button>
          <span className="grow" />
          <span className="dim" style={{ fontSize: 11.5 }}>
            Drop photos, sketches or PDFs anywhere here
          </span>
        </div>
      </div>
    </div>
  );
}

// ---------- after Claude's last turn ----------

function ChangeBar({ data }: { data: BriefData }) {
  const seen = useChat((s) => s.briefSeen);
  const busy = useChat((s) => s.busy);
  const key = useApiKey();
  const changes = useMemo(() => (seen !== null && seen !== briefKey(data) ? briefChanges(seen ? JSON.parse(seen) : null, data) : []), [seen, data]);
  if (!key || busy || !changes.length) return null;
  return (
    <motion.div className="brief-change" initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
      <Icon.Edit size={13} />
      <span className="grow">
        You changed the brief: {changes.slice(0, 3).join("; ")}
        {changes.length > 3 ? ` and ${changes.length - 3} more` : ""}.
      </span>
      <button className="btn sm primary" onClick={() => void sendMessage("I changed the brief. Update the design to match, and tell me what you changed.", { design: true })}>
        <Icon.Sparkle size={13} /> Update the design
      </button>
    </motion.div>
  );
}

// ---------- purpose, setting, priorities, coverage ----------

function Header({ data }: { data: BriefData }) {
  const uses = useReportItems("use:");
  const report = useDesign((s) => s.report);
  const setDraft = useChatDraft((s) => s.set);
  const covered = data.uses.filter((u) => uses.get(u.id)?.status === "pass").length;
  const briefFails = (report?.items ?? []).filter((i) => i.category === "brief" && i.status === "fail").length;
  const pct = data.uses.length ? covered / data.uses.length : 0;
  const addPriority = (p: string) => editBrief((d) => void (d.priorities.includes(p) || d.priorities.push(p)), `priority ${p}`);
  return (
    <div className="brief-header">
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
          <InlineText className="brief-purpose" value={data.purpose} placeholder="What is it for?" label="purpose" multiline onSave={(v) => editBrief((d) => void (d.purpose = v || undefined), "purpose")} />
          <Assumed field="purpose" data={data} />
        </div>
        <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
          <InlineText
            className="brief-setting"
            value={data.setting}
            placeholder="Where and how is it used, and by whom?"
            label="setting"
            multiline
            onSave={(v) => editBrief((d) => void (d.setting = v || undefined), "where it is used")}
          />
          <Assumed field="setting" data={data} />
        </div>
        <div className="chip-row" style={{ marginTop: 8 }}>
          <span className="field-label" style={{ margin: 0 }}>
            Priorities
          </span>
          {data.priorities.map((p, i) => (
            <span key={p} className="chip accent priority">
              <b>{i + 1}</b> {p}
              {i > 0 && (
                <button
                  aria-label={`Move ${p} up`}
                  onClick={() =>
                    editBrief((d) => {
                      const k = d.priorities.indexOf(p);
                      if (k > 0) [d.priorities[k - 1], d.priorities[k]] = [d.priorities[k], d.priorities[k - 1]];
                    }, `moved ${p} up`)
                  }
                >
                  ↑
                </button>
              )}
              <button aria-label={`Remove ${p}`} onClick={() => editBrief((d) => void (d.priorities = d.priorities.filter((x) => x !== p)), `removed priority ${p}`)}>
                <Icon.X size={9} />
              </button>
            </span>
          ))}
          <Menu
            width={220}
            trigger={(_, toggle) => (
              <button className="chip pick" onClick={toggle} aria-label="Add a priority">
                <Icon.Plus size={10} /> add
              </button>
            )}
          >
            {(close) => (
              <>
                {PRIORITIES.filter((p) => !data.priorities.includes(p)).map((p) => (
                  <MenuItem
                    key={p}
                    onClick={() => {
                      close();
                      addPriority(p);
                    }}
                  >
                    {p}
                  </MenuItem>
                ))}
              </>
            )}
          </Menu>
          <Assumed field="priorities" data={data} />
        </div>
      </div>
      <div className="brief-cover">
        <div className="row" style={{ gap: 10 }}>
          <svg width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
            <circle cx="22" cy="22" r="18" fill="none" stroke="var(--line-2)" strokeWidth="4" />
            <motion.circle
              cx="22"
              cy="22"
              r="18"
              fill="none"
              stroke={pct === 1 ? "var(--pass)" : "var(--accent)"}
              strokeWidth="4"
              strokeLinecap="round"
              transform="rotate(-90 22 22)"
              strokeDasharray={2 * Math.PI * 18}
              initial={false}
              animate={{ strokeDashoffset: 2 * Math.PI * 18 * (1 - pct) }}
              transition={{ type: "spring", stiffness: 120, damping: 20 }}
            />
          </svg>
          <div>
            <div style={{ fontWeight: 600, fontSize: 13 }}>{data.uses.length ? `${covered} of ${data.uses.length} uses pass` : "No uses yet"}</div>
            <div className="dim" style={{ fontSize: 11.5 }}>
              {briefFails ? (
                <button className="link-btn fail" onClick={() => useView.setState({ dockTab: "checks" })}>
                  {briefFails} brief check{briefFails > 1 ? "s" : ""} failing
                </button>
              ) : data.uses.length ? (
                "each use is checked by its requirements"
              ) : (
                "add what it must do below"
              )}
            </div>
          </div>
        </div>
        <button className="btn sm ghost" onClick={() => setDraft("Review the brief: fill the gaps with sensible assumptions, make sure every use is covered by a check, and tell me what you assumed.")}>
          <Icon.Sparkle size={13} /> Ask Claude to fill gaps
        </button>
      </div>
    </div>
  );
}

function ToConfirm({ data }: { data: BriefData }) {
  const open = openAssumptions(data);
  if (!open.length) return null;
  const confirmAll = () =>
    editBrief(
      (d) => {
        let n = d;
        for (const o of open) n = confirmAssumption(n, o.kind, o.key);
        Object.assign(d, n);
      },
      `confirmed ${open.length} assumption${open.length > 1 ? "s" : ""}`,
    );
  const drop = (o: (typeof open)[number]) =>
    editBrief((d) => {
      if (o.kind === "field") {
        const keyMap: Record<string, keyof BriefData> = {
          build_volume: "buildVolume",
          max_size: "maxSize",
          max_mass: "maxMass",
        };
        const prop = (keyMap[o.key] ?? o.key) as keyof BriefData;
        if (prop === "priorities" || prop === "exposure") d[prop] = [];
        else delete (d as unknown as Record<string, unknown>)[prop];
        d.assumed = d.assumed.filter((k) => k !== o.key);
      }
      if (o.kind === "use") d.uses = d.uses.filter((u) => u.id !== o.key);
      if (o.kind === "given") d.givens = d.givens.filter((g) => g.name !== o.key);
      if (o.kind === "note") d.assumptions = d.assumptions.filter((a) => a.text !== o.key);
    }, `dropped ${o.label}`);
  return (
    <div className="brief-confirm">
      <div className="row" style={{ marginBottom: 6 }}>
        <span style={{ color: "var(--warn)", display: "inline-grid" }}>
          <BIcon.Flag size={14} />
        </span>
        <span style={{ fontWeight: 600 }}>
          {open.length} assumption{open.length > 1 ? "s" : ""} to confirm
        </span>
        <span className="dim" style={{ fontSize: 12 }}>
          Confirm each one, change it below, or drop it.
        </span>
        <span className="grow" />
        <button className="btn sm" onClick={confirmAll}>
          <Icon.Check size={13} /> Confirm all
        </button>
      </div>
      <div className="confirm-list">
        <AnimatePresence initial={false}>
          {open.map((o) => (
            <motion.div key={`${o.kind}:${o.key}`} className="confirm-item" layout initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
              <span
                className="mono dim"
                style={{
                  fontSize: 10.5,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                }}
              >
                {o.label}
              </span>
              <span className="grow" style={{ minWidth: 0 }}>
                {o.value}
              </span>
              <button className="icon-btn sm" onClick={() => editBrief((d) => Object.assign(d, confirmAssumption(d, o.kind, o.key)), `confirmed ${o.label}`)} aria-label={`Confirm ${o.label}`} data-tip="Confirm">
                <Icon.Check size={13} />
              </button>
              <button className="icon-btn sm" onClick={() => drop(o)} aria-label={`Drop ${o.label}`} data-tip="Drop">
                <Icon.X size={12} />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------- uses ----------

function UsesCard({ data }: { data: BriefData }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t) return;
    const id = slugId(
      t,
      data.uses.map((u) => u.id),
    );
    if (!editBrief((d) => void d.uses.push({ id, text: t, assumed: false }), `added use “${t}”`)) setText("");
  };
  return (
    <Card id="uses" title="What it must do" icon={<BIcon.Pin size={14} />} count={data.uses.length || undefined}>
      <div className="use-list">
        {data.uses.map((u) => (
          <UseRow key={u.id} u={u} />
        ))}
        {!data.uses.length && <div className="dim brief-empty">Each thing it must do or survive: hold a load, fit through a gap, clip on without tools. Each one becomes a check.</div>}
      </div>
      <div className="brief-add">
        <input className="input" value={text} maxLength={300} placeholder="Add something it must do…" aria-label="New use" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
        <button className="btn sm" onClick={add} disabled={!text.trim()}>
          <Icon.Plus size={12} /> Add
        </button>
      </div>
    </Card>
  );
}

function UseRow({ u }: { u: BriefUseData }) {
  const items = useReportItems("use:");
  const model = useDesign((s) => s.model);
  const setDraft = useChatDraft((s) => s.set);
  const [loadOpen, setLoadOpen] = useState(false);
  const item = items.get(u.id);
  const reqs = (model?.requirements ?? []).filter((r) => r.uses.includes(u.id));
  const status: CheckStatus = item?.status ?? "pending";
  const set = (fn: (x: BriefUseData) => void, msg: string) =>
    editBrief((d) => {
      const x = d.uses.find((y) => y.id === u.id);
      if (x) fn(x);
    }, msg);
  return (
    <motion.div className="use-row" layout="position">
      <span className={`dot ${DOT[status]}`} style={{ marginTop: 6 }} title={item?.detail} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 6, alignItems: "flex-start" }}>
          <InlineText className="use-text" value={u.text} placeholder="Describe the use" label={`use ${u.id}`} onSave={(v) => v && set((x) => void (x.text = v), `use ${u.id} text`)} />
          {u.assumed && (
            <button className="chip warn assumed-chip" onClick={() => set((x) => void (x.assumed = false), `confirmed use “${u.text}”`)} data-tip="Claude assumed this use. Click to confirm it.">
              assumed <Icon.Check size={10} />
            </button>
          )}
        </div>
        <div className="chip-row" style={{ marginTop: 4 }}>
          <button className={`chip pick ${u.load !== undefined ? "accent" : ""}`} onClick={() => setLoadOpen((o) => !o)} aria-expanded={loadOpen}>
            {u.load !== undefined ? (
              <>⤓ {loadText(u)}</>
            ) : (
              <>
                <Icon.Plus size={10} /> load
              </>
            )}
          </button>
          {u.cycles ? <span className="chip">{u.cycles.toLocaleString()}×</span> : null}
          {reqs.map((r) => (
            <button key={r.label} className={`chip pick req-chip ${r.status === "fail" ? "fail" : r.status === "pass" ? "pass" : ""}`} onClick={() => focusCheck(`req:${r.label}`)} data-tip="Show this check">
              {r.label}
            </button>
          ))}
          {!reqs.length && (
            <button className="chip pick" onClick={() => setDraft(`Add a requirement that checks the use “${u.text}” (${u.id}), linked with for ${u.id}.`)} data-tip="Ask Claude to write a check for this use">
              <Icon.Sparkle size={10} /> add a check
            </button>
          )}
          <span className="grow" />
          <Menu
            align="right"
            width={200}
            trigger={(_, toggle) => (
              <button className="icon-btn sm row-more" onClick={toggle} aria-label={`More for ${u.id}`}>
                <Icon.More size={13} />
              </button>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<Icon.Code size={14} />}
                  onClick={() => {
                    close();
                    const span = model?.brief?.uses.find((x) => x.id === u.id)?.span;
                    useView.setState({ dockTab: "code" });
                    if (span) setTimeout(() => revealSpan(span), 30);
                  }}
                >
                  Show in code
                </MenuItem>
                <MenuItem
                  danger
                  icon={<Icon.Trash size={14} />}
                  onClick={() => {
                    close();
                    editBrief((d) => void (d.uses = d.uses.filter((x) => x.id !== u.id)), `removed use “${u.text}”`);
                  }}
                >
                  Remove
                </MenuItem>
              </>
            )}
          </Menu>
        </div>
        <AnimatePresence>{loadOpen && <LoadEditor u={u} onDone={() => setLoadOpen(false)} />}</AnimatePresence>
        {item && item.status !== "pass" && item.status !== "pending" && <div className="use-detail">{item.detail}</div>}
      </div>
    </motion.div>
  );
}

function LoadEditor({ u, onDone }: { u: BriefUseData; onDone: () => void }) {
  const model = useDesign((s) => s.model);
  const [value, setValue] = useState(u.load === undefined ? "" : fmtNum(u.load, 2));
  const [unit, setUnit] = useState<"N" | "kg">("N");
  const [dir, setDir] = useState(dirKey(u.dir) || "-Z");
  const [on, setOn] = useState(u.on ?? "");
  const [cycles, setCycles] = useState(u.cycles ? String(u.cycles) : "");
  const names = [...new Set((model?.parts ?? []).map((p) => p.name))];
  const save = () => {
    const v = numOrUndef(value);
    const c = numOrUndef(cycles);
    const err = editBrief((d) => {
      const x = d.uses.find((y) => y.id === u.id);
      if (!x) return;
      x.load = v !== undefined && v > 0 ? (unit === "kg" ? v * 9.81 : v) : undefined;
      x.dir = x.load !== undefined ? DIRS.find((q) => q.v === dir)?.d : undefined;
      x.on = on || undefined;
      x.cycles = c && c >= 1 ? Math.round(c) : undefined;
    }, `load on “${u.text}”`);
    if (!err) onDone();
  };
  return (
    <motion.div className="load-editor" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
      <div className="row" style={{ flexWrap: "wrap", gap: 6, paddingTop: 8 }}>
        <input
          className="input mono"
          style={{ width: 72 }}
          value={value}
          inputMode="decimal"
          placeholder="load"
          aria-label="Load"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
          autoFocus
        />
        <select className="select" style={{ width: 64 }} value={unit} onChange={(e) => setUnit(e.target.value as "N" | "kg")} aria-label="Unit">
          <option value="N">N</option>
          <option value="kg">kg</option>
        </select>
        <select className="select" style={{ width: 84 }} value={dir} onChange={(e) => setDir(e.target.value)} aria-label="Direction">
          {DIRS.map((d) => (
            <option key={d.v} value={d.v}>
              {d.label}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 120 }} value={on} onChange={(e) => setOn(e.target.value)} aria-label="Acts on">
          <option value="">on (any part)</option>
          {names.map((n) => (
            <option key={n} value={n}>
              on {n}
            </option>
          ))}
          {on && !names.includes(on) && <option value={on}>on {on}</option>}
        </select>
        <input
          className="input mono"
          style={{ width: 90 }}
          value={cycles}
          inputMode="numeric"
          placeholder="times"
          aria-label="How many times"
          onChange={(e) => setCycles(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && save()}
        />
        <button className="btn sm primary" onClick={save}>
          Save
        </button>
        <button className="btn sm ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
      <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
        A mass in kg is stored as its weight (1 kg = 9.81 N). Times is how often it happens over the part’s life.
      </div>
    </motion.div>
  );
}

// ---------- environment ----------

function EnvCard({ data }: { data: BriefData }) {
  const toggleExposure = (e: string) =>
    editBrief(
      (d) => {
        d.exposure = d.exposure.includes(e) ? d.exposure.filter((x) => x !== e) : [...d.exposure, e];
        d.assumed = d.assumed.filter((k) => k !== "exposure");
      },
      `${data.exposure.includes(e) ? "no longer exposed to" : "exposed to"} ${e}`,
    );
  const exposures = [...new Set([...EXPOSURES, ...data.exposure])];
  return (
    <Card id="env" title="Where it lives" icon={<BIcon.Thermo size={14} />}>
      <div className="brief-field">
        <span className="brief-label">Temperature</span>
        <NumField
          value={data.temp?.[0]}
          placeholder="low"
          width={56}
          label="Lowest temperature"
          onCommit={(n) => editBrief((d) => void (d.temp = n === undefined ? undefined : [Math.min(n, d.temp?.[1] ?? n), Math.max(n, d.temp?.[1] ?? n)]), "temperature range")}
        />
        <span className="dim">to</span>
        <NumField
          value={data.temp?.[1]}
          placeholder="high"
          width={56}
          label="Highest temperature"
          suffix="°C"
          onCommit={(n) => editBrief((d) => void (d.temp = n === undefined ? undefined : [Math.min(n, d.temp?.[0] ?? n), Math.max(n, d.temp?.[0] ?? n)]), "temperature range")}
        />
        <Assumed field="temp" data={data} />
      </div>
      <div className="brief-field">
        <span className="brief-label">Outdoors</span>
        <Toggle on={!!data.outdoor} label="Outdoors" onChange={(v) => editBrief((d) => void ((d.outdoor = v), (d.assumed = d.assumed.filter((k) => k !== "outdoor"))), v ? "outdoors" : "indoors")} />
        <span className="dim" style={{ fontSize: 11.5 }}>
          {data.outdoor === undefined ? "not set" : data.outdoor ? "sun and rain" : "indoors"}
        </span>
        <Assumed field="outdoor" data={data} />
      </div>
      <div className="brief-label" style={{ margin: "8px 0 6px" }}>
        Exposed to <Assumed field="exposure" data={data} />
      </div>
      <div className="chip-row">
        {exposures.map((e) => (
          <button key={e} className={`chip pick ${data.exposure.includes(e) ? "accent" : ""}`} aria-pressed={data.exposure.includes(e)} onClick={() => toggleExposure(e)}>
            {e}
          </button>
        ))}
      </div>
    </Card>
  );
}

// ---------- making ----------

function MakeCard({ data }: { data: BriefData }) {
  const info = processInfo(data.process);
  const materials = [...new Set([...Object.keys(MATERIALS), ...(data.material ? [data.material] : [])])];
  const processes = [...new Set([...PROCESSES.map((p) => p.label), ...(data.process ? [data.process] : [])])];
  const field = (k: FieldKey, apply: (d: BriefData) => void, msg: string) =>
    editBrief((d) => {
      apply(d);
      d.assumed = d.assumed.filter((x) => x !== k);
    }, msg);
  return (
    <Card id="make" title="How it’s made" icon={<BIcon.Hammer size={14} />}>
      <div className="brief-field">
        <span className="brief-label">Process</span>
        <select
          className="select"
          style={{ maxWidth: 190 }}
          value={data.process ?? ""}
          aria-label="Process"
          onChange={(e) => field("process", (d) => void (d.process = e.target.value || undefined), `process ${e.target.value || "cleared"}`)}
        >
          <option value="">not set</option>
          {processes.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <Assumed field="process" data={data} />
      </div>
      <div className="brief-field">
        <span className="brief-label">Material</span>
        <select
          className="select"
          style={{ maxWidth: 190 }}
          value={data.material ?? ""}
          aria-label="Material"
          onChange={(e) => field("material", (d) => void (d.material = e.target.value || undefined), `material ${e.target.value || "cleared"}`)}
        >
          <option value="">not set</option>
          {materials.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <Assumed field="material" data={data} />
      </div>
      <BriefMaterialHint data={data} />
      <div className="brief-field">
        <span className="brief-label">Quantity</span>
        <NumField value={data.quantity} placeholder="1" width={64} label="Quantity" onCommit={(n) => field("quantity", (d) => void (d.quantity = n && n >= 1 ? Math.round(n) : undefined), "quantity")} />
        <Assumed field="quantity" data={data} />
      </div>
      {info?.print && (
        <div className="brief-field">
          <span className="brief-label">Build volume</span>
          <VecField value={data.buildVolume} placeholders={info.volume} label="Build volume" onCommit={(v) => field("build_volume", (d) => void (d.buildVolume = v), "build volume")} />
          <Assumed field="build_volume" data={data} />
        </div>
      )}
      <div className="brief-field" style={{ alignItems: "flex-start" }}>
        <span className="brief-label" style={{ paddingTop: 3 }}>
          Look
        </span>
        <InlineText value={data.look} placeholder="Finish, colour, style" label="look" onSave={(v) => field("look", (d) => void (d.look = v || undefined), "look")} />
        <Assumed field="look" data={data} />
      </div>
      <ProcessAccessField />
    </Card>
  );
}

/** Which processes this design can use: a summary, opening the editor in place. */
function ProcessAccessField() {
  const { access, fromBrief } = useAccess();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="brief-field">
        <span className="brief-label">Processes</span>
        <button className="link-btn" onClick={() => setOpen(!open)} aria-expanded={open} data-tip={fromBrief ? "Set in this brief (workshop: and can_order:)" : "Your usual processes, from Settings → Making"}>
          {accessSummary(access)}
          {fromBrief ? "" : " (your usual)"}
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div style={{ overflow: "hidden" }} initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
            <div style={{ padding: "6px 0 4px" }}>
              <AccessEditor compact />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

// ---------- limits ----------

function LimitsCard({ data }: { data: BriefData }) {
  const model = useDesign((s) => s.model);
  const reportRev = useDesign((s) => s.reportRev);
  const items = useReportItems("brief-");
  const stats = useMemo(() => (model ? assemblyStats(model, (h) => meshes.get(h)) : null), [model, reportRev]);
  const size = items.get("size");
  const mass = items.get("mass");
  return (
    <Card id="limits" title="Limits" icon={<BIcon.Ruler size={14} />}>
      <div className="brief-field">
        <span className="brief-label">Fits in</span>
        <VecField value={data.maxSize} label="Maximum size" onCommit={(v) => editBrief((d) => void ((d.maxSize = v), (d.assumed = d.assumed.filter((k) => k !== "max_size"))), "maximum size")} />
        <Assumed field="max_size" data={data} />
      </div>
      <div className={`brief-now ${size?.status ?? ""}`}>
        {stats?.size ? `Now ${stats.size.map((x) => fmtNum(x, 1)).join(" × ")} mm` : "Size appears once the model is built"}
        {size && size.status === "fail" && <> · {size.detail.replace(/^Now [^.]*\.?\s*/, "")}</>}
      </div>
      <div className="brief-field">
        <span className="brief-label">Mass under</span>
        <NumField
          value={data.maxMass}
          placeholder="—"
          width={72}
          suffix="g"
          label="Maximum mass"
          onCommit={(n) => editBrief((d) => void ((d.maxMass = n && n > 0 ? n : undefined), (d.assumed = d.assumed.filter((k) => k !== "max_mass"))), "maximum mass")}
        />
        <Assumed field="max_mass" data={data} />
      </div>
      <div className={`brief-now ${mass?.status ?? ""}`}>
        {stats?.mass !== undefined ? `Now ${fmtNum(stats.mass, 1)} g` : "Mass appears once the model is built"}
        {stats?.heaviest.length ? (
          <span className="dim">
            {" "}
            · heaviest{" "}
            {stats.heaviest
              .slice(0, 2)
              .map((h) => `${h.label} ${fmtNum(h.mass, 0)} g`)
              .join(", ")}
          </span>
        ) : null}
      </div>
    </Card>
  );
}

// ---------- givens ----------

function GivensCard({ data }: { data: BriefData }) {
  const model = useDesign((s) => s.model);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [desc, setDesc] = useState("");
  const taken = new Set([...(model?.params.map((p) => p.name) ?? []), ...data.givens.map((g) => g.name)]);
  const nameErr = name && !validId(name) ? "letters, digits and _" : taken.has(name) ? "name in use" : "";
  const add = () => {
    if (!name || nameErr || !value.trim()) return;
    const v = /^-?\d+(\.\d+)?$/.test(value.trim()) ? `${value.trim()}mm` : value.trim();
    if (
      !editBrief(
        (d) =>
          void d.givens.push({
            name,
            text: v,
            desc: desc.trim() || undefined,
            assumed: false,
          }),
        `added ${name} = ${v}`,
      )
    ) {
      setName("");
      setValue("");
      setDesc("");
    }
  };
  return (
    <Card id="givens" title="Fixed sizes" icon={<Icon.Lock size={13} />} count={data.givens.length || undefined}>
      {data.givens.length ? (
        <div className="given-list">
          {data.givens.map((g) => {
            const used = model?.brief?.givens.find((x) => x.name === g.name)?.usedBy ?? [];
            const set = (fn: (x: (typeof data.givens)[number]) => void, msg: string) =>
              editBrief((d) => {
                const x = d.givens.find((y) => y.name === g.name);
                if (x) fn(x);
              }, msg);
            return (
              <div key={g.name} className="given-row">
                <span className="given-head">
                  <span className="mono given-name">{g.name}</span>
                  <span className="dim mono">=</span>
                  <InlineText
                    className="mono given-value"
                    value={g.text}
                    placeholder="value"
                    label={`${g.name} value`}
                    maxLength={60}
                    onSave={(v) => v && set((x) => void (x.text = /^-?\d+(\.\d+)?$/.test(v) ? `${v}mm` : v), `${g.name} ${g.text} → ${v}`)}
                  />
                  {g.assumed && (
                    <button className="chip warn assumed-chip" onClick={() => set((x) => void (x.assumed = false), `confirmed ${g.name}`)} data-tip="Claude estimated this. Click to confirm it.">
                      assumed <Icon.Check size={10} />
                    </button>
                  )}
                </span>
                <span className="given-desc-cell">
                  <InlineText className="given-desc" value={g.desc} placeholder="what it is" label={`${g.name} description`} onSave={(v) => set((x) => void (x.desc = v || undefined), `${g.name} description`)} />
                </span>
                <span className={`chip given-used ${used.length ? "" : "warn"}`} data-tip={used.length ? `Used by ${used.join(", ")}` : "Nothing in the design uses this yet"}>
                  {used.length ? `used ${used.length}×` : "unused"}
                </span>
                <button
                  className="icon-btn sm row-more given-del"
                  aria-label={`Remove ${g.name}`}
                  data-tip={used.length ? "Still used by the design" : "Remove"}
                  disabled={used.length > 0}
                  onClick={() => editBrief((d) => void (d.givens = d.givens.filter((x) => x.name !== g.name)), `removed ${g.name}`)}
                >
                  <Icon.Trash size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="dim brief-empty">Sizes of the things it meets: the tube it clamps, the board it holds, the hole spacing it bolts to. The design reads them by name and the solver never changes them.</div>
      )}
      <div className="brief-add">
        <input
          className="input mono"
          style={{ width: 110 }}
          value={name}
          maxLength={40}
          placeholder="tube_d"
          aria-label="New given name"
          onChange={(e) => setName(e.target.value.replace(/\s+/g, "_"))}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <input
          className="input mono"
          style={{ width: 80 }}
          value={value}
          maxLength={40}
          placeholder="25mm"
          aria-label="New given value"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <input
          className="input"
          value={desc}
          maxLength={200}
          placeholder="what it is (optional)"
          aria-label="New given description"
          onChange={(e) => setDesc(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn sm" onClick={add} disabled={!name || !!nameErr || !value.trim()} data-tip={nameErr || undefined}>
          <Icon.Plus size={12} /> Add
        </button>
      </div>
    </Card>
  );
}

// ---------- references ----------

function RefsCard({ data }: { data: BriefData }) {
  const projectId = useProject((s) => s.current?.id);
  const input = useRef<HTMLInputElement>(null);
  const [link, setLink] = useState<{ url: string; title: string } | null>(null);
  const addFiles = async (list: File[]) => {
    const recs = await storeFiles(list);
    if (!recs.length) return;
    editBrief(
      (d) => {
        for (const r of recs) {
          const base = r.kind === "pdf" ? "doc" : /^sketch/i.test(r.name) ? "sketch" : "photo";
          let n = 1;
          while (d.refs.some((x) => x.id === `${base}${n}`)) n++;
          d.refs.push({
            id: `${base}${n}`,
            title:
              r.name
                .replace(/\.[a-z0-9]{2,5}$/i, "")
                .replace(/[_-]+/g, " ")
                .trim() || base,
            file: r.id,
          });
        }
      },
      `added ${recs.length} reference${recs.length > 1 ? "s" : ""}`,
    );
  };
  const addLink = () => {
    if (!link) return;
    const url = link.url.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    const title = link.title.trim() || url.replace(/^https?:\/\/(www\.)?/i, "").split("/")[0];
    let n = 1;
    while (data.refs.some((x) => x.id === `link${n}`)) n++;
    if (!editBrief((d) => void d.refs.push({ id: `link${n}`, title, url }), `added link “${title}”`)) setLink(null);
  };
  return (
    <Card
      id="refs"
      title="References"
      icon={<BIcon.Image size={14} />}
      count={data.refs.length || undefined}
      onDrop={(f) => void addFiles(f)}
      aside={
        <>
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => {
              const list = [...(e.target.files ?? [])];
              e.target.value = "";
              if (list.length) void addFiles(list);
            }}
          />
          <button className="icon-btn sm" disabled={!projectId} onClick={() => input.current?.click()} aria-label="Add a photo or PDF" data-tip="Add a photo or PDF">
            <Icon.Upload size={13} />
          </button>
          <button
            className="icon-btn sm"
            onClick={() =>
              openSketchPad((r) =>
                editBrief((d) => {
                  let n = 1;
                  while (d.refs.some((x) => x.id === `sketch${n}`)) n++;
                  d.refs.push({
                    id: `sketch${n}`,
                    title: "Sketch",
                    file: r.id,
                  });
                }, "added a sketch"),
              )
            }
            aria-label="Draw a sketch"
            data-tip="Draw a sketch"
          >
            <BIcon.Pen size={13} />
          </button>
          <button className="icon-btn sm" onClick={() => setLink(link ? null : { url: "", title: "" })} aria-label="Add a link" data-tip="Add a link">
            <BIcon.Link size={13} />
          </button>
        </>
      }
    >
      {link && (
        <div className="brief-add" style={{ marginTop: 0, marginBottom: 8 }}>
          <input
            className="input"
            autoFocus
            value={link.url}
            placeholder="https://…"
            aria-label="Link address"
            onChange={(e) => setLink({ ...link, url: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && addLink()}
          />
          <input
            className="input"
            style={{ width: 140 }}
            value={link.title}
            placeholder="title"
            aria-label="Link title"
            onChange={(e) => setLink({ ...link, title: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && addLink()}
          />
          <button className="btn sm" disabled={!/^https?:\/\/\S+$/i.test(link.url.trim())} onClick={addLink}>
            Add
          </button>
        </div>
      )}
      {data.refs.length ? (
        <div className="ref-grid">
          {data.refs.map((r) => (
            <button key={r.id} className="ref-tile" onClick={() => openRef({ ref: r.id })} data-tip={r.notes ? r.notes.slice(0, 160) : undefined}>
              <RefThumb file={r.file} kind={r.file ? undefined : "link"} size={64} title={r.title} />
              <span className="ref-title">{r.title}</span>
              <span className="mono dim" style={{ fontSize: 9.5 }}>
                {r.id}
                {r.notes ? " · notes" : ""}
              </span>
            </button>
          ))}
        </div>
      ) : (
        <div className="dim brief-empty">Drop photos of the space it fits, the parts it meets, sketches with sizes, or PDF drawings. Claude looks at them and records what it reads.</div>
      )}
    </Card>
  );
}

// ---------- assumptions and notes ----------

function NotesCard({ data }: { data: BriefData }) {
  const [text, setText] = useState("");
  const add = () => {
    const t = text.trim();
    if (!t || data.assumptions.some((a) => a.text === t)) return;
    if (!editBrief((d) => void d.assumptions.push({ text: t, confirmed: true }), `noted “${t}”`)) setText("");
  };
  return (
    <Card id="notes" title="Assumptions and notes" icon={<BIcon.Note size={14} />} count={data.assumptions.length || undefined}>
      {data.assumptions.map((a) => (
        <div key={a.text} className="note-row">
          <span
            style={{
              color: a.confirmed ? "var(--pass)" : "var(--warn)",
              display: "inline-grid",
              marginTop: 2,
            }}
          >
            {a.confirmed ? <Icon.Check size={12} /> : <BIcon.Flag size={12} />}
          </span>
          <span className="grow">{a.text}</span>
          {!a.confirmed && (
            <button className="chip warn assumed-chip" onClick={() => editBrief((d) => Object.assign(d, confirmAssumption(d, "note", a.text)), `confirmed “${a.text}”`)}>
              confirm <Icon.Check size={10} />
            </button>
          )}
          <button className="icon-btn sm row-more" aria-label="Remove" onClick={() => editBrief((d) => void (d.assumptions = d.assumptions.filter((x) => x.text !== a.text)), `removed “${a.text}”`)}>
            <Icon.X size={11} />
          </button>
        </div>
      ))}
      {!data.assumptions.length && <div className="dim brief-empty">Anything else Claude should keep in mind, or that it decided for you.</div>}
      <div className="brief-add">
        <input className="input" value={text} maxLength={300} placeholder="Add a note…" aria-label="New note" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
      </div>
    </Card>
  );
}
