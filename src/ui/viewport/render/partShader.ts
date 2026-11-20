// Shader additions for part materials, patched into three's physical
// material: procedural surface detail in part coordinates (bump, roughness
// and colour variation), the dissolve used when a part is rebuilt, the scan
// glow of the build-in reveal, a flash for parts that just changed (on the
// surfaces that changed, when the view can tell them apart), and the ripple
// that runs out from a click.

import * as THREE from "three";
import { Detail, Make, type Appearance } from "./appearance";

export interface PartUniforms {
  /** kind, amplitude (mm), period (mm), roughness variation */
  uDetail: { value: THREE.Vector4 };
  uTint2: { value: THREE.Color };
  uTintAmt: { value: number };
  /** 0 = solid, 1 = fully dissolved */
  uDissolve: { value: number };
  /** noise frequency for the dissolve, 1/mm */
  uNoiseScale: { value: number };
  /** HDR colour of glows (dissolve edge, scan line, flash) */
  uGlow: { value: THREE.Color };
  /** scan reveal: on (0/1), world z of the cut, band height */
  uScan: { value: THREE.Vector3 };
  uFlash: { value: number };
  /** extra strength for environment reflections (metals read brighter) */
  uEnvBoost: { value: number };
  /** plywood: the part's thin axis (0 x, 1 y, 2 z), its grain axis, where the plies start along the thin axis and each ply's thickness (0: faces only) */
  uPly: { value: THREE.Vector4 };
  /** 1 when the part's mesh has threads to draw on their stand-in cylinders (its aThread attribute) */
  uThreads: { value: number };
  /**
   * A rebuilt part, told apart from its old shape: x is 0 when off, 1 for the new mesh (it glows only where it differs
   * from the old one) and 2 for the old one (dropped where the new one matches it, dissolving elsewhere); y is how
   * far apart two meshes of one surface can be, mm
   */
  uChange: { value: THREE.Vector4 };
  /** the other mesh's depth as the view sees it (see ChangeDepth in scene.ts) */
  tChange: { value: THREE.Texture | null };
  /** 1 / its width, 1 / its height, the camera's near and far */
  uChangeView: { value: THREE.Vector4 };
  /** the click ripple: where it started (world) and how far it has run, mm */
  uRipple: { value: THREE.Vector4 };
  /** its strength (0: none) and the ring's width, mm */
  uRippleAmt: { value: THREE.Vector2 };
  /** how round the part's edges are, mm (its rounded-edge bands, see bevel.ts; 0: sharp) */
  uBevelR: { value: number };
  /** shared by every part: the size of a pixel per mm of distance from the camera, and the fewest pixels a round is drawn across */
  uBevelPx: { value: THREE.Vector2 };
  /** how the part was made (Make), and that process's value (FDM layer height, mm; 0 for its default) */
  uMake: { value: THREE.Vector2 };
  /** the part's box in its own frame: where it sat on the build plate, its lathe axis, its parting line */
  uKBox0: { value: THREE.Vector3 };
  uKBox1: { value: THREE.Vector3 };
  /** shared by every part: the set's fill light without its shadow-casting panels (StudioEnvironments.fill), and whether to use it */
  tFillEnv: { value: THREE.Texture | null };
  uFillOn: { value: number };
}

/** One for all parts (see PartUniforms.uBevelPx): the view sets it when its size or lens changes. */
export const BEVEL_PX = { value: new THREE.Vector2(0.002, 0.7) };

/**
 * One for all parts: the diffuse light from the set without the panels that light the model through shadow-casting
 * lights. Off (uFillOn 0) the whole environment lights it, as three.js does.
 */
export const FILL_ENV = { value: null as THREE.Texture | null };
export const FILL_ON = { value: 0 };

/** Set BEVEL_PX for a perspective camera drawing `heightPx` device pixels high. */
export function setBevelPixel(camera: THREE.PerspectiveCamera, heightPx: number) {
  BEVEL_PX.value.x = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, heightPx * camera.zoom);
}

export function partUniforms(): PartUniforms {
  return {
    uDetail: { value: new THREE.Vector4() },
    uTint2: { value: new THREE.Color() },
    uTintAmt: { value: 0 },
    uDissolve: { value: 0 },
    uNoiseScale: { value: 0.1 },
    uGlow: { value: new THREE.Color(0x6d8bff).multiplyScalar(2.2) },
    uScan: { value: new THREE.Vector3() },
    uFlash: { value: 0 },
    uEnvBoost: { value: 1 },
    uPly: { value: new THREE.Vector4(2, 0, 0, 0) },
    uThreads: { value: 0 },
    uChange: { value: new THREE.Vector4() },
    tChange: { value: null },
    uChangeView: { value: new THREE.Vector4(1, 1, 1, 1000) },
    uRipple: { value: new THREE.Vector4() },
    uRippleAmt: { value: new THREE.Vector2(0, 1) },
    uBevelR: { value: 0 },
    uBevelPx: BEVEL_PX,
    uMake: { value: new THREE.Vector2() },
    uKBox0: { value: new THREE.Vector3(-1, -1, -1) },
    uKBox1: { value: new THREE.Vector3(1, 1, 1) },
    tFillEnv: FILL_ENV,
    uFillOn: FILL_ON,
  };
}

