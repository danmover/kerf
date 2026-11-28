// Studio lighting: each preset is a small HDR scene of softboxes and a sky
// dome, baked into an environment map for reflections and fill light, plus
// a matching key light that casts the shadows. Angles are in the Z-up world:
// azimuth from +X toward +Y, elevation above the ground.

import * as THREE from "three";

export type LightingId = "studio" | "showroom" | "blueprint" | "workshop" | "workbench" | "daylight";

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
  /**
   * The panel lights the model through a shadow-casting light (the key or one of `casters`), so the fill light baked
   * from the set leaves it out; reflections still show it.
   */
  cast?: boolean;
}

/** A light beside the key that casts shadows too: a big softbox's soft shadow, a window's. */
export interface Caster {
  az: number;
  el: number;
  color: string;
  i: number;
  /** angular radius, degrees */
  size: number;
}

/** What the model stands on, drawn and lit (render/ground.ts); its pattern is in mm, at real scale. */
export interface GroundLook {
  kind: "wood" | "concrete" | "pavement";
  color: string;
  color2: string;
  roughness: number;
  /** clear coat: an oiled bench, a sealed floor */
  coat: number;
}

export interface LightingPreset {
  id: LightingId;
  label: string;
  note: string;
  sky: { zenith: string; horizon: string; ground: string; i: number };
  panels: Panel[];
  key: { az: number; el: number; color: string; i: number; /** angular radius of the light, degrees: bigger is softer */ size: number };
  /** further lights that cast shadows (big softboxes, a window) */
  casters?: Caster[];
  /** a real ground the model stands on (a bench top, a floor), lit and shadowed; without one the set's backdrop shows under it */
  ground?: GroundLook;
  /** how much the floor mirrors the model (0..1) when glossy floors are on */
  gloss?: number;
  envIntensity: number;
  exposure: number;
  /** viewport background, sRGB */
  backdrop: { top: string; bottom: string; glow: string; glowAmt: number };
  grid: { minor: string; major: string; alpha: number };
  shadow: number;
  edge: { color: string; alpha: number };
  bloom: number;
  vignette: number;
  /** contact shadow on the floor: darkening right under the model, and the wider soft pool around it (0..1; defaults 0.85 and 0.5) */
  contact?: { near: number; pool: number };
  /** a soft spot of light on the floor under the model (dark sets: so the floor and the shadows on it show) */
  floorLight?: { color: string; amount: number };
  /** a light background (UI chrome over it should switch to dark text) */
  light?: boolean;
  /** the set in the light theme, for presets whose own set is dark: same lights, a pale backdrop */
  lightSet?: Pick<LightingPreset, "backdrop" | "grid" | "edge" | "vignette" | "bloom" | "shadow" | "contact" | "floorLight" | "gloss">;
}

