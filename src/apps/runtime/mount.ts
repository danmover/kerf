// Puts an app on the screen: its panels on a grid that fits the space, a
// frame loop that redraws what changed, keyboard shortcuts for its controls,
// and, while it is being built, picking, moving and resizing panels.

import type { AppSpec, PanelSpec } from "../spec";
import type { SignalStore } from "../store";
import { el, forgetPalette } from "./draw";
import { makePanel, type AppHost, type PanelView } from "./panels";

export interface EditHooks {
  selected: number | null;
  onSelect(i: number | null): void;
  onMove(from: number, to: number): void;
  onResize(i: number, w: number, h: number): void;
}

export interface MountedApp {
  /** show a changed app (the design was edited); panels whose spec is unchanged keep their state */
  update(app: AppSpec): void;
  setEdit(e: EditHooks | null): void;
  /** the link went live or stopped: controls enable or disable */
  linkChanged(): void;
  destroy(): void;
  readonly root: HTMLElement;
}

const ROW = 88;
const GAP = 10;
const MIN_COL = 168;

const sameSpec = (a: PanelSpec, b: PanelSpec) => JSON.stringify({ ...a, span: undefined }) === JSON.stringify({ ...b, span: undefined });

export function mountApp(into: HTMLElement, app0: AppSpec, store: SignalStore, host: AppHost): MountedApp {
  let app = app0;
  const root = el("div", "kapp");
  const grid = el("div", "ka-grid");
  root.append(grid);
  into.append(root);
  root.tabIndex = -1;
  let views: PanelView[] = [];
  let edit: EditHooks | null = null;
  let cols = app.columns;
  const ctx = { store, host, window: app.window };

  const layout = () => {
    const w = grid.clientWidth || into.clientWidth || 1000;
    cols = Math.max(1, Math.min(app.columns, Math.floor((w + GAP) / (MIN_COL + GAP))));
    grid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    grid.style.gridAutoRows = `${ROW}px`;
    views.forEach((v) => {
      const w2 = Math.min(v.spec.w, cols);
      v.el.style.gridColumn = `span ${w2}`;
      // a panel squeezed narrower than asked grows taller instead, up to what it would have had
      const h = cols < v.spec.w && v.spec.kind !== "controls" ? Math.min(12, Math.ceil((v.spec.h * v.spec.w) / Math.max(1, w2) / 1.5)) : v.spec.h;
      v.el.style.gridRow = `span ${Math.max(v.spec.h, h)}`;
    });
  };

  const decorate = (v: PanelView, i: number) => {
    v.el.dataset.index = String(i);
    v.el.classList.toggle("ka-selected", edit?.selected === i);
    v.el.classList.toggle("ka-editing", !!edit);
    let grip = v.el.querySelector<HTMLElement>(".ka-grip");
    if (edit && !grip) {
      grip = el("div", "ka-grip");
      grip.title = "Drag to resize";
      v.el.append(grip);
      wireResize(v, grip);
    } else if (!edit && grip) grip.remove();
  };

  const build = () => {
    const old = views;
    views = app.panels.map((p, i) => {
      const keep = old.find((o) => o && sameSpec(o.spec, p));
      if (keep) {
        old[old.indexOf(keep)] = undefined as unknown as PanelView;
        keep.spec = p;
        return keep;
      }
      return makePanel(p, ctx);
    });
    for (const o of old) if (o) o.destroy();
    grid.replaceChildren(...views.map((v) => v.el));
    views.forEach(decorate);
    if (!views.length) grid.append(el("div", "ka-empty big", "This app has no panels yet."));
    layout();
    for (const v of views) v.update(true);
  };

  // ---------- editing: pick, move, resize ----------
  let drag: { from: number; over: number | null } | null = null;
  const indexAt = (x: number, y: number): number | null => {
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>(".ka-panel");
    return hit && grid.contains(hit) ? Number(hit.dataset.index) : null;
  };
  const onDown = (e: PointerEvent) => {
    if (!edit || e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest(".ka-grip")) return;
    const panel = t.closest<HTMLElement>(".ka-panel");
    if (!panel || !grid.contains(panel)) {
      if (t === grid || t === root) edit.onSelect(null);
      return;
    }
    const i = Number(panel.dataset.index);
    e.preventDefault();
    edit.onSelect(i);
    // dragging by the header moves it
    if (!t.closest(".ka-head")) return;
    drag = { from: i, over: null };
    panel.classList.add("ka-lifted");
    const move = (ev: PointerEvent) => {
      if (!drag) return;
      const over = indexAt(ev.clientX, ev.clientY);
      if (over !== drag.over) {
        grid.querySelector(".ka-drop")?.classList.remove("ka-drop");
        drag.over = over;
        if (over !== null && over !== drag.from) views[over]?.el.classList.add("ka-drop");
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      panel.classList.remove("ka-lifted");
      grid.querySelector(".ka-drop")?.classList.remove("ka-drop");
      const d = drag;
      drag = null;
      if (d && d.over !== null && d.over !== d.from) edit?.onMove(d.from, d.over);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  grid.addEventListener("pointerdown", onDown);

  function wireResize(v: PanelView, grip: HTMLElement) {
    grip.addEventListener("pointerdown", (e) => {
      if (!edit) return;
      e.preventDefault();
      e.stopPropagation();
      const i = Number(v.el.dataset.index);
      edit.onSelect(i);
      const r0 = v.el.getBoundingClientRect();
      const colW = (grid.clientWidth - GAP * (cols - 1)) / cols;
      let w = v.spec.w;
      let h = v.spec.h;
      const move = (ev: PointerEvent) => {
        w = Math.max(1, Math.min(cols, Math.round((ev.clientX - r0.left + GAP) / (colW + GAP))));
        h = Math.max(1, Math.min(12, Math.round((ev.clientY - r0.top + GAP) / (ROW + GAP))));
        v.el.style.gridColumn = `span ${w}`;
        v.el.style.gridRow = `span ${h}`;
        v.el.dataset.size = `${w} × ${h}`;
        v.resize();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        delete v.el.dataset.size;
        if (w !== v.spec.w || h !== v.spec.h) edit?.onResize(i, w, h);
        else layout();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  // ---------- keys for controls ----------
  const onKey = (e: KeyboardEvent) => {
    if (edit || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
    // only while the app is on screen and nothing else (a dialog) has the keyboard
    if (!root.isConnected || (t && t !== document.body && !root.contains(t))) return;
    for (const v of views) if (v.key(e.key)) return e.preventDefault();
  };
  window.addEventListener("keydown", onKey);

  // ---------- the frame loop ----------
  let raf = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    if (!root.isConnected || document.hidden) return;
    for (const v of views) v.update();
  };
  raf = requestAnimationFrame(frame);

  const ro = new ResizeObserver(() => {
    layout();
    for (const v of views) {
      v.resize();
      v.update(true);
    }
  });
  ro.observe(grid);
  const themeWatch = new MutationObserver(() => {
    forgetPalette();
    for (const v of views) v.update(true);
  });
  themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  build();

  return {
    root,
    update(next) {
      app = next;
      ctx.window = next.window;
      build();
    },
    setEdit(e) {
      edit = e;
      root.classList.toggle("ka-edit", !!e);
      views.forEach(decorate);
    },
    linkChanged() {
      for (const v of views) v.linkChanged();
    },
    destroy() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeWatch.disconnect();
      window.removeEventListener("keydown", onKey);
      grid.removeEventListener("pointerdown", onDown);
      for (const v of views) v.destroy();
      root.remove();
    },
  };
}