/**
 * Where a plywood part's plies run, from its box in its own frame: the
 * thinnest side is the sheet's thickness, split into an odd number of plies
 * about 1.35 mm each (3 mm: 3, 9 mm: 7, 18 mm: 13), and the grain runs along
 * the longest side. Returns the uPly value.
 */
export function plyLayout(min: [number, number, number], max: [number, number, number]): [number, number, number, number] {
  const size = [0, 1, 2].map((k) => max[k] - min[k]);
  const thin = size.indexOf(Math.min(...size));
  const others = [0, 1, 2].filter((k) => k !== thin);
  const grain = size[others[0]] >= size[others[1]] ? others[0] : others[1];
  const t = size[thin];
  let n = Math.max(3, Math.round(t / 1.35));
  if (n % 2 === 0) n += 1;
  return [thin, grain, min[thin], t > 0 ? t / n : 0];
}

const NOISE = /* glsl */ `
float kHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float kNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(kHash(i), kHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(kHash(i + vec3(0.0, 1.0, 0.0)), kHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(kHash(i + vec3(0.0, 0.0, 1.0)), kHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(kHash(i + vec3(0.0, 1.0, 1.0)), kHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}
`;

/**
 * A thread drawn on the plain cylinder that stands in for it (see src/kernel/threadMarks.ts). Per vertex, aThread
 * holds: x = hand × (form × 65536 + starts × 4096 + turns), the same over the whole face; y = pitches along the axis
 * from the thread's start; zw = the cosine and sine of the angle round the axis, times the pitch. Returns the thread's
 * height in mm (for the bump) and how deep in a root the point is (for a little shade); zero off a thread, and fading
 * to zero where a pitch gets narrower than about two pixels.
 */
const THREAD = /* glsl */ `
vec2 kThread() {
  float ax = abs(vThreadCode);
  float on = step(0.5, ax);
  float form = floor(ax / 65536.0);
  float starts = floor((ax - form * 65536.0) / 4096.0);
  float turns = ax - form * 65536.0 - starts * 4096.0;
  vec2 cs = on > 0.5 ? vThread.yz : vec2(1.0, 0.0);
  float P = max(length(cs), 1e-4);
  float ph = vThread.x + sign(vThreadCode) * starts * atan(cs.y, cs.x) * 0.15915494;
  float fw = fwidth(vThread.x) + starts * (fwidth(cs.x) + fwidth(cs.y)) / (P * 6.2831853);
  float fade = on * (1.0 - smoothstep(0.22, 0.5, fw));
  // only between the thread's ends: a plain shank on the same axis stays plain
  float inside = step(-0.02, vThread.x) * step(vThread.x, turns + 0.02);
  float tri = 1.0 - abs(2.0 * fract(ph) - 1.0);
  // the flats at crest and root, as parts of a pitch: ISO 1/8 and 1/4, trapezoid and buttress wider, square nearly all
  vec2 flats = form < 0.5 ? vec2(0.125, 0.25) : form < 1.5 ? vec2(0.37, 0.37) : form < 2.5 ? vec2(0.47, 0.47) : vec2(0.15, 0.2);
  float prof = clamp((tri - flats.y) / max(1e-3, 1.0 - flats.x - flats.y), 0.0, 1.0);
  float depth = (form < 0.5 ? 0.541 : form < 2.5 ? 0.5 : 0.6) * P;
  float k = fade * inside;
  return vec2(prof * depth * k, (1.0 - prof) * k);
}
`;