export const LIGHTING: LightingPreset[] = [
  {
    id: "studio",
    label: "Studio",
    note: "Neutral softboxes on a dark set",
    sky: { zenith: "#8a909c", horizon: "#5a606b", ground: "#25272b", i: 1 },
    panels: [
      { az: -100, el: 42, w: 4, h: 4, i: 8, color: "#fff6ec", soft: 0.35, cast: true },
      { az: -40, el: 86, w: 8, h: 6, i: 4, color: "#ffffff", soft: 0.5, cast: true },
      { az: 22, el: 12, w: 6, h: 3.5, i: 2.2, color: "#e6eeff", soft: 0.6 },
      { az: 128, el: 18, w: 0.9, h: 6.5, i: 5.5, color: "#e3ebff", soft: 0.25 },
      { az: 205, el: 22, w: 0.9, h: 6.5, i: 3.5, color: "#fff2e6", soft: 0.25 },
      { az: -60, el: -35, w: 9, h: 9, i: 0.25, color: "#c9c3bb", soft: 0.8 },
      // lit cyclorama wall: gives polished metal something to reflect
      { az: -70, el: 4, w: 14, h: 2.6, i: 1.3, color: "#dde2ea", soft: 0.7 },
      { az: 110, el: 4, w: 14, h: 2.6, i: 0.7, color: "#dde2ea", soft: 0.7 },
    ],
    key: { az: -100, el: 42, color: "#fff4e8", i: 2.5, size: 7 },
    casters: [{ az: -40, el: 86, color: "#ffffff", i: 0.85, size: 16 }],
    gloss: 0.6,
    envIntensity: 1,
    exposure: 1,
    backdrop: { top: "#1d222c", bottom: "#090b0f", glow: "#2f3850", glowAmt: 0.55 },
    grid: { minor: "#262d3b", major: "#3a4560", alpha: 0.85 },
    shadow: 0.55,
    edge: { color: "#05070a", alpha: 0.5 },
    bloom: 0.1,
    vignette: 0.28,
    floorLight: { color: "#8a94a8", amount: 0.55 },
    lightSet: {
      backdrop: { top: "#f1f3f7", bottom: "#c8cdd7", glow: "#ffffff", glowAmt: 0.45 },
      grid: { minor: "#cdd2dc", major: "#a9b2c2", alpha: 0.8 },
      shadow: 0.42,
      edge: { color: "#141924", alpha: 0.42 },
      bloom: 0.04,
      vignette: 0.1,
      floorLight: { color: "#000000", amount: 0 },
      gloss: 0.4,
    },
  },
  {
    id: "showroom",
    label: "Showroom",
    note: "Bright white cyclorama for presentation shots",
    sky: { zenith: "#ffffff", horizon: "#e6e9ef", ground: "#a7acb4", i: 1.35 },
    panels: [
      { az: -100, el: 45, w: 4, h: 4, i: 6, color: "#ffffff", soft: 0.4, cast: true },
      { az: -30, el: 88, w: 9, h: 7, i: 3.2, color: "#ffffff", soft: 0.5, cast: true },
      { az: 30, el: 15, w: 6, h: 3.5, i: 2.2, color: "#f4f7ff", soft: 0.6 },
      { az: 135, el: 20, w: 1.1, h: 7, i: 4.5, color: "#ffffff", soft: 0.25 },
      { az: 210, el: 20, w: 1.1, h: 7, i: 4.5, color: "#ffffff", soft: 0.25 },
    ],
    key: { az: -100, el: 48, color: "#ffffff", i: 2.25, size: 10 },
    casters: [{ az: -30, el: 88, color: "#ffffff", i: 0.85, size: 18 }],
    gloss: 0.45,
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
      { az: -100, el: 48, w: 3, h: 3, i: 6, color: "#e8eeff", soft: 0.35, cast: true },
      { az: -40, el: 85, w: 6, h: 4, i: 1.6, color: "#c9d6ff", soft: 0.5 },
      { az: 135, el: 16, w: 0.8, h: 7, i: 9, color: "#6d8bff", soft: 0.25 },
      { az: 205, el: 20, w: 0.8, h: 7, i: 6, color: "#4fd1c5", soft: 0.25 },
      { az: 30, el: 10, w: 5, h: 2.5, i: 0.9, color: "#8fa8ff", soft: 0.6 },
    ],
    key: { az: -100, el: 48, color: "#e3eaff", i: 2.05, size: 6 },
    gloss: 0.5,
    envIntensity: 1,
    exposure: 1.02,
    backdrop: { top: "#13203d", bottom: "#05070d", glow: "#22356b", glowAmt: 0.7 },
    grid: { minor: "#1a2a4c", major: "#2d4680", alpha: 0.95 },
    shadow: 0.6,
    edge: { color: "#9fb2ff", alpha: 0.32 },
    bloom: 0.22,
    vignette: 0.32,
    floorLight: { color: "#4a6cc0", amount: 0.5 },
    // a whiteprint: pale blue paper with blue rules
    lightSet: {
      backdrop: { top: "#eaf0fb", bottom: "#bccbe8", glow: "#ffffff", glowAmt: 0.4 },
      grid: { minor: "#b6c6e6", major: "#7f98d0", alpha: 0.9 },
      shadow: 0.45,
      edge: { color: "#1b2a5e", alpha: 0.48 },
      bloom: 0.06,
      vignette: 0.12,
      floorLight: { color: "#000000", amount: 0 },
    },
  },
  {
    id: "workshop",
    label: "Workshop",
    note: "Warm lamp with cool window light",
    sky: { zenith: "#8f7f6e", horizon: "#5c4f43", ground: "#231d18", i: 1 },
    panels: [
      { az: -115, el: 38, w: 2.4, h: 2.4, i: 9, color: "#ffd2a0", soft: 0.35, cast: true },
      { az: 55, el: 24, w: 6, h: 4, i: 2.8, color: "#cfe0ff", soft: 0.3, cast: true },
      { az: -30, el: 85, w: 5, h: 4, i: 1.2, color: "#ffe7cc", soft: 0.5 },
      { az: 150, el: 18, w: 0.9, h: 6, i: 4, color: "#ffc58a", soft: 0.25 },
    ],
    key: { az: -115, el: 38, color: "#ffcf99", i: 2.55, size: 8 },
    casters: [{ az: 55, el: 24, color: "#cfe0ff", i: 0.5, size: 12 }],
    // a sealed concrete floor
    ground: { kind: "concrete", color: "#8a8680", color2: "#5f5c58", roughness: 0.5, coat: 0.25 },
    gloss: 0.2,
    envIntensity: 1,
    exposure: 1.02,
    backdrop: { top: "#26211c", bottom: "#0c0a09", glow: "#45362a", glowAmt: 0.55 },
    grid: { minor: "#2e2822", major: "#4a3e31", alpha: 0.4 },
    shadow: 0.55,
    edge: { color: "#0a0806", alpha: 0.5 },
    bloom: 0.12,
    vignette: 0.32,
    floorLight: { color: "#96806a", amount: 0.55 },
    lightSet: {
      backdrop: { top: "#f5f1ea", bottom: "#d5cbbb", glow: "#fffaf0", glowAmt: 0.4 },
      grid: { minor: "#d9d0c2", major: "#b5a690", alpha: 0.8 },
      shadow: 0.45,
      edge: { color: "#241b12", alpha: 0.44 },
      bloom: 0.05,
      vignette: 0.14,
      floorLight: { color: "#000000", amount: 0 },
    },
  },
  {
    id: "workbench",
    label: "Workbench",
    note: "An oiled beech bench under a warm lamp and a big window",
    sky: { zenith: "#9a8f82", horizon: "#5e5246", ground: "#6b5039", i: 1 },
    panels: [
      // the lamp over the bench
      { az: -130, el: 58, w: 1.8, h: 1.8, i: 16, color: "#ffd9ab", soft: 0.3, disc: true, cast: true },
      // a big window across the bench
      { az: 35, el: 28, w: 7, h: 5, i: 3, color: "#dfe9ff", soft: 0.35, cast: true },
      { az: -20, el: 85, w: 6, h: 3, i: 1.6, color: "#fff1e0", soft: 0.5 },
      // the wall behind the bench
      { az: 150, el: 12, w: 10, h: 2.5, i: 0.9, color: "#e9dccb", soft: 0.7 },
    ],
    key: { az: -130, el: 58, color: "#ffd6a3", i: 2.4, size: 5 },
    casters: [{ az: 35, el: 28, color: "#dfe9ff", i: 0.65, size: 14 }],
    ground: { kind: "wood", color: "#c3a27e", color2: "#957255", roughness: 0.42, coat: 0.3 },
    gloss: 0.12,
    envIntensity: 1,
    exposure: 1,
    backdrop: { top: "#2b241e", bottom: "#100d0a", glow: "#4a3a2c", glowAmt: 0.5 },
    grid: { minor: "#3a3027", major: "#5a4a3a", alpha: 0.2 },
    shadow: 0.55,
    edge: { color: "#0a0806", alpha: 0.5 },
    bloom: 0.1,
    vignette: 0.3,
    lightSet: {
      backdrop: { top: "#f4efe7", bottom: "#d8ccba", glow: "#fffaf0", glowAmt: 0.4 },
      grid: { minor: "#d9d0c2", major: "#b5a690", alpha: 0.6 },
      shadow: 0.45,
      edge: { color: "#241b12", alpha: 0.44 },
      bloom: 0.05,
      vignette: 0.14,
    },
  },
  {
    id: "daylight",
    label: "Outdoor",
    note: "Clear sky and sun on a concrete pad, crisp shadows",
    sky: { zenith: "#5884cc", horizon: "#cddcee", ground: "#7d776c", i: 1.5 },
    panels: [{ az: -120, el: 55, w: 0.9, h: 0.9, i: 160, color: "#fff3df", soft: 0.4, disc: true, cast: true }],
    key: { az: -120, el: 55, color: "#fff1dc", i: 3.3, size: 1.2 },
    ground: { kind: "pavement", color: "#b7b1a6", color2: "#8e897f", roughness: 0.85, coat: 0 },
    envIntensity: 0.85,
    exposure: 0.9,
    backdrop: { top: "#7fa6db", bottom: "#e2e9f1", glow: "#ffffff", glowAmt: 0.25 },
    grid: { minor: "#b4c1d1", major: "#8e9fb6", alpha: 0.4 },
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

/** The set as an HDR scene. `fill`: without the panels that light the model through shadow-casting lights. */
function studioScene(p: LightingPreset, fill = false) {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(40, 64, 32), skyMaterial(p)));
  for (const pn of p.panels) if (!(fill && pn.cast)) scene.add(panelMesh(pn));
  return scene;
}

