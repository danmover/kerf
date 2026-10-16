// Studio lighting: each preset is a small HDR scene of softboxes and a sky
// dome, baked into an environment map for reflections and fill light, plus
// a matching key light that casts the shadows. Angles are in the Z-up world:
// azimuth from +X toward +Y, elevation above the ground.

import * as THREE from "three";

export type LightingId = "studio" | "showroom" | "blueprint" | "workshop" | "daylight";

interface Panel {
  az: number;
  el: number;
  w: number;
  h: number;
  /** HDR intensity */
  i: number;
  color: string;
  /** edge softness 0..1 */
  soft?: number;
  disc?: boolean;
  /** rotate the panel about its own normal, degrees */
  roll?: number;
}

export interface LightingPreset {
  id: LightingId;
  label: string;
  note: string;
  sky: { zenith: string; horizon: string; ground: string; i: number };
  panels: Panel[];
  key: { az: number; el: number; color: string; i: number; /** angular radius of the light, degrees: bigger is softer */ size: number };
  envIntensity: number;
  exposure: number;
  /** viewport background, sRGB */
  backdrop: { top: string; bottom: string; glow: string; glowAmt: number };
  grid: { minor: string; major: string; alpha: number };
  shadow: number;
  edge: { color: string; alpha: number };
  bloom: number;
  vignette: number;
  /** a light background (UI chrome over it should switch to dark text) */
  light?: boolean;
  /** the set in the light theme, for presets whose own set is dark: same lights, a pale backdrop */
  lightSet?: Pick<LightingPreset, "backdrop" | "grid" | "edge" | "vignette" | "bloom" | "shadow">;
}