const DETAIL = /* glsl */ `
uniform vec4 uDetail;
uniform vec3 uTint2;
uniform float uTintAmt;
uniform float uDissolve;
uniform float uNoiseScale;
uniform vec3 uGlow;
uniform vec3 uScan;
uniform float uFlash;
uniform float uEnvBoost;
uniform vec4 uPly;
uniform float uThreads;
uniform vec4 uChange;
uniform sampler2D tChange;
uniform vec4 uChangeView;
uniform vec4 uRipple;
uniform vec2 uRippleAmt;
uniform vec2 uMake;
uniform vec3 uKBox0;
uniform vec3 uKBox1;
varying vec3 vKObj;
varying vec3 vKObjN;
// 1 on a rounded-edge band (bevel.ts)
varying float vKBand;
varying vec3 vKWorld;
// the part's own axes as the view sees them, for the grain's direction
varying vec3 vKX;
varying vec3 vKY;
varying vec3 vKZ;
// which way the surface's marks run (part frame): highlights stretch across them
vec3 kGrain = vec3(1.0, 0.0, 0.0);
// how much the marks darken the colour (a cut edge's oxide, a parting line)
float kShade = 1.0;
flat varying float vThreadCode;
varying vec3 vThread;
${NOISE}
${THREAD}

float kViewZ(float d) {
  return (uChangeView.z * uChangeView.w) / ((uChangeView.w - uChangeView.z) * d - uChangeView.w);
}

// 0 where this fragment lies on the other mesh's surface (as seen through this pixel or one beside it), 1 where it
// is somewhere the other one isn't. The allowance grows where the surface is seen edge on, and with distance for the
// depth buffer's steps.
float kChangedHere(vec3 viewPos) {
  float z = viewPos.z;
  vec2 uv = gl_FragCoord.xy * uChangeView.xy;
  vec2 o = uChangeView.xy;
  float g = abs(z - kViewZ(texture2D(tChange, uv).x));
  g = min(g, abs(z - kViewZ(texture2D(tChange, uv + vec2(o.x, 0.0)).x)));
  g = min(g, abs(z - kViewZ(texture2D(tChange, uv - vec2(o.x, 0.0)).x)));
  g = min(g, abs(z - kViewZ(texture2D(tChange, uv + vec2(0.0, o.y)).x)));
  g = min(g, abs(z - kViewZ(texture2D(tChange, uv - vec2(0.0, o.y)).x)));
  vec3 fn = normalize(cross(dFdx(viewPos), dFdy(viewPos)));
  float facing = max(0.15, abs(dot(fn, normalize(viewPos))));
  float tol = uChange.y / facing + z * z / (uChangeView.z * 16777216.0) * 4.0;
  return smoothstep(tol, tol * 2.0, g);
}

// x: height (mm), y: pull toward the second tint, z: roughness change
vec3 kDetail(vec3 p, vec3 n) {
  int kind = int(uDetail.x + 0.5);
  float amp = uDetail.y;
  float sc = max(uDetail.z, 1e-4);
  float rv = uDetail.w;
  vec3 an = abs(n);
  if (kind == ${Detail.Layers}) {
    // FDM layer lines, printed along the part's Z
    if (uMake.y > 0.0) sc = uMake.y;
    if (n.z < -0.97 && p.z < uKBox0.z + sc * 0.5) {
      // the face that lay on the textured build plate: a fine pebbled grain, duller than the rest
      vec3 g = p / 0.11;
      float gfade = 1.0 - smoothstep(0.35, 0.9, length(fwidth(g)));
      float pe = kNoise(g) * 0.6 + kNoise(g * 2.3 + 5.1) * 0.4;
      return vec3(amp * 0.6 * pe * gfade, 0.15 * (1.0 - pe) * gfade, 0.12 + (pe - 0.5) * rv * gfade);
    }
    float q = p.z / sc;
    float fade = 1.0 - smoothstep(0.3, 0.75, fwidth(q));
    float w = 0.5 + 0.5 * cos(6.2831853 * q);
    w = clamp(w + (kNoise(vec3(p.xy * 0.35, floor(q))) - 0.5) * 0.35, 0.0, 1.0);
    float side = 1.0 - smoothstep(0.75, 0.97, an.z);
    float top = 1.0 - side;
    // top and bottom skins: fine diagonal extrusion lines
    float d = (p.x + p.y) / (sc * 2.0);
    float tf = 1.0 - smoothstep(0.3, 0.75, fwidth(d));
    float tw = 0.5 + 0.5 * cos(6.2831853 * d);
    float h = side * w * fade + top * tw * tf * 0.35;
    // the seam down the back, where each layer's outer wall starts and ends: a small blob per layer, wandering a little
    vec2 cxy = 0.5 * (uKBox0.xy + uKBox1.xy);
    vec2 rxy = p.xy - cxy;
    float ang = atan(rxy.y, rxy.x) - 1.5707963;
    ang = abs(ang - 6.2831853 * floor(ang / 6.2831853 + 0.5));
    float sd = ang * length(rxy) + (kHash(vec3(floor(q), 4.0, 2.0)) - 0.5) * 0.35;
    float sw = max(0.18, length(fwidth(p.xy)) * 1.5);
    float seam = side * fade * (1.0 - smoothstep(sw, sw * 2.2, sd)) * (0.18 / sw) * (0.55 + 0.45 * w);
    h += seam * 1.6;
    return vec3(amp * h, side * (1.0 - w) * fade + top * (1.0 - tw) * tf * 0.3, (h - 0.5 * (side * fade + top * tf * 0.35)) * rv - seam * 0.12);
  }
  if (kind == ${Detail.Machined} && an.z > 0.97) {
    // a face cut by a face mill: every tooth leaves an arc, the passes step across the face, each a shade apart
    float R = clamp(0.25 * max(uKBox1.x - uKBox0.x, uKBox1.y - uKBox0.y), 6.0, 32.0);
    float stepv = R * 1.4;
    float j = floor(p.y / stepv + 0.5);
    float dv = p.y - j * stepv;
    float dx = sqrt(max(R * R - dv * dv, 0.0));
    float ph = (p.x - dx) / (sc * 4.0);
    float fade = 1.0 - smoothstep(0.3, 0.8, fwidth(ph));
    float m = 0.5 + 0.5 * cos(6.2831853 * ph);
    float tone = kHash(vec3(j, 1.0, 2.0)) - 0.5;
    kGrain = vec3(-dv, dx, 0.0) / max(R, 1e-3);
    return vec3(amp * m * fade, 0.0, ((m - 0.5) * fade + tone * 0.5) * rv);
  }
  if (kind == ${Detail.Brushed} || kind == ${Detail.Machined}) {
    float stretch = kind == ${Detail.Brushed} ? 90.0 : 10.0;
    // streaks run along the axis that lies in the face
    kGrain = an.x > 0.8 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    // a milled wall: the cutter's steps run round it
    if (kind == ${Detail.Machined} && an.z < 0.3) kGrain = normalize(vec3(-n.y, n.x, 0.0) + 1e-5);
    vec3 q = an.x > 0.8 ? vec3(p.y / stretch, p.z, p.x) : vec3(p.x / stretch, p.y, p.z);
    q /= sc;
    float fade = 1.0 - smoothstep(0.4, 1.2, length(fwidth(q.yz)));
    float s = kNoise(q) * 0.65 + kNoise(q * vec3(1.0, 2.7, 2.7)) * 0.35;
    return vec3(amp * s * fade, 0.0, (s - 0.5) * rv * (0.35 + 0.65 * fade));
  }
  if (kind == ${Detail.Grain}) {
    vec3 q = p / sc;
    float fade = 1.0 - smoothstep(0.4, 1.0, length(fwidth(q)));
    float s = kNoise(q) * 0.6 + kNoise(q * 2.3) * 0.4;
    return vec3(amp * s * fade, 0.0, (s - 0.5) * rv * fade);
  }
  if (kind == ${Detail.Peel}) {
    vec3 q = p / sc;
    float s = kNoise(q) * 0.55 + kNoise(q * 2.1 + 3.7) * 0.3 + kNoise(q * 4.7) * 0.15;
    float fade = 1.0 - smoothstep(0.5, 1.5, length(fwidth(q)));
    return vec3(amp * s * fade, 0.0, (s - 0.5) * rv * fade);
  }
  if (kind == ${Detail.Weave}) {
    // 2x2 twill, projected on the face's dominant plane
    vec2 uv = an.z >= max(an.x, an.y) ? p.xy : (an.x >= an.y ? p.yz : p.xz);
    uv /= sc;
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    bool warp = mod(cell.x + cell.y, 4.0) < 2.0;
    // each tow's fibres run along it: its sheen stretches across
    vec3 ua = an.z >= max(an.x, an.y) ? vec3(1.0, 0.0, 0.0) : (an.x >= an.y ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0));
    vec3 va = an.z >= max(an.x, an.y) ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0);
    kGrain = warp ? ua : va;
    float across = warp ? f.y : f.x;
    float along = warp ? uv.x : uv.y;
    float bulge = sin(3.14159 * across);
    float fade = 1.0 - smoothstep(0.25, 0.6, length(fwidth(uv)));
    float fib = kNoise(vec3(along * 0.5, (warp ? uv.y : uv.x) * 30.0, cell.x * 1.7 + cell.y));
    return vec3(amp * bulge * fade, (warp ? 0.0 : 1.0) * fade + (fib - 0.5) * 0.3 * fade, ((warp ? -0.5 : 0.5) + (fib - 0.5)) * rv * fade);
  }
  if (kind == ${Detail.Wood}) {
    // growth rings around the part's X axis, with pores along the grain
    vec3 w = p + vec3(0.0, kNoise(p * vec3(0.02, 0.15, 0.15)) * 6.0, kNoise(p * vec3(0.02, 0.15, 0.15) + 7.1) * 6.0);
    float ring = fract(length(w.yz + vec2(37.0, -53.0)) / sc);
    float late = smoothstep(0.55, 0.9, ring) * (1.0 - smoothstep(0.92, 1.0, ring));
    float pore = kNoise(vec3(p.x * 0.08, p.y * 5.0, p.z * 5.0));
    float fade = 1.0 - smoothstep(0.6, 1.6, length(fwidth(p.yz / sc)));
    return vec3(amp * (late * 0.6 + pore * 0.4) * fade, (late * 0.85 + pore * 0.15) * mix(0.6, 1.0, fade), (pore - 0.5) * rv);
  }
  if (kind == ${Detail.Plywood}) {
    int ta = int(uPly.x + 0.5);
    int ga = int(uPly.y + 0.5);
    int oa = 3 - ta - ga;
    float pt = ta == 0 ? p.x : (ta == 1 ? p.y : p.z);
    float pg = ga == 0 ? p.x : (ga == 1 ? p.y : p.z);
    float po = oa == 0 ? p.x : (oa == 1 ? p.y : p.z);
    float nt = ta == 0 ? an.x : (ta == 1 ? an.y : an.z);
    float ng = ga == 0 ? an.x : (ga == 1 ? an.y : an.z);
    // the face veneer, peeled off the log: broad soft bands along the grain that wander across it,
    // thin darker late-wood lines, fine fibres and big gentle blotches of tone
    // the bands bunch up and spread out (q's spacing wanders), and each line has its own strength,
    // so the face never reads as evenly ruled stripes
    float wob = kNoise(vec3(pg * 0.004, po * 0.011, 1.3)) * 4.5 + kNoise(vec3(pg * 0.018, po * 0.045, 4.1)) * 1.1;
    float q = po / sc + wob + pg * 0.002;
    float band = fract(q);
    float bi = floor(q);
    float lineK = kHash(vec3(bi, 3.0, 9.0));
    lineK = 0.12 + 0.88 * lineK * lineK;
    float late = smoothstep(0.42, 0.84, band) * (1.0 - smoothstep(0.86, 1.0, band)) * lineK;
    float ffade = 1.0 - smoothstep(0.25, 0.7, fwidth(q));
    float fib = kNoise(vec3(pg * 0.11, po * 3.5, 2.0));
    float fibFade = 1.0 - smoothstep(0.3, 0.9, fwidth(po * 3.5));
    float blot = kNoise(vec3(pg * 0.006, po * 0.02, 7.7)) * 0.7 + kNoise(vec3(pg * 0.03, po * 0.08, 5.3)) * 0.3;
    float faceTone = 0.12 + late * 0.34 * ffade + (fib - 0.5) * 0.16 * fibFade + (blot - 0.5) * 0.36;
    float faceH = late * 0.6 * ffade + fib * 0.4 * fibFade;
    float onFace = uPly.w > 0.0 ? smoothstep(0.62, 0.9, nt) : 1.0;
    float plyW = max(uPly.w, 1e-3);
    // the edges: the plies, each other one showing its end grain, with a dark glue line between each
    float pl = (pt - uPly.z) / plyW;
    float k = floor(pl);
    float f = fract(pl);
    float pfade = 1.0 - smoothstep(0.35, 1.1, fwidth(pl));
    float glue = (1.0 - smoothstep(0.0, 0.05 + fwidth(pl), min(f, 1.0 - f))) * pfade;
    bool along = mod(k, 2.0) < 0.5;
    bool endGrain = (ng > 0.5) == along;
    float pore = kNoise(vec3(pg * 2.4, po * 2.4, pt * 7.0));
    float streak = kNoise(vec3(along ? pg * 0.12 : po * 0.12, pt * 9.0, k * 3.1));
    float edgeTone = (endGrain ? 0.5 + (pore - 0.5) * 0.35 : 0.12 + (streak - 0.5) * 0.25) * pfade + 0.3 * (1.0 - pfade);
    edgeTone = mix(edgeTone, 1.0, glue * 0.85);
    float edgeH = (endGrain ? pore * 0.8 : streak * 0.5) - glue;
    return vec3(amp * mix(edgeH, faceH, onFace), clamp(mix(edgeTone, faceTone, onFace), 0.0, 1.0), (mix(endGrain ? pore + 0.3 : streak, fib, onFace) - 0.5) * rv);
  }
  return vec3(0.0);
}

// The marks of how the part was made, on top of its finish (Make): x height (mm), y pull toward the second tint, z
// roughness change. Lines finer than a pixel fade out, keeping their average.
vec3 kMake(vec3 p, vec3 n) {
  int mk = int(uMake.x + 0.5);
  vec3 an = abs(n);
  vec3 c = 0.5 * (uKBox0 + uKBox1);
  vec3 ext = uKBox1 - uKBox0;
  if (mk == ${Make.Turned}) {
    // turned about Z: rings on the ends, fine feed lines round the sides, and the sheen runs round with them
    vec2 r2 = p.xy - c.xy;
    float r = length(r2);
    kGrain = r > 1e-4 ? vec3(-r2.y, r2.x, 0.0) / r : vec3(1.0, 0.0, 0.0);
    float ph = (an.z > 0.9 ? r : p.z) / 0.07;
    float fade = 1.0 - smoothstep(0.3, 0.8, fwidth(ph));
    float m = 0.5 + 0.5 * cos(6.2831853 * ph);
    float chatter = kNoise(vec3(r * 0.4, p.z * 0.4, 3.0)) - 0.5;
    return vec3(0.0015 * m * fade, 0.0, (m - 0.5) * 0.14 * fade + chatter * 0.05);
  }
  if (mk == ${Make.Moulded}) {
    // the parting line round its middle: a hair-thin ridge where the mould halves met
    float side = 1.0 - smoothstep(0.6, 0.9, an.z);
    float zp = c.z;
    float lw = max(0.05, fwidth(p.z) * 1.5);
    float line = side * (1.0 - smoothstep(lw, lw * 2.0, abs(p.z - zp))) * (0.05 / lw);
    // ejector pins underneath: faint rings on a grid, a touch glossier inside
    float pin = 0.0;
    float inner = 0.0;
    if (n.z < -0.97 && p.z < uKBox0.z + 0.05) {
      float pitch = clamp(min(ext.x, ext.y) * 0.5, 8.0, 30.0);
      vec2 g = mod(p.xy - c.xy + pitch * 0.5, pitch) - pitch * 0.5;
      float rr = length(g);
      float pr = clamp(pitch * 0.12, 1.0, 3.0);
      float pw = max(0.06, length(fwidth(p.xy)) * 1.5);
      pin = (1.0 - smoothstep(pw, pw * 2.0, abs(rr - pr))) * (0.06 / pw);
      inner = 1.0 - smoothstep(pr - pw, pr, rr);
    }
    kShade *= 1.0 - 0.25 * clamp(line + pin, 0.0, 1.0);
    return vec3(0.02 * line - 0.004 * pin, 0.0, -0.08 * line - 0.12 * inner);
  }
  if (mk == ${Make.Sheet}) {
    // a flat part cut from sheet: the cut edges show the beam's striations, slightly dark from the heat
    float t = min(ext.x, min(ext.y, ext.z));
    float mid = ext.x + ext.y + ext.z - t - max(ext.x, max(ext.y, ext.z));
    if (t > 0.25 * mid) return vec3(0.0);
    vec3 ta = ext.x <= min(ext.y, ext.z) ? vec3(1.0, 0.0, 0.0) : (ext.y <= ext.z ? vec3(0.0, 1.0, 0.0) : vec3(0.0, 0.0, 1.0));
    float across = abs(dot(n, ta));
    if (across > 0.3) return vec3(0.0);
    vec3 along = normalize(cross(ta, n) + 1e-5);
    float depth = dot(p - uKBox0, ta) / max(t, 1e-3);
    // the lines lag toward the beam's exit side
    float sCoord = dot(p, along) + depth * depth * 0.12;
    float fade = 1.0 - smoothstep(0.3, 0.9, fwidth(sCoord * 6.0));
    float st = kNoise(vec3(sCoord * 6.0, depth * 0.6, 1.7)) * 0.7 + kNoise(vec3(sCoord * 17.0, depth, 4.2)) * 0.3;
    kGrain = ta;
    kShade *= 0.8 - 0.1 * depth;
    return vec3(0.01 * st * fade, 0.0, 0.16 + (st - 0.5) * 0.2 * fade);
  }
  return vec3(0.0);
}

// The tangent frame anisotropic highlights use, from the grain (three.js builds it from UVs, which parts have none of)
mat3 kTangentFrame(vec3 n) {
  vec3 g = vKX * kGrain.x + vKY * kGrain.y + vKZ * kGrain.z;
  g -= n * dot(n, g);
  float l = length(g);
  g = l > 1e-4 ? g / l : normalize(cross(n, abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  // roughest across the grain (tbn[0]), smooth along it
  return mat3(cross(n, g), g, n);
}

// Bump from a height in mm (Mikkelsen, unnormalised so the slope stays true at every zoom)
vec3 kPerturb(vec3 pos, vec3 n, float h, float faceDir) {
  vec3 sx = dFdx(pos);
  vec3 sy = dFdy(pos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * faceDir;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - grad);
}
`;

