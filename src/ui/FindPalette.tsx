// The find palette (Ctrl+K, /, or the search button in the top bar): one
// box to reach anything in Kerf by name, or by the words people use for it.
// With nothing typed it lists everything, grouped, so it doubles as a map of
// what Kerf can do. Features the design doesn't have yet draft a request for
// Claude to add them, and anything that isn't a feature is asked of Claude
// directly (or, outside a project, starts a new design from it).

import { motion } from "framer-motion";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi, showPhonePane } from "../app/ui";
import { useProject } from "../app/project";
import { rank, readsLikeAsk } from "../app/find";
import { chatKey, startDesign } from "../app/startDesign";
import { quickCommandOf } from "../app/quickRun";
import { sendMessage } from "../ai/chat";
import { useSettings } from "../app/settings";
import { DOCK_TABS } from "./Dock";
import { findItems, GROUP_ORDER, type FindItem } from "./findItems";
import { askClaude } from "./chatDraft";
import { Icon } from "./icons";
import { Kbd, mod } from "./common";
import "../styles/find.css";

const ASK_ID = "ask:typed";

export function FindPalette() {
  const open = useUi((s) => s.findOpen);
  const onWorkspace = useUi((s) => s.screen.name === "workspace");
  const hasProject = useProject((s) => !!s.current);
  const inWorkspace = onWorkspace && hasProject;
  // DOCK_TABS never changes, so these hooks run in the same order every time (as in Dock)
  const shown = DOCK_TABS.map((t) => t.useShown?.() ?? true);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const back = useRef<Element | null>(null);

  // the list is built as the palette opens, from what the design has then
  const items = useMemo(() => (open ? findItems({ inWorkspace, dockShown: Object.fromEntries(DOCK_TABS.map((t, i) => [t.id, shown[i]])) }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, inWorkspace]);

  useEffect(() => {
    if (!open) return;
    back.current = document.activeElement;
    setQuery("");
    setActive(0);
    requestAnimationFrame(() => input.current?.focus());
  }, [open]);

  const q = query.trim();
  const rows = useMemo(() => {
    if (!q) {
      const order = (g: string) => GROUP_ORDER.indexOf(g as never);
      return items.map((it, i) => ({ it, i })).sort((a, b) => order(a.it.group) - order(b.it.group) || a.i - b.i).map((x) => x.it);
    }
    const found = rank(q, items, 40);
    const askRow: FindItem = {
      id: ASK_ID,
      group: "Project",
      title: inWorkspace ? `Ask Claude: “${q}”` : `Start a design: “${q}”`,
      detail: inWorkspace ? "Send it to Claude in the chat" : "A new design, with this as the brief for Claude",
      icon: <Icon.Sparkle size={14} />,
      pane: "chat",
      run: () => {
        if (!inWorkspace) return void startDesign(q);
        // a plain command ("fillet 2") is done at once; without a key the words wait in the message box
        if (chatKey() || (useSettings.getState().quickCommands && quickCommandOf(q))) void sendMessage(q);
        else askClaude(q);
      },
    };
    const at = readsLikeAsk(q, found[0]) ? 0 : Math.min(3, found.length);
    return [...found.slice(0, at), askRow, ...found.slice(at)];
  }, [q, items, inWorkspace]);

  useEffect(() => setActive(0), [q]);
  useLayoutEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, rows]);

  const close = (restore = true) => {
    useUi.setState({ findOpen: false });
    if (restore) requestAnimationFrame(() => (back.current as HTMLElement | null)?.focus?.());
  };
  const run = (it: FindItem | undefined) => {
    if (!it) return;
    close(false);
    if (it.pane) showPhonePane(it.pane);
    it.run();
  };

  if (!open) return null;
  let lastGroup = "";
  return createPortal(
    <div className="find-layer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <motion.div className="find" role="dialog" aria-modal="true" aria-label="Find anything" initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.14 }}>
        <div className="find-box">
          <Icon.Search size={16} />
          <input
            ref={input}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={inWorkspace ? "Find a tool, view, analysis or export, or ask Claude…" : "Find a template or setting, or describe a new design…"}
            aria-label="Find anything"
            aria-controls="find-list"
            aria-activedescendant={rows[active] ? `find-${rows[active].id}` : undefined}
            spellCheck={false}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const n = rows.length;
                if (n) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                run(rows[active]);
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                close();
              }
            }}
          />
          <Kbd>Esc</Kbd>
        </div>
        <div className="find-list" id="find-list" role="listbox" ref={list}>
          {rows.map((it, i) => {
            const head = !q && it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id} role="presentation">
                {head && <div className="find-group">{head}</div>}
                <div
                  id={`find-${it.id}`}
                  data-i={i}
                  role="option"
                  aria-selected={i === active}
                  className={`find-row ${i === active ? "active" : ""} ${it.id === ASK_ID ? "ask-row" : ""}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => run(it)}
                >
                  <span className="find-icon">{it.icon}</span>
                  <span className="find-text">
                    <span className="find-title">{it.title}</span>
                    {it.detail && <span className="find-detail">{it.detail}</span>}
                  </span>
                  {it.tag === "ask" && <span className="find-tag ask">Claude adds it</span>}
                  {it.tag === "on" && <span className="find-tag on">on</span>}
                  {it.tag === "here" && <span className="find-tag here">in this design</span>}
                  {q && it.id !== ASK_ID && <span className="find-where">{it.group}</span>}
                  {it.keys && (
                    <span className="find-keys">
                      {it.keys.split(" ").map((k) => (
                        <Kbd key={k}>{k === "Ctrl" ? mod : k}</Kbd>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {!rows.length && <div className="find-none">Nothing to find yet.</div>}
        </div>
        <div className="find-foot">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>Enter</Kbd> {rows[active]?.tag === "ask" ? "draft it for Claude" : "go"}
          </span>
          <div className="grow" />
          <span>
            <Kbd>{mod}</Kbd>
            <Kbd>K</Kbd> or <Kbd>/</Kbd> opens this anywhere
          </span>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

/** The top bar's way in, for anyone who doesn't know the shortcut. */
export function FindButton() {
  return (
    <button className="find-btn" onClick={() => useUi.setState({ findOpen: true })} aria-label="Find anything" data-tip={`Find a tool, view, analysis or export, or ask Claude (${mod}K)`}>
      <Icon.Search size={14} />
      <span className="find-btn-label">Find</span>
      <span className="find-btn-keys narrow-hide">
        <Kbd>{mod}</Kbd>
        <Kbd>K</Kbd>
      </span>
    </button>
  );
}
