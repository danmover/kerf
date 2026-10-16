// Viewport lighting: studio presets, turning the light, and render quality.

import { Menu, Segmented } from "./common";
import { Icon } from "./icons";
import { LIGHTING, type LightingPreset } from "./viewport/render/studio";
import { useSettings, updateSettings, type Settings } from "../app/settings";

const QUALITY: { value: Settings["quality"]; label: string; note: string }[] = [
  { value: "draft", label: "Draft", note: "One pass per frame. Fastest on older laptops." },
  { value: "balanced", label: "Balanced", note: "Refines to soft shadows and clean edges a moment after you stop moving." },
  { value: "high", label: "High", note: "Four times the refinement and sharper shadow maps. Best for screenshots." },
];

const chip = (l: LightingPreset) => `radial-gradient(60px 40px at 50% 30%, ${l.backdrop.glow}55, transparent 70%), linear-gradient(180deg, ${l.backdrop.top}, ${l.backdrop.bottom})`;
const ball = (l: LightingPreset) => `radial-gradient(circle at 32% 28%, #ffffff 0, ${l.key.color} 9%, ${l.light ? "#b9c0cc" : "#7a8294"} 32%, ${l.light ? "#5d6573" : "#262b36"} 72%, ${l.backdrop.bottom} 100%)`;

export function LightingMenu() {
  const s = useSettings();
  const cur = LIGHTING.find((l) => l.id === s.lighting) ?? LIGHTING[0];
  return (
    <Menu
      width={300}
      trigger={(open, toggle) => (
        <button className={`icon-btn ${open ? "active" : ""}`} onClick={toggle} data-tip="Lighting and quality (L)" aria-label="Lighting and quality">
          <Icon.Sun />
        </button>
      )}
    >
      {() => (
        <div className="lighting-menu">
          <div className="menu-label">Lighting</div>
          <div className="light-grid" role="radiogroup" aria-label="Lighting">
            {LIGHTING.map((l) => (
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
        </div>
      )}
    </Menu>
  );
}