/** three's normal_fragment_begin, with the tangent frame for anisotropy taken from the part's grain instead of UVs. */
const NORMAL_BEGIN = (() => {
  const src = THREE.ShaderChunk.normal_fragment_begin;
  const out = src.replace(/mat3 tbn = getTangentFrame\( - vViewPosition, normal,[\s\S]*?\);/, "mat3 tbn = kTangentFrame( normal );");
  if (out === src) throw new Error("three's normal_fragment_begin changed: update partShader's NORMAL_BEGIN");
  return out;
})();

/** Diffuse light from the set's fill map (FILL_ENV), the same lookup three.js makes in the full one. */
const FILL_PARS = /* glsl */ `
uniform sampler2D tFillEnv;
uniform float uFillOn;
vec3 kFillIrradiance(const in vec3 normal) {
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    if (uFillOn < 0.5) return getIBLIrradiance(normal);
    vec3 worldNormal = inverseTransformDirection(normal, viewMatrix);
    return PI * textureCubeUV(tFillEnv, envMapRotation * worldNormal, 1.0).rgb * envMapIntensity;
  #else
    return vec3(0.0);
  #endif
}
`;

/** three's lights_fragment_maps with the diffuse part taken from the fill map. */
const LIGHTS_MAPS = (() => {
  const src = THREE.ShaderChunk.lights_fragment_maps;
  const out = src.replace("iblIrradiance += getIBLIrradiance( geometryNormal );", "iblIrradiance += kFillIrradiance( geometryNormal );");
  if (out === src) throw new Error("three's lights_fragment_maps changed: update partShader's LIGHTS_MAPS");
  return out;
})();

