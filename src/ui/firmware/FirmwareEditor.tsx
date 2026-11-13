// The firmware editor: C++ in the app's colours with Arduino completions, the compiler's mistakes on their lines, a
// gutter for breakpoints (a click sets or clears one; they move with the lines as you type) and the line the
// debugger is showing. Like the script editor, it saves a moment after typing stops, and takes in a change made
// elsewhere (Claude writing the same file) when nothing typed is waiting.

import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, MapMode, Prec, RangeSet, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, drawSelection, gutter, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { kerfHighlight, kerfTheme } from "../editor/kerfLang";
import { firmwareCompletions, firmwareLanguage } from "../editor/firmwareLang";
import { lineChange } from "./lineChange";

export interface EditorBreakpoint {
  line: number;
  /** a plain stop, a stop only when a condition holds, or a logpoint (prints, doesn't stop) */
  kind: "break" | "cond" | "log";
  enabled: boolean;
}

export interface EditorProblem {
  line: number;
  severity: "error" | "warning" | "info";
  message: string;
}

interface Props {
  /** which file: a new key is a new document with its own undo */
  docKey: string;
  value: string;
  readOnly: boolean;
  problems?: EditorProblem[];
  breakpoints?: EditorBreakpoint[];
  /** the line the debugger is showing */
  current?: number;
  /** what was typed, a moment after typing stops (and before another file opens) */
  onSave?: (docKey: string, code: string) => void;
  onToggleBreakpoint?: (line: number) => void;
  /** the breakpoints' lines after typing moved them, in the order they were given */
  onBreakpointsMoved?: (lines: number[]) => void;
  /** Ctrl+Enter */
  onRun?: () => void;
}

const SAVE_MS = 400;
const External = Annotation.define<boolean>();

class BpMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly kind: EditorBreakpoint["kind"] | "spacer",
    readonly enabled: boolean,
  ) {
    super();
  }
  eq(o: BpMarker) {
    return o.index === this.index && o.kind === this.kind && o.enabled === this.enabled;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = `cm-fw-bp ${this.kind}${this.enabled ? "" : " off"}`;
    if (this.kind !== "spacer") el.title = this.kind === "log" ? "Logpoint: prints when the line runs" : this.kind === "cond" ? "Breakpoint with a condition" : "Breakpoint";
    return el;
  }
}
// A breakpoint goes down with its code when lines are added above it (an insertion at its line's start), stays when
// its line is joined to the one above, and goes only when a deletion takes its whole line.
BpMarker.prototype.startSide = BpMarker.prototype.endSide = 1;
BpMarker.prototype.mapMode = MapMode.TrackDel;

const setBps = StateEffect.define<EditorBreakpoint[]>();
const bpField = StateField.define<RangeSet<BpMarker>>({
  create: () => RangeSet.empty,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setBps)) continue;
      const doc = tr.state.doc;
      const ranges = e.value
        .map((b, i) => ({ b, i }))
        .filter(({ b }) => b.line >= 1 && b.line <= doc.lines)
        .map(({ b, i }) => new BpMarker(i, b.kind, b.enabled).range(doc.line(b.line).from))
        .sort((a, b) => a.from - b.from);
      set = RangeSet.of(ranges);
    }
    return set;
  },
});

