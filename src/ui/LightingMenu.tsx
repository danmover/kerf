// Viewport lighting: studio presets, turning the light, and render quality.

import { Menu, Segmented } from "./common";
import { Icon } from "./icons";
import { LIGHTING, lightingPreset, type LightingPreset } from "./viewport/render/studio";
import { useSettings, updateSettings, type Settings } from "../app/settings";
import { useTheme } from "../app/theme";

const QUALITY: { value: Settings["quality"]; label: string; note: string }[] = [
  { value: "draft", label: "Draft", note: "One pass per frame. Fastest on older laptops." },
  { value: "balanced", label: "Balanced", note: "Refines to soft shadows and clean edges a moment after you stop moving." },
  { value: "high", label: "High", note: "Four times the refinement and sharper shadow maps. Best for screenshots." },
];

const PHOTO_NOTE: Record<Settings["quality"], string> = {
  draft: "Traces real light bounces, reflections and soft shadows once the view is still. Draft stops at 96 samples at half resolution.",
  balanced: "Traces real light bounces, reflections, glass and soft shadows once the view is still, refining up to 512 samples.",
  high: "Traces real light bounces, reflections, glass and soft shadows once the view is still, refining up to 2048 samples with 8 bounces.",
};

const chip = (l: LightingPreset) => `radial-gradient(60px 40px at 50% 30%, ${l.backdrop.glow}55, transparent 70%), linear-gradient(180deg, ${l.backdrop.top}, ${l.backdrop.bottom})`;
const ball = (l: LightingPreset) => `radial-gradient(circle at 32% 28%, #ffffff 0, ${l.key.color} 9%, ${l.light ? "#b9c0cc" : "#7a8294"} 32%, ${l.light ? "#5d6573" : "#262b36"} 72%, ${l.backdrop.bottom} 100%)`;

/** The look of the 3D view: lighting, quality, photoreal, and the grid and edges drawn over it. */
export function LightingMenu({ photoLook = false }: { photoLook?: boolean }) {
  const s = useSettings();
  // the tiles show each set as it looks in this theme
  const theme = useTheme();
  const sets = LIGHTING.map((l) => lightingPreset(l.id, theme));
  const cur = sets.find((l) => l.id === s.lighting) ?? sets[0];
  return (
    <Menu
      width={300}
      trigger={(open, toggle) => (
        <button className={`icon-btn ${open ? "active" : ""}`} onClick={toggle} data-tip="Look: lighting, quality, grid and edges (L)" aria-label="Lighting, quality, grid and edges">
          <Icon.Sun />
        </button>
      )}
    >
      {() => (
        <div className="lighting-menu">
          <div className="menu-label">Lighting</div>
          <div className="light-grid" role="radiogroup" aria-label="Lighting">
            {sets.map((l) => (
              <button key={l.id} role="radio" aria-checked={s.lighting === l.id} className={`light-tile ${s.lighting === l.id ? "active" : ""}`} onClick={() => updateSettings({ lighting: l.id })} data-tip={l.note}>
                <span className="light-chip" style={{ background: chip(l) }}>
                  <span className="light-ball" style={{ background: ball(l) }} />
                  <span className="light-floor" />
                </span>
                <span className="light-name">{l.label}</span>
              </button>
            ))}
          </div>
          <div className="light-note">{cur.note}</div>
          <div className="menu-label row" style={{ justifyContent: "space-between" }}>
            <span>Turn the light</span>
            <span className="mono" style={{ letterSpacing: 0 }}>
              {s.lightAngle}°
            </span>
          </div>
          <div style={{ padding: "2px 9px 2px" }}>
            <input className="slider" type="range" min={0} max={359} step={1} value={s.lightAngle} aria-label="Light direction" style={{ ["--p" as string]: `${(s.lightAngle / 359) * 100}%` }} onChange={(e) => updateSettings({ lightAngle: Number(e.target.value) })} />
          </div>
          <div className="light-note">Or hold Alt and drag across the model.</div>
          <div className="menu-label">Quality</div>
          <div style={{ padding: "0 9px" }}>
            <Segmented id="vp-quality" value={s.quality} options={QUALITY.map((q) => ({ value: q.value, label: q.label }))} onChange={(quality) => updateSettings({ quality })} />
          </div>
          <div className="light-note">{QUALITY.find((q) => q.value === s.quality)?.note}</div>
          <div className="menu-label">Photoreal</div>
          <button role="switch" aria-checked={s.photoreal} className={`photo-switch ${s.photoreal ? "on" : ""}`} onClick={() => updateSettings({ photoreal: !s.photoreal })}>
            <Icon.Aperture size={15} />
            <span className="grow">Path traced view (P)</span>
            <span className={`toggle ${s.photoreal ? "on" : ""}`} />
          </button>
          <div className="light-note">{PHOTO_NOTE[s.quality]}</div>
          <div className="menu-label">Show</div>
          <button role="switch" aria-checked={s.grid} className={`photo-switch ${s.grid ? "on" : ""}`} onClick={() => updateSettings({ grid: !s.grid })}>
            <Icon.Grid size={15} />
            <span className="grow">Floor grid</span>
            <span className={`toggle ${s.grid ? "on" : ""}`} />
          </button>
          <button role="switch" aria-checked={s.edges} className={`photo-switch ${s.edges ? "on" : ""}`} onClick={() => updateSettings({ edges: !s.edges })}>
            <Icon.Box size={15} />
            <span className="grow">Edges</span>
            <span className={`toggle ${s.edges ? "on" : ""}`} />
          </button>
          {photoLook && (s.grid || s.edges) && <div className="light-note">The photoreal view hides the grid and edges while it runs.</div>}
        </div>
      )}
    </Menu>
  );
}
