// The design source editor. Typing re-evaluates the design live; edits from
// the AI, the parameter panel or undo arrive as minimal replacements so the
// cursor and scroll position survive, and changed lines flash.

import { useEffect, useLayoutEffect, useRef } from "react";
import { EditorState, Compartment, StateEffect, StateField, Transaction, Annotation, type Extension } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, foldGutter, foldKeymap } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { setDiagnostics, lintGutter, type Diagnostic as CmDiagnostic } from "@codemirror/lint";
import { kerfLanguage, kerfHighlight, kerfTheme, kerfCompletions } from "./editor/kerfLang";
import { useDesign } from "../core/engine";
import { minimalChange, blockAt } from "../core/sourceEdit";
import type { Diagnostic } from "../lang/parser";
import { typeSource } from "../app/project";
import { useView, select } from "../app/view";
import { useChat } from "../ai/chat";

const External = Annotation.define<boolean>();
const flashEffect = StateEffect.define<{ from: number; to: number; cls: string }>();
const clearFlash = StateEffect.define<string>();

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        const doc = tr.state.doc;
        const from = doc.lineAt(Math.min(e.value.from, doc.length)).from;
        const to = doc.lineAt(Math.min(Math.max(e.value.to, e.value.from), doc.length)).from;
        const ranges = [];
        for (let pos = from; pos <= to; ) {
          const line = doc.lineAt(pos);
          ranges.push(Decoration.line({ class: e.value.cls }).range(line.from));
          if (line.to + 1 > doc.length) break;
          pos = line.to + 1;
        }
        deco = deco.update({ add: ranges, sort: true });
      }
      if (e.is(clearFlash)) deco = deco.update({ filter: (_f, _t, d) => (d.spec.class as string) !== e.value });
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * `shown`: whether the editor is in sight (its tab of the dock is up). Out of sight it is left as it is and catches up
 * when it is shown: taking in an edit has it read and colour the text again and redraw its lines, a good part of a
 * second of the page's time on a long design at every edit, for nobody to see.
 */
export function CodeEditor({ shown = true }: { shown?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const readOnly = useRef(new Compartment());
  const busy = useChat((s) => s.busy);
  const inSight = useRef(shown);
  const catchUp = useRef<() => void>(() => undefined);

  useEffect(() => {
    if (!host.current) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const exts: Extension[] = [
      lineNumbers(),
      foldGutter({ openText: "▾", closedText: "▸" }),
      lintGutter(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      autocompletion({ override: [kerfCompletions(() => useDesign.getState().model)], icons: false }),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap, indentWithTab]),
      kerfLanguage,
      kerfHighlight,
      kerfTheme,
      flashField,
      readOnly.current.of(EditorState.readOnly.of(false)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const external = u.transactions.some((t) => t.annotation(External));
        if (external) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => typeSource(u.state.doc.toString()), 160);
      }),
      EditorView.domEventHandlers({
        mouseup: (_e, view) => {
          const sel = view.state.selection.main;
          if (!sel.empty) return false;
          const model = useDesign.getState().model;
          if (!model) return false;
          const b = blockAt(model, sel.head);
          if (b && (b.kind === "part" || b.kind === "component")) {
            const ids = model.parts.filter((p) => p.name === b.name).map((p) => p.id);
            if (ids.length) select(ids);
          }
          return false;
        },
      }),
      EditorView.contentAttributes.of({ "aria-label": "Design source code", spellcheck: "false" }),
    ];
    const view = new EditorView({ parent: host.current, state: EditorState.create({ doc: useDesign.getState().source, extensions: exts }) });
    viewRef.current = view;

    /** `flash`: light up the lines that changed (not when catching up on edits made while out of sight) */
    const applyExternal = (src: string, flash = true) => {
      const cur = view.state.doc.toString();
      if (cur === src) return;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      const ch = minimalChange(cur, src);
      if (!ch) return;
      view.dispatch({
        changes: { from: ch.from, to: ch.to, insert: ch.insert },
        annotations: [External.of(true), Transaction.addToHistory.of(false)],
        effects: flash ? [flashEffect.of({ from: ch.from, to: ch.from + ch.insert.length, cls: "cm-flash" })] : [],
      });
      if (flash) setTimeout(() => view.dispatch({ effects: clearFlash.of("cm-flash") }), 1400);
    };
    const mark = (diagnostics: Diagnostic[]) => {
      const len = view.state.doc.length;
      const diags: CmDiagnostic[] = diagnostics.map((d) => {
        const from = Math.min(Math.max(0, d.start), len);
        return { from, to: Math.min(Math.max(from, d.end), len), severity: d.severity, message: d.message, source: "kerf" };
      });
      view.dispatch(setDiagnostics(view.state, diags));
    };

    // edits that came while the editor was out of sight, not taken in yet
    let behind = false;
    const unsubSrc = useDesign.subscribe((s, prev) => {
      if (s.source === prev.source && s.model === prev.model) return;
      if (!inSight.current) {
        behind = true;
        // (text typed a moment before the tab was left gives way to an edit from elsewhere, as it does in sight)
        if (timer && s.source !== prev.source) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      if (s.source !== prev.source) applyExternal(s.source);
      if (s.model !== prev.model && s.model) mark(s.model.diagnostics);
    });
    catchUp.current = () => {
      if (!behind) return;
      behind = false;
      applyExternal(useDesign.getState().source, false);
      const m = useDesign.getState().model;
      if (m) mark(m.diagnostics);
    };
    applyExternal(useDesign.getState().source);
    const m = useDesign.getState().model;
    if (m) mark(m.diagnostics);

    const unsubView = useView.subscribe((s, prev) => {
      if (s.reveal && s.reveal !== prev.reveal) {
        // a place in the text is about to be shown: in the text as it is now
        catchUp.current();
        const len = view.state.doc.length;
        const from = Math.min(s.reveal.span.start, len);
        const to = Math.min(s.reveal.span.end, len);
        view.dispatch({ selection: { anchor: from }, effects: [EditorView.scrollIntoView(from, { y: "center" }), clearFlash.of("cm-reveal"), flashEffect.of({ from, to, cls: "cm-reveal" })] });
        setTimeout(() => view.dispatch({ effects: clearFlash.of("cm-reveal") }), 1800);
      }
    });

    return () => {
      unsubSrc();
      unsubView();
      if (timer) {
        clearTimeout(timer);
        typeSource(view.state.doc.toString());
      }
      view.destroy();
      viewRef.current = null;
      catchUp.current = () => undefined;
    };
  }, []);

  // before the tab is painted, so the text is never seen as it was
  useLayoutEffect(() => {
    inSight.current = shown;
    if (shown) catchUp.current();
  }, [shown]);

  useEffect(() => {
    const v = viewRef.current;
    if (!v) return;
    v.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(busy)) });
  }, [busy]);

  return (
    <div className="editor-wrap">
      <div ref={host} style={{ position: "absolute", inset: 0 }} />
      {busy && (
        <div className="chip accent" style={{ position: "absolute", right: 12, top: 8, zIndex: 3 }}>
          <span className="spinner" style={{ width: 10, height: 10, borderWidth: 1.5 }} /> Claude is editing, typing is paused
        </div>
      )}
    </div>
  );
}
