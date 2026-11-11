// Parts tab: the design's name and notes, then every part grouped as the
// design groups them. Rows say what each part is, flag failing checks, and
// stay in step with the viewport selection.

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useDesign } from "../../core/engine";
import { useView, revealSpan, select, soloGroup } from "../../app/view";
import type { EvalPart } from "../../core/model";
import { fmtNum } from "../../lang/values";
import { Icon } from "../icons";
import { Swatch } from "../MaterialPicker";
import { G } from "./glyphs";
import { describePart } from "./insights";
import { Highlight, CodeSample } from "./bits";
import { ImportsSection } from "../ImportsPanel";
import { openContextMenu } from "../ContextMenu";
import { partRowMenuEntries } from "../viewport/contextMenus";

interface Row {
  name: string;
  ids: string[];
  part: EvalPart;
  desc: string;
  count: number;
}

function kindIcon(p: EvalPart) {
  if (p.kind === "part") return <Icon.Box size={13} />;
  switch (p.libKind) {
    case "spur_gear":
      return <Icon.Gear size={13} />;
    case "screw":
    case "nut":
    case "insert":
    case "dowel":
      return <Icon.Screw size={13} />;
    case "pcb":
    case "usb_c":
    case "connector":
      return <Icon.Chip size={13} />;
    case "step":
      return <Icon.Upload size={13} />;
    default:
      return <Icon.Cube size={13} />;
  }
}