export const LIGHTING: LightingPreset[] = [
  {
    id: "studio",
    label: "Studio",
    note: "Neutral softboxes on a dark set",
    sky: { zenith: "#8a909c", horizon: "#5a606b", ground: "#25272b", i: 1 },
    panels: [
      { az: -100, el: 42, w: 4, h: 4, i: 8, color: "#fff6ec", soft: 0.35 },
      { az: -40, el: 86, w: 8, h: 6, i: 4, color: "#ffffff", soft: 0.5 },
      { az: 22, el: 12, w: 6, h: 3.5, i: 2.2, color: "#e6eeff", soft: 0.6 },
      { az: 128, el: 18, w: 0.9, h: 6.5, i: 5.5, color: "#e3ebff", soft: 0.25 },
      { az: 205, el: 22, w: 0.9, h: 6.5, i: 3.5, color: "#fff2e6", soft: 0.25 },
      { az: -60, el: -35, w: 9, h: 9, i: 0.25, color: "#c9c3bb", soft: 0.8 },
      // lit cyclorama wall: gives polished metal something to reflect
      { az: -70, el: 4, w: 14, h: 2.6, i: 1.3, color: "#dde2ea", soft: 0.7 },
      { az: 110, el: 4, w: 14, h: 2.6, i: 0.7, color: "#dde2ea", soft: 0.7 },
    ],
    key: { az: -100, el: 42, color: "#fff4e8", i: 2.1, size: 7 },
    envIntensity: 1,
    exposure: 1,
    backdrop: { top: "#1d222c", bottom: "#090b0f", glow: "#2f3850", glowAmt: 0.55 },
    grid: { minor: "#262d3b", major: "#3a4560", alpha: 0.85 },
    shadow: 0.55,
    edge: { color: "#05070a", alpha: 0.5 },
    bloom: 0.1,
    vignette: 0.28,
    lightSet: {
      backdrop: { top: "#f1f3f7", bottom: "#c8cdd7", glow: "#ffffff", glowAmt: 0.45 },
      grid: { minor: "#cdd2dc", major: "#a9b2c2", alpha: 0.8 },
      shadow: 0.42,
      edge: { color: "#141924", alpha: 0.42 },
      bloom: 0.04,
      vignette: 0.1,
    },
  },
  {
    id: "showroom",
    label: "Showroom",
    note: "Bright white cyclorama for presentation shots",
    sky: { zenith: "#ffffff", horizon: "#e6e9ef", ground: "#a7acb4", i: 1.35 },
    panels: [
      { az: -100, el: 45, w: 4, h: 4, i: 6, color: "#ffffff", soft: 0.4 },
      { az: -30, el: 88, w: 9, h: 7, i: 3.2, color: "#ffffff", soft: 0.5 },
      { az: 30, el: 15, w: 6, h: 3.5, i: 2.2, color: "#f4f7ff", soft: 0.6 },
      { az: 135, el: 20, w: 1.1, h: 7, i: 4.5, color: "#ffffff", soft: 0.25 },
      { az: 210, el: 20, w: 1.1, h: 7, i: 4.5, color: "#ffffff", soft: 0.25 },
    ],
    key: { az: -100, el: 48, color: "#ffffff", i: 1.9, size: 10 },
    envIntensity: 1,
    exposure: 0.92,
    backdrop: { top: "#f4f6f9", bottom: "#cfd4dc", glow: "#ffffff", glowAmt: 0.35 },
    grid: { minor: "#c3c9d3", major: "#a2abba", alpha: 0.75 },
    shadow: 0.38,
    edge: { color: "#1a1e26", alpha: 0.42 },
    bloom: 0.06,
    vignette: 0.12,
    light: true,
  },
  {
    id: "blueprint",
    label: "Blueprint",
    note: "Deep blue set with accent rim lights",
    sky: { zenith: "#4a5f8f", horizon: "#26345a", ground: "#0b1020", i: 1 },
    panels: [
      { az: -100, el: 48, w: 3, h: 3, i: 6, color: "#e8eeff", soft: 0.35 },
      { az: -40, el: 85, w: 6, h: 4, i: 1.6, color: "#c9d6ff", soft: 0.5 },
      { az: 135, el: 16, w: 0.8, h: 7, i: 9, color: "#6d8bff", soft: 0.25 },
      { az: 205, el: 20, w: 0.8, h: 7, i: 6, color: "#4fd1c5", soft: 0.25 },
      { az: 30, el: 10, w: 5, h: 2.5, i: 0.9, color: "#8fa8ff", soft: 0.6 },
    ],
    key: { az: -100, el: 48, color: "#e3eaff", i: 1.8, size: 6 },
    envIntensity: 1,
    exposure: 1.02,
    backdrop: { top: "#13203d", bottom: "#05070d", glow: "#22356b", glowAmt: 0.7 },
    grid: { minor: "#1a2a4c", major: "#2d4680", alpha: 0.95 },
    shadow: 0.6,
    edge: { color: "#9fb2ff", alpha: 0.32 },
    bloom: 0.22,
    vignette: 0.32,
    // a whiteprint: pale blue paper with blue rules
    lightSet: {
      backdrop: { top: "#eaf0fb", bottom: "#bccbe8", glow: "#ffffff", glowAmt: 0.4 },
      grid: { minor: "#b6c6e6", major: "#7f98d0", alpha: 0.9 },
      shadow: 0.45,
      edge: { color: "#1b2a5e", alpha: 0.48 },
      bloom: 0.06,
      vignette: 0.12,
    },
  },
  {
    id: "workshop",
    label: "Workshop",
    note: "Warm lamp with cool window light",
    sky: { zenith: "#8f7f6e", horizon: "#5c4f43", ground: "#231d18", i: 1 },
    panels: [
      { az: -115, el: 38, w: 2.4, h: 2.4, i: 9, color: "#ffd2a0", soft: 0.35 },
      { az: 55, el: 24, w: 6, h: 4, i: 2.8, color: "#cfe0ff", soft: 0.3 },
      { az: -30, el: 85, w: 5, h: 4, i: 1.2, color: "#ffe7cc", soft: 0.5 },
      { az: 150, el: 18, w: 0.9, h: 6, i: 4, color: "#ffc58a", soft: 0.25 },
    ],
    key: { az: -115, el: 38, color: "#ffcf99", i: 2.3, size: 8 },
    envIntensity: 1,
    exposure: 1.02,
    backdrop: { top: "#26211c", bottom: "#0c0a09", glow: "#45362a", glowAmt: 0.55 },
    grid: { minor: "#2e2822", major: "#4a3e31", alpha: 0.85 },
    shadow: 0.55,
    edge: { color: "#0a0806", alpha: 0.5 },
    bloom: 0.12,
    vignette: 0.32,
    lightSet: {
      backdrop: { top: "#f5f1ea", bottom: "#d5cbbb", glow: "#fffaf0", glowAmt: 0.4 },
      grid: { minor: "#d9d0c2", major: "#b5a690", alpha: 0.8 },
      shadow: 0.45,
      edge: { color: "#241b12", alpha: 0.44 },
      bloom: 0.05,
      vignette: 0.14,
    },
  },
  {
    id: "daylight",
    label: "Daylight",
    note: "Clear sky and sun, crisp shadows",
    sky: { zenith: "#3f74cf", horizon: "#c4d8f0", ground: "#5d574e", i: 1.5 },
    panels: [{ az: -120, el: 55, w: 0.9, h: 0.9, i: 160, color: "#fff3df", soft: 0.4, disc: true }],
    key: { az: -120, el: 55, color: "#fff1dc", i: 2.9, size: 1.2 },
    envIntensity: 0.85,
    exposure: 0.9,
    backdrop: { top: "#7fa6db", bottom: "#e2e9f1", glow: "#ffffff", glowAmt: 0.25 },
    grid: { minor: "#b4c1d1", major: "#8e9fb6", alpha: 0.8 },
    shadow: 0.5,
    edge: { color: "#0f131b", alpha: 0.45 },
    bloom: 0.08,
    vignette: 0.15,
    light: true,
  },
];

