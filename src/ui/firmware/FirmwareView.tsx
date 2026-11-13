// Build → Firmware: each firmware block's code. A block runs Kerf's code, written from the wiring and shown here
// read-only, or its own ("My code"): files you edit, checked as you type the way the Arduino IDE's Verify does,
// with the last simulation's firmware mistakes on their lines. Breakpoints go in the gutter of either; the debugger
// in Simulate stops there. Kerf's pin map stays as the reference for what the wiring expects.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { useDesign } from "../../core/engine";
import { useProject } from "../../app/project";
import { confirmDialog, toast } from "../../app/ui";
import { deleteOwnFile, kerfCodeFor, renameOwnFile, resetOwnCode, startOwnCode, switchToKerfCode, writeOwnFile } from "../../app/firmwareCode";
import { moveBreakpoints, renameBreakpointFile, toggleBreakpoint, useFirmwareDebug } from "../../app/firmwareDebug";
import type { FirmwareOutput } from "../../machine/firmware";
import { ownFileProblem } from "../../machine/firmware/ownCode";
import { checkFirmware, type FirmwareCheck } from "../../sim/mcu/check";
import { useSim } from "../../sim/runtime";
import { download } from "../../persist/files";
import { Segmented } from "../common";
import { Icon } from "../icons";
import { FirmwareEditor, type EditorProblem } from "./FirmwareEditor";
import "../../styles/firmware.css";

type Files = { path: string; content: string }[];

/**
 * The open file: "<block>|own|<name>" (the block's own file), "<block>|gen|<path>" (Kerf's code) or "<block>|pins".
 * line is where to put the cursor when it opens (from the debugger).
 */
export const useFirmwareView = create<{ file: string; line?: number; nonce: number }>(() => ({ file: "", nonce: 0 }));

/** Open a block's file by the name the sketch knows it by (from the debugger, or Claude's changes). */
export function showFirmwareFile(block: string, name: string, line?: number) {
  const def = useDesign.getState().model?.machine?.firmware.find((f) => f.name === block);
  const own = def?.settings.code === "own" && (useProject.getState().current?.firmware?.find((r) => r.block === block)?.files.length ?? 0) > 0;
  const gen = own ? undefined : kerfCodeFor(block)?.files.find((f) => f.path.split("/").pop() === name);
  useFirmwareView.setState({ file: own ? `${block}|own|${name}` : gen ? `${block}|gen|${gen.path}` : `${block}|own|${name}`, line, nonce: Date.now() });
}