function disposeScene(scene: THREE.Scene) {
  scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
}

/** Bakes and caches the environment map for each preset. */
export class StudioEnvironments {
  private cache = new Map<string, THREE.WebGLRenderTarget>();
  private cubes = new Map<LightingId, THREE.WebGLCubeRenderTarget>();
  /** one baker for every map: the shader it blurs with is built by the graphics card once */
  private pmrem: THREE.PMREMGenerator | null = null;
  constructor(private renderer: THREE.WebGLRenderer) {}

  /** Whether the maps of `p` are baked: get() and fill() draw nothing. */
  has(p: LightingPreset): boolean {
    return this.cache.has(p.id) && (!p.panels.some((pn) => pn.cast) || this.cache.has(`${p.id}:fill`));
  }

  /**
   * Goes through baking the maps of `p` and keeps none of it: for the graphics card to be handed the shaders a bake
   * is drawn with, by a renderer that draws nothing meanwhile (see ShaderGate.rehearse). The set's materials are
   * left as they are, so that the card keeps what it built for them: the bake itself, and every set after, use the
   * same shaders.
   */
  rehearse(p: LightingPreset) {
    for (const fill of p.panels.some((pn) => pn.cast) ? [false, true] : [false]) {
      if (this.cache.has(fill ? `${p.id}:fill` : p.id)) continue;
      const scene = studioScene(p, fill);
      try {
        this.baker().fromScene(scene, 0, 0.1, 100).dispose();
      } finally {
        scene.traverse((o) => {
          if (o instanceof THREE.Mesh) o.geometry.dispose();
        });
      }
    }
  }