/** A lighting preset as shown in a theme: in the light theme a dark set swaps to its pale backdrop. */
export function lightingPreset(id: string, theme: "dark" | "light" = "dark"): LightingPreset {
  const p = LIGHTING.find((l) => l.id === id) ?? LIGHTING[0];
  return theme === "light" && p.lightSet ? { ...p, ...p.lightSet, light: true } : p;
}

export const dirFrom = (azDeg: number, elDeg: number) => {
  const az = THREE.MathUtils.degToRad(azDeg);
  const el = THREE.MathUtils.degToRad(elDeg);
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el));
};

const lin = (hex: string, k = 1) => new THREE.Color(hex).multiplyScalar(k);

function skyMaterial(p: LightingPreset) {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uZenith: { value: lin(p.sky.zenith, p.sky.i) },
      uHorizon: { value: lin(p.sky.horizon, p.sky.i) },
      uGround: { value: lin(p.sky.ground, p.sky.i) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec3 vDir;
      uniform vec3 uZenith;
      uniform vec3 uHorizon;
      uniform vec3 uGround;
      void main() {
        float z = normalize(vDir).z;
        vec3 c = z > 0.0 ? mix(uHorizon, uZenith, pow(z, 0.55)) : mix(uHorizon, uGround, pow(-z, 0.35));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

function panelMesh(pn: Panel): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uColor: { value: lin(pn.color, pn.i) }, uSoft: { value: pn.soft ?? 0.3 }, uDisc: { value: pn.disc ? 1 : 0 } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      uniform vec3 uColor;
      uniform float uSoft;
      uniform float uDisc;
      void main() {
        vec2 q = abs(vUv - 0.5) * 2.0;
        float m = uDisc > 0.5
          ? 1.0 - smoothstep(1.0 - uSoft, 1.0, length(q))
          : (1.0 - smoothstep(1.0 - uSoft, 1.0, q.x)) * (1.0 - smoothstep(1.0 - uSoft, 1.0, q.y));
        float hot = 1.0 - 0.3 * dot(q, q);
        gl_FragColor = vec4(uColor * m * hot, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(pn.w, pn.h), mat);
  const dist = 12;
  mesh.position.copy(dirFrom(pn.az, pn.el).multiplyScalar(dist));
  mesh.up.set(0, 0, 1);
  if (Math.abs(pn.el) > 89) mesh.up.set(1, 0, 0);
  mesh.lookAt(0, 0, 0);
  if (pn.roll) mesh.rotateZ(THREE.MathUtils.degToRad(pn.roll));
  return mesh;
}

/** Bakes and caches the environment map for each preset. */
export class StudioEnvironments {
  private cache = new Map<LightingId, THREE.WebGLRenderTarget>();
  constructor(private renderer: THREE.WebGLRenderer) {}

  get(p: LightingPreset): THREE.Texture {
    let rt = this.cache.get(p.id);
    if (!rt) {
      const scene = new THREE.Scene();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(40, 64, 32), skyMaterial(p));
      scene.add(dome);
      for (const pn of p.panels) scene.add(panelMesh(pn));
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      rt = pmrem.fromScene(scene, 0, 0.1, 100);
      pmrem.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
      this.cache.set(p.id, rt);
    }
    return rt.texture;
  }

  dispose() {
    for (const rt of this.cache.values()) rt.dispose();
    this.cache.clear();
  }
}

/** Low-discrepancy sequence used for jitter: light positions, sub-pixel offsets, AO rotation. */
export function halton(i: number, base: number): number {
  let f = 1;
  let r = 0;
  let n = i;
  while (n > 0) {
    f /= base;
    r += f * (n % base);
    n = Math.floor(n / base);
  }
  return r;
}

/** Map a point in the unit square to the unit disc, keeping the samples evenly spread. */
export function concentricDisc(u: number, v: number): [number, number] {
  const a = 2 * u - 1;
  const b = 2 * v - 1;
  if (a === 0 && b === 0) return [0, 0];
  let r: number;
  let phi: number;
  if (Math.abs(a) > Math.abs(b)) {
    r = a;
    phi = (Math.PI / 4) * (b / a);
  } else {
    r = b;
    phi = Math.PI / 2 - (Math.PI / 4) * (a / b);
  }
  return [r * Math.cos(phi), r * Math.sin(phi)];
}