const TARGET_WORD: Record<FirmwareOutput["target"], string> = { arduino: "Arduino", klipper: "Klipper", marlin: "Marlin", reprapfirmware: "RepRapFirmware", none: "not generated" };
const C_FILE = /\.(ino|h|hpp|c|cpp)$/;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const lineCount = (s: string) => s.replace(/\n$/, "").split("\n").length;
const bytes = (n: number) => (n >= 10_240 ? `${Math.round(n / 1024)} KB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/** Light highlighting for the files that aren't C (README.md, printer.cfg): comments and section headers. */
function highlight(line: string, ext: string): ReactNode {
  if (ext === "md") return /^#{1,6}\s/.test(line) ? <span className="h">{line}</span> : line;
  if (/^\s*[#;]/.test(line)) return <span className="c">{line}</span>;
  if (/^\s*\[.*\]\s*$/.test(line)) return <span className="h">{line}</span>;
  const k = line.search(/\s[#;]/);
  return k >= 0 ? (
    <>
      {line.slice(0, k)}
      <span className="c">{line.slice(k)}</span>
    </>
  ) : (
    line
  );
}

function copyText(content: string, name: string) {
  navigator.clipboard
    .writeText(content)
    .then(() => toast({ kind: "success", title: `Copied ${name}`, detail: "Paste it into the Arduino IDE or your editor." }))
    .catch(() => toast({ kind: "warn", title: "Could not copy", detail: "The browser blocked the clipboard. Use Download instead." }));
}

const report = (title: string) => (why: string | null) => {
  if (why) toast({ kind: "error", title, detail: why });
  return !why;
};

export function Firmware({ fw }: { fw: FirmwareOutput[] }) {
  const sel = useFirmwareView((s) => s.file);
  const jump = useFirmwareView((s) => s.line);
  const nonce = useFirmwareView((s) => s.nonce);
  const machine = useDesign((s) => s.model?.machine);
  const ownCode = useProject((s) => s.current?.firmware);
  const [adding, setAdding] = useState<string | null>(null);
  // Kerf's code for the blocks that run their own, to compare (written again only when the design changes)
  const ownBlocks = (machine?.firmware ?? []).filter((d) => d.settings.code === "own").map((d) => d.name).join(",");
  const kerfFiles = useMemo(() => new Map(ownBlocks ? ownBlocks.split(",").map((b) => [b, kerfCodeFor(b)?.files ?? []]) : []), [machine, ownBlocks]);
  // a block that starts or stops running its own code (here, from Claude, or by undo) keeps the same file open
  const seenOwn = useRef(ownBlocks);
  useEffect(() => {
    const was = new Set(seenOwn.current.split(",").filter(Boolean));
    seenOwn.current = ownBlocks;
    const [b, side, name] = useFirmwareView.getState().file.split("|");
    if (!b || !name) return;
    const now = new Set(ownBlocks.split(",").filter(Boolean));
    const base = name.split("/").pop()!;
    if (side === "gen" && now.has(b) && !was.has(b) && ownCode?.find((r) => r.block === b)?.files.some((f) => f.path === base)) useFirmwareView.setState({ file: `${b}|own|${base}` });
    if (side === "own" && was.has(b) && !now.has(b)) {
      const gen = fw.find((f) => f.name === b)?.files.find((f) => f.path.split("/").pop() === base);
      if (gen) useFirmwareView.setState({ file: `${b}|gen|${gen.path}` });
    }
  }, [ownBlocks, ownCode, fw]);

  if (!fw.length) {
    return (
      <div className="mp-pad">
        <div className="empty-state">
          No firmware block yet. Add one, for example <span className="mono">firmware main {"{"} board: ctrl {"}"}</span>, and Kerf writes code that matches the wiring: pin numbers, motor directions and limits.
        </div>
      </div>
    );
  }

  const isOwn = (f: FirmwareOutput) => machine?.firmware.find((d) => d.name === f.name)?.settings.code === "own";
  const ownOf = (block: string): Files => ownCode?.find((r) => r.block === block)?.files ?? [];
  // every file that can be opened, in the order the side lists them
  const entries = fw.flatMap((f) => {
    const own = isOwn(f) ? ownOf(f.name) : [];
    const mine = own.map((file) => ({ f, file, key: `${f.name}|own|${file.path}`, own: true }));
    const gens = (own.length ? (kerfFiles.get(f.name) ?? []) : f.files).map((file) => ({ f, file, key: `${f.name}|gen|${file.path}`, own: false }));
    return [...mine, ...gens];
  });
  const pinsFor = fw.find((f) => sel === `${f.name}|pins`);
  const current = pinsFor ? undefined : (entries.find((x) => x.key === sel) ?? entries[0]);
  const block = pinsFor ?? current?.f ?? fw[0];

  const switchTo = async (f: FirmwareOutput, v: "kerf" | "own") => {
    if (v === "own") {
      if (report(`${f.name} can't run its own code`)(startOwnCode(f.name))) {
        const first = ownOf(f.name)[0] ?? useProject.getState().current?.firmware?.find((r) => r.block === f.name)?.files[0];
        if (first) useFirmwareView.setState({ file: `${f.name}|own|${first.path}`, line: undefined });
      }
    } else report(`${f.name} still runs its own code`)(switchToKerfCode(f.name));
  };

  return (
    <div className="mp-fw">
      <div className="mp-fw-side">
        {fw.map((f) => {
          const own = isOwn(f);
          const mine = entries.filter((x) => x.f === f && x.own);
          const gens = entries.filter((x) => x.f === f && !x.own);
          const arduino = f.target === "arduino" || own;
          return (
            <div key={f.name} className="mp-fw-block">
              <div className="mp-fw-name">
                <Icon.Chip size={14} style={{ color: "var(--text-3)" }} />
                <span className="mono">{f.name}</span>
                <span className={`chip ${f.target === "none" ? "warn" : ""}`} style={{ height: 17, fontSize: 9.5 }}>
                  {TARGET_WORD[f.target]}
                </span>
              </div>
              <div className="mp-sub" style={{ margin: "3px 0 6px" }}>
                {f.summary}
              </div>
              {arduino && (
                <div className="kfw-mode">
                  <Segmented
                    id={`fw-mode-${f.name}`}
                    value={own ? "own" : "kerf"}
                    onChange={(v) => void switchTo(f, v)}
                    options={[
                      { value: "kerf", label: "Kerf's code", title: "Kerf writes the code from the wiring, and writes it again when the wiring changes" },
                      { value: "own", label: "My code", title: "Run code of your own: it starts as a copy of Kerf's, and the simulator, apps and build pack use it" },
                    ]}
                  />
                </div>
              )}
              {mine.map((x) => (
                <FileButton key={x.key} name={x.file.path} lines={lineCount(x.file.content)} active={current?.key === x.key} onClick={() => useFirmwareView.setState({ file: x.key, line: undefined })} tip={`${x.file.path}: your own code`} />
              ))}
              {own && mine.length === 0 && (
                <button className="btn sm kfw-start" onClick={() => void switchTo(f, "own")} data-tip="Start your own code from a copy of Kerf's">
                  <Icon.Code size={13} /> Start my code from Kerf's
                </button>
              )}
              {own && adding === f.name && <NewFile block={f.name} files={ownOf(f.name)} onDone={(name) => (setAdding(null), name && useFirmwareView.setState({ file: `${f.name}|own|${name}`, line: undefined }))} />}
              {own && adding !== f.name && mine.length > 0 && (
                <button className="mp-file kfw-add" onClick={() => setAdding(f.name)}>
                  <Icon.Plus size={13} />
                  New file
                </button>
              )}
              {mine.length > 0 && gens.length > 0 && <div className="kfw-ref">Kerf's code, to compare</div>}
              {gens.map((x) => (
                <FileButton key={x.key} name={x.file.path.split("/").pop()!} lines={lineCount(x.file.content)} active={current?.key === x.key} onClick={() => useFirmwareView.setState({ file: x.key, line: undefined })} tip={x.file.path} dim={mine.length > 0} />
              ))}
              {f.pinTable.length > 0 && (
                <button className={`mp-file ${pinsFor === f ? "active" : ""}`} onClick={() => useFirmwareView.setState({ file: `${f.name}|pins`, line: undefined })}>
                  <Icon.List size={13} />
                  pin map
                  <span className="n">{f.pinTable.length}</span>
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="mp-fw-main">
        {pinsFor ? (
          <>
            {block.warnings.length > 0 && <Warnings list={block.warnings} />}
            <PinMap f={pinsFor} />
          </>
        ) : current ? (
          current.own ? (
            <OwnFile key={current.f.name} block={current.f.name} name={current.file.path} files={ownOf(current.f.name)} partId={machine?.components.find((c) => c.name === machine.firmware.find((d) => d.name === current.f.name)?.board)?.catalogId} jump={jump} nonce={nonce} />
          ) : (
            <>
              {block.warnings.length > 0 && <Warnings list={block.warnings} />}
              <KerfFile block={current.f.name} path={current.file.path} content={current.file.content} jump={jump} nonce={nonce} compare={isOwn(current.f)} />
            </>
          )
        ) : (
          <>
            {block.warnings.length > 0 && <Warnings list={block.warnings} />}
            <div className="mp-pad">
              <div className="empty-state">{block.summary}</div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function FileButton({ name, lines, active, onClick, tip, dim }: { name: string; lines: number; active: boolean; onClick: () => void; tip: string; dim?: boolean }) {
  return (
    <button className={`mp-file ${active ? "active" : ""} ${dim ? "kfw-dim" : ""}`} onClick={onClick} data-tip={tip}>
      <Icon.Doc size={13} />
      {name}
      <span className="n">{lines}</span>
    </button>
  );
}

function Warnings({ list }: { list: string[] }) {
  return (
    <ul className="mp-fw-warn">
      {list.map((w, i) => (
        <li key={i}>{w}</li>
      ))}
    </ul>
  );
}

function PinMap({ f }: { f: FirmwareOutput }) {
  return (
    <div className="mp-pins">
      <table className="bom">
        <thead>
          <tr>
            <th>Signal</th>
            <th>Controller pin</th>
            <th>Wired to</th>
          </tr>
        </thead>
        <tbody>
          {f.pinTable.map((p, i) => (
            <tr key={i}>
              <td>{p.signal}</td>
              <td className="mono" style={{ color: "var(--text)" }}>
                {p.pin}
              </td>
              <td className="mono">{p.wire}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function NewFile({ block, files, onDone }: { block: string; files: Files; onDone: (name: string | null) => void }) {
  const [name, setName] = useState("");
  const problem = name ? ownFileProblem(name, files) : null;
  const make = () => {
    if (!name || problem) return onDone(null);
    const content = name.endsWith(".ino") ? "" : /\.(h|hpp)$/.test(name) ? "#pragma once\n\n" : `#include <Arduino.h>\n\n`;
    if (report(`Couldn't add ${name}`)(writeOwnFile(block, name, content))) onDone(name);
    else onDone(null);
  };
  return (
    <div className="kfw-new">
      <input
        autoFocus
        className="kfw-name"
        value={name}
        placeholder="name.h"
        maxLength={64}
        aria-label="New file name"
        onChange={(e) => setName(e.target.value.trim())}
        onBlur={make}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") onDone(null);
        }}
      />
      {problem && <div className="kfw-why">{problem}</div>}
    </div>
  );
}

/** Firmware mistakes the simulator found in a file, from runs of the current design. */
function useSimFaults(block: string, file: string): EditorProblem[] {
  const runs = useSim((s) => s.runs);
  return useMemo(() => {
    const seen = new Map<string, EditorProblem>();
    for (const r of runs.values()) {
      if (r.stale || r.result?.firmware.name !== block) continue;
      for (const v of r.result.variants)
        for (const f of v.faults) {
          if (f.file !== file || f.line < 1) continue;
          const key = `${f.line}:${f.msg}`;
          if (!seen.has(key)) seen.set(key, { line: f.line, severity: "warning", message: `In the simulation (${r.label}, at ${f.t.toFixed(2)} s${f.count > 1 ? `, ${f.count} times` : ""}): ${f.msg}` });
        }
    }
    return [...seen.values()];
  }, [runs, block, file]);
}

function useBreakpoints(block: string, file: string) {
  const all = useFirmwareDebug((s) => s.breakpoints);
  return useMemo(() => all.filter((b) => b.block === block && b.file === file).map((b) => ({ line: b.line, enabled: b.enabled, kind: b.log ? ("log" as const) : b.cond ? ("cond" as const) : ("break" as const) })), [all, block, file]);
}

/** Kerf's code: what the block runs, or (compare) what Kerf would write while the block runs its own, without breakpoints. */
function KerfFile({ block, path, content, jump, nonce, compare }: { block: string; path: string; content: string; jump?: number; nonce: number; compare: boolean }) {
  const base = path.split("/").pop() ?? "";
  const ext = base.split(".").pop()?.toLowerCase() ?? "";
  const mine = useBreakpoints(block, base);
  const bps = compare ? [] : mine;
  const faults = useSimFaults(block, base);
  const c = C_FILE.test(base);
  const lines = content.replace(/\n$/, "").split("\n");
  return (
    <>
      <div className="mp-toolbar kfw-bar">
        <span className="mono kfw-path" data-tip={path}>
          {path}
        </span>
        <span className="mono dim kfw-lines">{plural(lines.length, "line")}</span>
        {c && (
          <span className="dim kfw-note" data-tip={compare ? `${block} runs your own code: this is what Kerf would write from the wiring, to compare. Breakpoints go in your own files.` : "Kerf writes this from the wiring, and writes it again when the wiring changes. Click beside a line number to set a breakpoint."}>
            {compare ? "Kerf's code · to compare" : "Kerf's code · read-only"}
          </span>
        )}
        <div className="grow" />
        <button className="btn sm icon" onClick={() => copyText(content, base)} data-tip={`Copy ${base}`} aria-label={`Copy ${base}`}>
          <Icon.Copy size={13} />
        </button>
        <button className="btn sm icon" onClick={() => download(content, base, "text/plain")} data-tip={`Download ${base}`} aria-label={`Download ${base}`}>
          <Icon.Download size={13} />
        </button>
      </div>
      {c ? (
        <FirmwareEditor
          docKey={`${block}|gen|${path}`}
          value={content}
          readOnly
          problems={compare ? [] : faults}
          breakpoints={bps}
          current={jump}
          key={`${block}|gen|${path}|${nonce}`}
          onToggleBreakpoint={compare ? undefined : (line) => toggleBreakpoint(block, base, line)}
          onBreakpointsMoved={compare ? undefined : (moved) => moveBreakpoints(block, base, moved)}
        />
      ) : (
        <pre className="mp-code">
          {lines.map((l, i) => (
            <div key={i}>
              <span className="ln">{i + 1}</span>
              {highlight(l, ext)}
            </div>
          ))}
        </pre>
      )}
    </>
  );
}

function OwnFile({ block, name, files, partId, jump, nonce }: { block: string; name: string; files: Files; partId?: string; jump?: number; nonce: number }) {
  const file = files.find((f) => f.path === name);
  const bps = useBreakpoints(block, name);
  const faults = useSimFaults(block, name);
  // compiled a moment after a save, so typing stays quick
  const [check, setCheck] = useState<FirmwareCheck | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setCheck(checkFirmware(files, partId)), 150);
    return () => clearTimeout(t);
  }, [files, partId]);
  if (!file) return null;
  const here = check?.problem && check.problem.file === name ? [{ line: check.problem.line, severity: "error" as const, message: check.problem.message }] : [];
  const elsewhere = check?.problem && check.problem.file !== name ? check.problem : null;
  const isIno = name.endsWith(".ino");
  const onlyIno = isIno && files.filter((f) => f.path.endsWith(".ino")).length === 1;
  const del = async () => {
    const ok = await confirmDialog({ title: `Delete ${name}?`, body: `The file goes from ${block}'s own code. Undo doesn't bring it back.`, confirm: "Delete", danger: true });
    if (ok) report(`Couldn't delete ${name}`)(deleteOwnFile(block, name));
  };
  const reset = async () => {
    const ok = await confirmDialog({
      title: `Start ${block}'s code again from Kerf's?`,
      body: "Your own files for this block are replaced with a fresh copy of the code Kerf writes from the wiring. Undo doesn't bring them back, so download them first if you want to keep them.",
      confirm: "Start again",
      danger: true,
    });
    if (ok && report("Couldn't start again")(resetOwnCode(block))) useFirmwareView.setState({ file: "", line: undefined });
  };
  return (
    <>
      <div className="mp-toolbar kfw-bar">
        <NameField block={block} name={name} />
        <span className="mono dim kfw-lines">{plural(lineCount(file.content), "line")}</span>
        <Verdict check={check} />
        <div className="grow" />
        <button className="btn sm icon" onClick={() => copyText(file.content, name)} data-tip={`Copy ${name}`} aria-label={`Copy ${name}`}>
          <Icon.Copy size={13} />
        </button>
        <button className="btn sm icon" onClick={() => download(file.content, name, "text/plain")} data-tip={`Download ${name}`} aria-label={`Download ${name}`}>
          <Icon.Download size={13} />
        </button>
        <button className="btn sm ghost icon" onClick={() => void del()} disabled={onlyIno} data-tip={onlyIno ? "The sketch needs its .ino file" : `Delete ${name}`} aria-label={`Delete ${name}`}>
          <Icon.Trash size={13} />
        </button>
        <button className="btn sm ghost" onClick={() => void reset()} data-tip="Replace your own files with a fresh copy of Kerf's code">
          <Icon.Undo size={13} /> Start again
        </button>
      </div>
      {elsewhere && (
        <button className="kfw-elsewhere" onClick={() => useFirmwareView.setState({ file: elsewhere.file.startsWith("<") ? `${block}|own|${name}` : `${block}|own|${elsewhere.file}`, line: elsewhere.line, nonce: Date.now() })}>
          <Icon.Alert size={13} />
          <span className="mono">
            {elsewhere.file}
            {elsewhere.line > 0 ? `:${elsewhere.line}` : ""}
          </span>
          {elsewhere.message}
        </button>
      )}
      <FirmwareEditor
        key={`${block}|own|${name}|${nonce}`}
        docKey={`${block}|own|${name}`}
        value={file.content}
        readOnly={false}
        problems={[...here, ...faults]}
        breakpoints={bps}
        current={jump}
        onSave={(key, code) => {
          const [b, , n] = key.split("|");
          report(`Couldn't save ${n}`)(writeOwnFile(b, n, code));
        }}
        onToggleBreakpoint={(line) => toggleBreakpoint(block, name, line)}
        onBreakpointsMoved={(lines) => moveBreakpoints(block, name, lines)}
      />
    </>
  );
}

function Verdict({ check }: { check: FirmwareCheck | null }) {
  if (!check) return <span className="chip kfw-verdict">checking…</span>;
  if (check.problem)
    return (
      <span className="chip fail kfw-verdict" data-tip={`${check.problem.file}${check.problem.line ? `:${check.problem.line}` : ""}: ${check.problem.message}`}>
        doesn't compile
      </span>
    );
  if (check.missing?.length)
    return (
      <span className="chip warn kfw-verdict" data-tip={`A sketch needs ${check.missing.map((m) => `${m}()`).join(" and ")}`}>
        no {check.missing.map((m) => `${m}()`).join(" or ")}
      </span>
    );
  const ram = check.ram!;
  const share = ram.used / ram.total;
  return (
    <span className={`chip ${share > 0.75 ? "warn" : "pass"} kfw-verdict`} data-tip={`Compiles for the ${check.board}. Globals, strings in RAM and the core's buffers take ${bytes(ram.used)} of its ${bytes(ram.total)} RAM before anything runs; the simulation adds the stack's peak.`}>
      compiles · RAM {bytes(ram.used)} / {bytes(ram.total)}
    </span>
  );
}

function NameField({ block, name }: { block: string; name: string }) {
  const [v, setV] = useState(name);
  useEffect(() => setV(name), [name]);
  const commit = () => {
    if (v === name) return;
    if (report("Name not changed")(renameOwnFile(block, name, v))) {
      renameBreakpointFile(block, name, v);
      useFirmwareView.setState({ file: `${block}|own|${v}`, line: undefined });
    } else setV(name);
  };
  return (
    <input
      className="kfw-name mono"
      value={v}
      maxLength={64}
      aria-label="File name"
      onChange={(e) => setV(e.target.value.trim())}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setV(name);
      }}
    />
  );
}