  private baker(): THREE.PMREMGenerator {
    return (this.pmrem ??= new THREE.PMREMGenerator(this.renderer));
  }

  /** Prefiltered for the interactive view. */
  get(p: LightingPreset): THREE.Texture {
    return this.bake(p, false);
  }

  /**
   * The light a surface gets from the set apart from the panels standing in for shadow-casting lights (those light it
   * directly, shadowed): the view takes diffuse light from this one and reflections from get(). Same size as get().
   */
  fill(p: LightingPreset): THREE.Texture {
    return p.panels.some((pn) => pn.cast) ? this.bake(p, true) : this.bake(p, false);
  }

  private bake(p: LightingPreset, fill: boolean): THREE.Texture {
    const key = fill ? `${p.id}:fill` : p.id;
    let rt = this.cache.get(key);
    if (!rt) {
      const scene = studioScene(p, fill);
      try {
        rt = this.baker().fromScene(scene, 0, 0.1, 100);
      } finally {
        disposeScene(scene);
      }
      this.cache.set(key, rt);
    }
    return rt.texture;
  }

  /** Unfiltered HDR cube for the path tracer, which samples the lights in it directly. */
  cube(p: LightingPreset): THREE.CubeTexture {
    let rt = this.cubes.get(p.id);
    if (!rt) {
      rt = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType, generateMipmaps: false });
      const scene = studioScene(p);
      const cam = new THREE.CubeCamera(0.1, 100, rt);
      const r = this.renderer;
      const auto = r.autoClear;
      const prev = r.getRenderTarget();
      r.autoClear = true;
      cam.update(r, scene);
      r.autoClear = auto;
      r.setRenderTarget(prev);
      disposeScene(scene);
      this.cubes.set(p.id, rt);
    }
    return rt.texture;
  }

  /** Free the path tracer's cubes once the photoreal view is off. */
  releaseCubes() {
    for (const rt of this.cubes.values()) rt.dispose();
    this.cubes.clear();
  }

  /** The WebGL context was lost and restored: the maps went with the old one, so drop them (there is nothing left to free) and draw them again when asked. */
  forget() {
    this.cache.clear();
    this.cubes.clear();
    this.pmrem = null;
  }

  dispose() {
    for (const rt of this.cache.values()) rt.dispose();
    for (const rt of this.cubes.values()) rt.dispose();
    this.cache.clear();
    this.cubes.clear();
    this.pmrem?.dispose();
    this.pmrem = null;
  }
}