const showLine = StateEffect.define<number | null>();
const currentLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(showLine)) continue;
      const n = e.value;
      deco = n && n >= 1 && n <= tr.state.doc.lines ? Decoration.set([Decoration.line({ class: "cm-fw-current" }).range(tr.state.doc.line(n).from)]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const bpTheme = EditorView.baseTheme({
  ".cm-fw-bp-gutter": { width: "14px", cursor: "pointer" },
  ".cm-fw-bp-gutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-fw-bp": { display: "inline-block", width: "9px", height: "9px", borderRadius: "50%" },
  ".cm-fw-bp.break": { background: "var(--fail, #e5484d)" },
  ".cm-fw-bp.cond": { background: "transparent", border: "2px solid var(--fail, #e5484d)", width: "5px", height: "5px" },
  ".cm-fw-bp.log": { background: "var(--accent, #4f8cff)", borderRadius: "2px", transform: "rotate(45deg)", width: "7px", height: "7px" },
  ".cm-fw-bp.off": { opacity: "0.35" },
  ".cm-fw-bp.spacer": { visibility: "hidden" },
  ".cm-fw-current": { background: "color-mix(in srgb, var(--warn, #f5a524) 22%, transparent)", boxShadow: "inset 3px 0 0 var(--warn, #f5a524)" },
});

function toDiagnostics(state: EditorState, problems: EditorProblem[]): Diagnostic[] {
  const doc = state.doc;
  return problems
    .filter((p) => p.line >= 1)
    .map((p) => {
      const l = doc.line(Math.min(p.line, doc.lines));
      const from = l.from + (l.text.length - l.text.trimStart().length);
      return { from, to: Math.max(from, l.to), severity: p.severity, message: p.message };
    });
}

export function FirmwareEditor({ docKey, value, readOnly, problems, breakpoints, current, onSave, onToggleBreakpoint, onBreakpointsMoved, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const ro = useRef(new Compartment());
  const cb = useRef({ onSave, onToggleBreakpoint, onBreakpointsMoved, onRun });
  cb.current = { onSave, onToggleBreakpoint, onBreakpointsMoved, onRun };
  const bps = useRef(breakpoints ?? []);
  bps.current = breakpoints ?? [];
  // typed but not saved yet, for this document
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const shownKey = useRef(docKey);

  const flush = () => {
    const p = pending.current;
    if (!p || !view.current) return;
    clearTimeout(p.timer);
    pending.current = null;
    cb.current.onSave?.(p.key, view.current.state.doc.toString());
  };

  const state = (doc: string, locked: boolean) => {
    const exts: Extension[] = [
      gutter({
        class: "cm-fw-bp-gutter",
        markers: (v) => v.state.field(bpField),
        initialSpacer: () => new BpMarker(-1, "spacer", true),
        domEventHandlers: {
          mousedown(v, block) {
            if (!cb.current.onToggleBreakpoint) return false;
            cb.current.onToggleBreakpoint(v.state.doc.lineAt(block.from).number);
            return true;
          },
        },
      }),
      lineNumbers(),
      lintGutter(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      autocompletion({ override: [firmwareCompletions], icons: false }),
      Prec.highest(keymap.of([{ key: "Mod-Enter", preventDefault: true, run: () => (flush(), cb.current.onRun?.(), true) }])),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      firmwareLanguage,
      kerfHighlight,
      kerfTheme,
      bpTheme,
      bpField,
      currentLine,
      ro.current.of(EditorState.readOnly.of(locked)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        // breakpoints follow their lines; the owner hears where they went
        // (a breakpoint whose line was deleted goes, as line 0)
        if (bps.current.length && cb.current.onBreakpointsMoved) {
          const lines = bps.current.map(() => 0);
          for (let it = u.state.field(bpField).iter(); it.value; it.next()) {
            const i = it.value.index;
            if (i >= 0 && i < lines.length) lines[i] = u.state.doc.lineAt(it.from).number;
          }
          if (lines.some((n, i) => n !== bps.current[i].line)) cb.current.onBreakpointsMoved(lines);
        }
        if (u.transactions.every((t) => !t.docChanged || t.annotation(External))) return;
        const key = shownKey.current;
        if (pending.current) clearTimeout(pending.current.timer);
        pending.current = { key, timer: setTimeout(flush, SAVE_MS) };
      }),
      EditorView.contentAttributes.of({ "aria-label": "Firmware code", spellcheck: "false" }),
    ];
    return EditorState.create({ doc, extensions: exts });
  };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current, state: state(value, readOnly) });
    view.current = v;
    v.dispatch({ effects: setBps.of(bps.current) });
    return () => {
      flush();
      v.destroy();
      view.current = null;
    };
    // the editor is made once; the effects below follow the props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // another file: what was typed in the last one is saved to it first
  useEffect(() => {
    const v = view.current;
    if (!v || shownKey.current === docKey) return;
    flush();
    shownKey.current = docKey;
    v.setState(state(value, readOnly));
    v.dispatch({ effects: setBps.of(bps.current) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // the same file changed elsewhere: taken in when nothing typed is waiting
  useEffect(() => {
    const v = view.current;
    if (!v || pending.current || shownKey.current !== docKey) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: lineChange(cur, value), annotations: [External.of(true), Transaction.addToHistory.of(false)] });
  }, [value, docKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly, docKey]);

  const bpSig = (breakpoints ?? []).map((b) => `${b.line}${b.kind[0]}${b.enabled ? 1 : 0}`).join(",");
  useEffect(() => {
    view.current?.dispatch({ effects: setBps.of(bps.current) });
  }, [bpSig, docKey]);

  const probSig = JSON.stringify(problems ?? []);
  useEffect(() => {
    const v = view.current;
    if (v) v.dispatch(setDiagnostics(v.state, toDiagnostics(v.state, problems ?? [])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probSig, docKey, value]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: showLine.of(current ?? null) });
    if (current && current <= v.state.doc.lines) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(current).from, { y: "center" }) });
  }, [current, docKey]);

  return <div ref={host} className="kfw-editor" />;
}