/** Patch a part material once; its uniforms come from `u` so animations can drive them. */
export function patchPartMaterial(mat: THREE.MeshPhysicalMaterial, u: PartUniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        "#include <common>\nvarying vec3 vKObj;\nvarying vec3 vKObjN;\nvarying float vKBand;\nvarying vec3 vKWorld;\nvarying vec3 vKX;\nvarying vec3 vKY;\nvarying vec3 vKZ;\nattribute vec4 aThread;\nflat varying float vThreadCode;\nvarying vec3 vThread;\nattribute vec4 aBevel;\nuniform float uBevelR;\nuniform vec2 uBevelPx;",
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  // a rounded-edge band (bevel.ts): its inner side moves into the face by the round's width, never under a fraction of
  // a pixel (so far edges still catch the light) and never past what the face allows
  if (aBevel.w > 0.5) {
    float kL = length(aBevel.xyz);
    if (kL > 0.0 && uBevelR > 0.0) {
      float kDist = max(0.0, -(modelViewMatrix * vec4(transformed, 1.0)).z);
      transformed += aBevel.xyz * (min(kL, max(uBevelR, kDist * uBevelPx.x * uBevelPx.y)) / kL);
    }
  }
vKObj = transformed;
vKObjN = normal;
vKBand = aBevel.w;
vKX = normalize(normalMatrix * vec3(1.0, 0.0, 0.0));
vKY = normalize(normalMatrix * vec3(0.0, 1.0, 0.0));
vKZ = normalize(normalMatrix * vec3(0.0, 0.0, 1.0));
vThreadCode = aThread.x;
vThread = aThread.yzw;`,
      )
      .replace(
        "#include <project_vertex>",
        // the band lies on its face: drawn a hair nearer so the face never shows through it
        "#include <project_vertex>\nvKWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;\nif (aBevel.w > 0.5) gl_Position.z -= 2e-6 * gl_Position.w;",
      );
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + DETAIL)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
  float kChanged = 1.0;
  if (uChange.x > 0.5) {
    kChanged = kChangedHere(-vViewPosition);
    // the old shape where the new one matches it: the new one is drawn there
    if (uChange.x > 1.5 && kChanged < 0.5) discard;
  }
  float kEdge = 0.0;
  if (uDissolve > 0.0) {
    float kn = kNoise(vKObj * uNoiseScale) * 0.65 + kNoise(vKObj * uNoiseScale * 3.1) * 0.35;
    float kt = uDissolve * 1.1 - 0.05;
    if (kn < kt) discard;
    kEdge = 1.0 - smoothstep(kt, kt + 0.045, kn);
  }
  // a rounded edge carries its face's pattern: the pattern follows the flat face, not the round's turned normal
  vec3 kN = normalize(vKObjN);
  if (vKBand > 0.5) {
    vec3 kF = cross(dFdx(vKObj), dFdy(vKObj));
    if (dot(kF, kF) > 1e-20) kN = normalize(kF) * sign(dot(kF, kN) + 1e-9);
  }
  vec3 kd = kDetail(vKObj, kN);
  if (uMake.x > 0.5) kd += kMake(vKObj, kN);
  vec2 kThr = uThreads > 0.5 ? kThread() : vec2(0.0);`,
      )
      .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, uTint2, clamp(kd.y * uTintAmt, 0.0, 1.0));\n  diffuseColor.rgb *= (1.0 - 0.3 * kThr.y) * kShade;")
      .replace("#include <normal_fragment_begin>", NORMAL_BEGIN)
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + kd.z, 0.03, 1.0);")
      .replace("#include <envmap_physical_pars_fragment>", "#include <envmap_physical_pars_fragment>\n" + FILL_PARS)
      .replace("#include <lights_fragment_maps>", LIGHTS_MAPS + "\n  radiance *= uEnvBoost;")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n  if (uDetail.y > 0.0 || uThreads > 0.5) normal = kPerturb(-vViewPosition, normal, (uDetail.y > 0.0 ? kd.x : 0.0) + kThr.x, faceDirection);")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  // a new surface lights up from its rim (where it is seen edge on) inward; a whole rebuilt part just flashes
  float kFres = 1.0 - abs(dot(normal, normalize(vViewPosition)));
  totalEmissiveRadiance += uGlow * (kEdge * 3.0 + uFlash * (uChange.x > 0.5 ? kChanged * (0.7 + 1.6 * kFres * kFres) : 0.35));
  if (uRippleAmt.x > 0.0) {
    float kr = (distance(vKWorld, uRipple.xyz) - uRipple.w) / uRippleAmt.y;
    totalEmissiveRadiance += uGlow * uRippleAmt.x * exp(-kr * kr);
  }
  if (uScan.x > 0.5) {
    float kz = uScan.y - vKWorld.z;
    totalEmissiveRadiance += uGlow * 2.5 * step(0.0, kz) * (1.0 - smoothstep(0.0, uScan.z, kz));
  }`,
      );
  };
  // a mesh without threads has no aThread: its default, zero, draws none (whatever another program left at its slot)
  (mat as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aThread: [0, 0, 0, 0], aBevel: [0, 0, 0, 0] };
  mat.customProgramCacheKey = () => "kerf-part-10";
}

/** Copy an appearance into a material and its uniforms. */
export function applyAppearance(mat: THREE.MeshPhysicalMaterial, u: PartUniforms, a: Appearance) {
  mat.color.set(a.color);
  mat.metalness = a.metalness;
  mat.roughness = a.roughness;
  mat.clearcoat = a.clearcoat;
  mat.clearcoatRoughness = a.clearcoatRoughness;
  mat.sheen = a.sheen;
  mat.sheenRoughness = a.sheenRoughness;
  mat.sheenColor.set(a.color).lerp(new THREE.Color(1, 1, 1), 0.5);
  mat.transmission = a.transmission;
  mat.thickness = a.thickness;
  mat.ior = a.ior;
  mat.iridescence = a.iridescence;
  mat.iridescenceIOR = 1.8;
  mat.iridescenceThicknessRange = [180, 520];
  mat.specularIntensity = a.specularIntensity;
  u.uDetail.value.set(a.detail, a.detailAmp, a.detailScale, a.roughVar);
  u.uTint2.value.set(a.tint2);
  u.uTintAmt.value = a.tintAmt;
  u.uEnvBoost.value = a.envBoost;
  u.uBevelR.value = a.bevel;
  mat.anisotropy = a.aniso;
}

/**
 * The marks of how a part was made (Make, with its value) and its box in its own frame. A turned part's sheen runs
 * round its axis whatever its finish.
 */
export function applyMake(mat: THREE.MeshPhysicalMaterial, u: PartUniforms, a: Appearance, make: Make, value: number, box: THREE.Box3 | null) {
  u.uMake.value.set(make, value);
  if (box) {
    u.uKBox0.value.copy(box.min);
    u.uKBox1.value.copy(box.max);
  }
  mat.anisotropy = make === Make.Turned ? Math.max(a.aniso, 0.55) : a.aniso;
}

/** Section caps: the part colour with a fine hatch, glowing while a part is being revealed. */
export function capMaterial(): { mat: THREE.MeshBasicMaterial; uGlowAmt: { value: number }; uHatch: { value: number } } {
  const uGlowAmt = { value: 0 };
  const uHatch = { value: 7 };
  const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide });
  const glow = { value: new THREE.Color(0x6d8bff).multiplyScalar(2.4) };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uGlowAmt = uGlowAmt;
    shader.uniforms.uHatch = uHatch;
    shader.uniforms.uCapGlow = glow;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uGlowAmt;\nuniform float uHatch;\nuniform vec3 uCapGlow;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  float kh = fract((gl_FragCoord.x + gl_FragCoord.y) / uHatch);
  float kl = smoothstep(0.0, 0.12, kh) * (1.0 - smoothstep(0.38, 0.5, kh));
  diffuseColor.rgb *= mix(1.0, 0.62, kl);
  diffuseColor.rgb = mix(diffuseColor.rgb, uCapGlow, uGlowAmt);`,
      );
  };
  mat.customProgramCacheKey = () => "kerf-cap-1";
  return { mat, uGlowAmt, uHatch };
}