/**
 * Where each shadow-casting light stands for sample `i` of a picture, as the sample of its own disc (0: its centre):
 * the key first, then each of `casters` casters. Alone, the key takes a new place at every sample. With casters it
 * moves at even samples and the casters take turns at odd ones, so one shadow map is drawn anew per sample and each
 * light walks its own samples 1, 2, 3... however many share the picture's.
 *
 * It is every light's place at that sample, not only the one that moved for it: pictures drawn in turn (the view's
 * own and one drawn between its frames) then each find the lights where their own samples have them, whatever the
 * other left behind.
 */
export function lightSteps(i: number, casters: number): number[] {
  if (casters <= 0) return [i];
  // the casters' turns so far, counted from 0 (none before the first odd sample)
  const turns = ((i + 1) >> 1) - 1;
  const at = [i >> 1];
  for (let k = 0; k < casters; k++) at.push(turns >= k ? Math.floor((turns - k) / casters) + 1 : 0);
  return at;
}

/**
 * Sizes a shadow-casting light's map to a model of this size: square and deep enough to hold the model from wherever
 * the light stands (it stands twice the model's diagonal from its middle, see the scene's placeLight). A light made
 * with the renderer's own map sees 10 units across, whatever the model.
 */
export function fitShadowMap(shadow: THREE.DirectionalLightShadow, size: THREE.Vector3) {
  const r = Math.max(size.x, size.y, size.z, 20);
  const diag = Math.max(size.length(), 20);
  const ext = diag * 0.85;
  const c = shadow.camera;
  c.left = -ext;
  c.right = ext;
  c.top = ext;
  c.bottom = -ext;
  c.near = diag * 0.2;
  c.far = diag * 4;
  c.updateProjectionMatrix();
  shadow.normalBias = Math.max(0.02, r * 0.0025);
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
