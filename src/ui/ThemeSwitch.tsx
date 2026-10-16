// The light/dark switch: a moon in the dark theme that opens into a sun in
// the light one. Pressing it flips the theme, which opens from the button.

import { useId } from "react";
import { toggleTheme, useTheme } from "../app/theme";

export function ThemeSwitch({ size = 16 }: { size?: number }) {
  const theme = useTheme();
  const mask = useId();
  const next = theme === "light" ? "dark" : "light";
  return (
    <button className={`icon-btn theme-switch ${theme}`} onClick={(e) => toggleTheme(e)} data-tip={`Switch to the ${next} theme`} aria-label={`Switch to the ${next} theme`}>
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
        <mask id={mask}>
          <rect width="24" height="24" fill="#fff" />
          <circle className="ts-bite" cx="17" cy="7" r="6.5" fill="#000" />
        </mask>
        <circle className="ts-core" cx="12" cy="12" r="7.5" fill="currentColor" mask={`url(#${mask})`} />
        <g className="ts-rays" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line key={a} x1="12" y1="2.2" x2="12" y2="4.2" transform={`rotate(${a} 12 12)`} />
          ))}
        </g>
      </svg>
    </button>
  );
}