export function PartsTab({ filter }: { filter: string }) {
  const model = useDesign((s) => s.model);
  const report = useDesign((s) => s.report);
  const selected = useView((s) => s.selected);
  const hiddenIds = useView((s) => s.hiddenIds);
  const soloGroups = useView((s) => s.soloGroups);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    const g = new Map<string, Row[]>();
    if (!model) return g;
    const byName = new Map<string, Row>();
    for (const p of model.parts) {
      let r = byName.get(p.name);
      if (!r) {
        r = { name: p.name, ids: [], part: p, desc: describePart(model, p), count: 0 };
        byName.set(p.name, r);
        const key = p.group || "Parts";
        g.set(key, [...(g.get(key) ?? []), r]);
      }
      r.ids.push(p.id);
      if (!p.id.includes(".")) r.count++;
    }
    return g;
  }, [model]);

  const failing = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const i of report?.items ?? []) if (i.status === "fail") for (const id of i.parts ?? []) m.set(id, [...(m.get(id) ?? []), i.title]);
    return m;
  }, [report]);

  const visibleGroups = useMemo(() => {
    if (!filter) return [...groups.entries()];
    return [...groups.entries()]
      .map(([group, rows]) => [group, group.toLowerCase().includes(filter) ? rows : rows.filter((r) => `${r.name} ${r.desc} ${r.part.material} ${r.part.libKind ?? ""}`.toLowerCase().includes(filter))] as [string, Row[]])
      .filter(([, rows]) => rows.length);
  }, [groups, filter]);

  // Follow a selection made in the viewport: open its group and bring the row into view.
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected.length) return;
    for (const [group, rows] of groups) {
      const row = rows.find((r) => r.ids.includes(selected[0]));
      if (!row) continue;
      if (collapsed.has(group)) {
        const n = new Set(collapsed);
        n.delete(group);
        setCollapsed(n);
      }
      requestAnimationFrame(() => listRef.current?.querySelector(`[data-part="${CSS.escape(row.name)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
      break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  if (!model) return null;
  return (
    <div className="lp-parts" ref={listRef}>
      <DesignHeader name={model.name} notes={model.notes} />
      {!model.parts.length && (
        <div className="lp-empty">
          <div>No parts yet. Ask Claude to design something, or add one in the code editor:</div>
          <CodeSample lines={[["kw", "part"], ["sp", " "], ["id", "bracket"], ["sp", " {"], ["nl"], ["sp", "  "], ["kw", "body"], ["sp", " "], ["fn", "box"], ["sp", "("], ["num", "40"], ["sp", ", "], ["num", "20"], ["sp", ", "], ["num", "5"], ["sp", ")"], ["nl"], ["sp", "}"]]} />
        </div>
      )}
      {hiddenIds.length > 0 && (
        <button className="lp-hidden-bar" onClick={() => useView.setState({ hiddenIds: [] })}>
          <Icon.EyeOff size={13} />
          <span>
            {hiddenIds.length} hidden {hiddenIds.length === 1 ? "solid" : "solids"}
          </span>
          <span className="grow" />
          <span className="lp-link">Show all</span>
        </button>
      )}
      {filter && !visibleGroups.length && model.parts.length > 0 && <div className="lp-nomatch">No parts match “{filter}”.</div>}
      {visibleGroups.map(([group, rows], gi) => {
        const isCollapsed = collapsed.has(group) && !filter;
        const allIds = rows.flatMap((r) => r.ids);
        const groupHidden = allIds.every((id) => hiddenIds.includes(id));
        const groupBad = allIds.some((id) => failing.has(id));
        const total = rows.reduce((n, r) => n + r.count, 0);
        return (
          <section className={`lp-group ${isCollapsed ? "collapsed" : ""}`} key={group}>
            <div
              className="lp-group-head"
              role="button"
              tabIndex={0}
              aria-expanded={!isCollapsed}
              onClick={() => {
                const n = new Set(collapsed);
                if (n.has(group)) n.delete(group);
                else n.add(group);
                setCollapsed(n);
              }}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (e.currentTarget as HTMLElement).click())}
            >
              <span className="lp-chev">
                <Icon.Chevron size={11} />
              </span>
              <span className="lp-group-name">
                <Highlight text={group} q={filter} />
              </span>
              {groupBad && <span className="lp-dot fail" data-tip="A part here fails a check" />}
              <span className="lp-group-count" data-tip={total !== rows.length ? `${rows.length} entries, ${total} solids` : ""}>
                {total}
              </span>
              <button
                className={`lp-icon-btn lp-group-eye ${soloGroups.includes(group) ? "solo" : ""}`}
                aria-label={soloGroups.includes(group) ? `Show every group` : `Show ${group} on its own`}
                aria-pressed={soloGroups.includes(group)}
                data-tip={soloGroups.includes(group) ? "Show every group again" : "Show this group on its own (Shift adds it to those shown)"}
                onClick={(e) => {
                  e.stopPropagation();
                  soloGroup(group, e.shiftKey || e.metaKey || e.ctrlKey);
                }}
              >
                <Icon.Target size={13} />
              </button>
              <button
                className={`lp-icon-btn lp-group-eye ${groupHidden ? "on" : ""}`}
                aria-label={groupHidden ? `Show ${group}` : `Hide ${group}`}
                data-tip={groupHidden ? "Show group" : "Hide group"}
                onClick={(e) => {
                  e.stopPropagation();
                  useView.setState((s) => ({ hiddenIds: groupHidden ? s.hiddenIds.filter((x) => !allIds.includes(x)) : [...new Set([...s.hiddenIds, ...allIds])] }));
                }}
              >
                {groupHidden ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
              </button>
            </div>
            <AnimatePresence initial={false}>
              {!isCollapsed && (
                <motion.div className="lp-group-body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.2, 0.8, 0.2, 1] }}>
                  {rows.map((r, idx) => (
                    <PartRow key={r.name} r={r} filter={filter} delay={Math.min((gi * 3 + idx) * 0.018, 0.3)} selected={r.ids.some((id) => selected.includes(id))} hidden={r.ids.every((id) => hiddenIds.includes(id)) || r.part.hidden} fails={r.ids.flatMap((id) => failing.get(id) ?? [])} />
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </section>
        );
      })}
      {!filter && <ImportsSection />}
    </div>
  );
}

function DesignHeader({ name, notes }: { name: string; notes: string[] }) {
  const [open, setOpen] = useState(false);
  const long = notes.join(" ").length > 110 || notes.length > 1;
  return (
    <header className="lp-design">
      <div className="lp-design-name">{name || "Untitled design"}</div>
      {notes.length > 0 && (
        <div className={`lp-design-notes ${open ? "open" : ""} ${long ? "long" : ""}`}>
          {open ? notes.map((n, i) => <p key={i}>{n}</p>) : <p>{notes.join(" ")}</p>}
        </div>
      )}
      {long && (
        <button className="lp-link lp-design-more" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? "Less" : "More"}
        </button>
      )}
    </header>
  );
}

function PartRow({ r, filter, delay, selected, hidden, fails }: { r: Row; filter: string; delay: number; selected: boolean; hidden: boolean; fails: string[] }) {
  const playing = useView((s) => s.playing);
  const speed = useView((s) => s.speed);
  const selectedIds = useView((s) => s.selected);
  const ratio = r.part.motion?.ratio ?? 0;
  const spinStyle = { "--spin": `${Math.min(30, Math.max(0.4, 2.4 / (Math.abs(ratio) * Math.max(speed, 0.1))))}s`, "--spin-dir": ratio < 0 ? "reverse" : "normal" } as CSSProperties;
  const tip = [r.desc, r.part.kind === "component" && r.part.material ? r.part.material : "", r.count > 1 ? `${r.count} placed` : ""].filter(Boolean).join(" · ");
  return (
    <div
      className={`lp-row ${selected ? "selected" : ""} ${hidden ? "is-hidden" : ""} ${fails.length ? "is-failing" : ""}`}
      data-part={r.name}
      style={{ animationDelay: `${delay}s` }}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      onClick={(e) => {
        if (e.shiftKey || e.metaKey || e.ctrlKey) select(selected ? selectedIds.filter((x) => !r.ids.includes(x)) : [...selectedIds, ...r.ids]);
        else select(r.ids);
      }}
      onDoubleClick={() => revealSpan(r.part.span)}
      onContextMenu={(e) => {
        e.preventDefault();
        // from the keyboard (the menu key, Shift+F10) there is no pointer: open it by the row
        const at = e.clientX || e.clientY ? { x: e.clientX, y: e.clientY } : (({ left, bottom }) => ({ x: left + 24, y: bottom }))(e.currentTarget.getBoundingClientRect());
        openContextMenu(at, partRowMenuEntries(r.ids));
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") select(r.ids);
      }}
      onMouseEnter={() => useView.setState({ hovered: r.ids[0] })}
      onMouseLeave={() => useView.setState({ hovered: null })}
    >
      <Swatch material={r.part.material} finish={r.part.finish} color={r.part.color} size={14} render={32} />
      <span className="lp-kind">{kindIcon(r.part)}</span>
      <span className="lp-row-text" title={tip}>
        <span className="lp-row-name">
          <Highlight text={r.name} q={filter} />
        </span>
        {r.desc && (
          <span className="lp-row-desc">
            <Highlight text={r.desc} q={filter} />
          </span>
        )}
      </span>
      <span className="lp-row-badges">
        {fails.length > 0 && <span className="lp-dot fail" data-tip={fails.length === 1 ? fails[0] : `${fails.length} failing checks`} data-tip-pos="left" />}
        {ratio !== 0 && (
          <span className={`lp-spin ${playing ? "on" : ""}`} style={spinStyle} data-tip={`Turns at ${fmtNum(Math.abs(ratio), 3)}× the input`} data-tip-pos="left">
            <G.Spin size={12} />
          </span>
        )}
        {r.part.locked && (
          <span className="lp-lock" data-tip="Locked: Claude keeps it unchanged" data-tip-pos="left">
            <Icon.Lock size={11} />
          </span>
        )}
        {r.count > 1 && <span className="lp-mult">×{r.count}</span>}
      </span>
      <span className="lp-row-actions">
        <button
          className="lp-icon-btn"
          aria-label={hidden ? `Show ${r.name}` : `Hide ${r.name}`}
          onClick={(e) => {
            e.stopPropagation();
            useView.setState((s) => ({ hiddenIds: hidden ? s.hiddenIds.filter((x) => !r.ids.includes(x)) : [...new Set([...s.hiddenIds, ...r.ids])] }));
          }}
        >
          {hidden ? <Icon.EyeOff size={13} /> : <Icon.Eye size={13} />}
        </button>
        <button
          className="lp-icon-btn"
          aria-label={`Show ${r.name} in code`}
          onClick={(e) => {
            e.stopPropagation();
            revealSpan(r.part.span);
          }}
        >
          <Icon.Code size={13} />
        </button>
      </span>
    </div>
  );
}
