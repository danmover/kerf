// The script editor: JavaScript in the app's colours, completion of the kerf API, Ctrl+Enter to run, and the line a
// run stopped at marked. It saves what is typed a moment after typing stops; a change made elsewhere (Claude saving
// the same script) comes in when nothing typed is waiting to be saved.

import { useEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, Prec, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { kerfHighlight, kerfTheme } from "../editor/kerfLang";
import { scriptCompletions, scriptLanguage } from "../editor/scriptLang";

const External = Annotation.define<boolean>();
const markLine = StateEffect.define<number | null>();
const errorLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(markLine)) continue;
      const n = e.value;
      deco = n && n >= 1 && n <= tr.state.doc.lines ? Decoration.set([Decoration.line({ class: "cm-script-error" }).range(tr.state.doc.line(n).from)]) : Decoration.none;
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

interface Props {
  /** which script: a new key is a new document with its own undo */
  docKey: string;
  value: string;
  readOnly: boolean;
  /** the line the last run stopped at */
  error?: number;
  /** what was typed, a moment after typing stops (and before another script opens) */
  onSave: (docKey: string, code: string) => void;
  onRun: () => void;
}

const SAVE_MS = 400;

export function ScriptEditor({ docKey, value, readOnly, error, onSave, onRun }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const ro = useRef(new Compartment());
  const cb = useRef({ onSave, onRun });
  cb.current = { onSave, onRun };
  // typed but not saved yet, for this document
  const pending = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  const shownKey = useRef(docKey);

  const flush = () => {
    const p = pending.current;
    if (!p || !view.current) return;
    clearTimeout(p.timer);
    pending.current = null;
    cb.current.onSave(p.key, view.current.state.doc.toString());
  };

  const state = (doc: string, locked: boolean) => {
    const exts: Extension[] = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      highlightSelectionMatches(),
      autocompletion({ override: [scriptCompletions], icons: false }),
      Prec.highest(keymap.of([{ key: "Mod-Enter", preventDefault: true, run: () => (flush(), cb.current.onRun(), true) }])),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
      scriptLanguage,
      kerfHighlight,
      kerfTheme,
      errorLine,
      ro.current.of(EditorState.readOnly.of(locked)),
      EditorView.updateListener.of((u) => {
        if (!u.docChanged || u.transactions.every((t) => !t.docChanged || t.annotation(External))) return;
        const key = shownKey.current;
        if (pending.current) clearTimeout(pending.current.timer);
        pending.current = { key, timer: setTimeout(flush, SAVE_MS) };
      }),
      EditorView.contentAttributes.of({ "aria-label": "Script", spellcheck: "false" }),
    ];
    return EditorState.create({ doc, extensions: exts });
  };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({ parent: host.current, state: state(value, readOnly) });
    view.current = v;
    return () => {
      flush();
      v.destroy();
      view.current = null;
    };
    // the editor is made once; the effects below follow the props
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // another script: what was typed in the last one is saved to it first
  useEffect(() => {
    const v = view.current;
    if (!v || shownKey.current === docKey) return;
    flush();
    shownKey.current = docKey;
    v.setState(state(value, readOnly));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // the same script changed elsewhere: taken in when nothing typed is waiting
  useEffect(() => {
    const v = view.current;
    if (!v || pending.current || shownKey.current !== docKey) return;
    const cur = v.state.doc.toString();
    if (cur !== value) v.dispatch({ changes: { from: 0, to: cur.length, insert: value }, annotations: [External.of(true), Transaction.addToHistory.of(false)] });
  }, [value, docKey]);

  useEffect(() => {
    view.current?.dispatch({ effects: ro.current.reconfigure(EditorState.readOnly.of(readOnly)) });
  }, [readOnly, docKey]);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    v.dispatch({ effects: markLine.of(error ?? null) });
    if (error && error <= v.state.doc.lines) v.dispatch({ effects: EditorView.scrollIntoView(v.state.doc.line(error).from, { y: "center" }) });
  }, [error, docKey]);

  return <div ref={host} className="kscripts-editor" />;
}
