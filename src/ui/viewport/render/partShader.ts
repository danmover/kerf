// Shader additions for part materials, patched into three's physical
// material: procedural surface detail in part coordinates (bump, roughness
// and colour variation), the dissolve used when a part is rebuilt, the scan
// glow of the build-in reveal (along the way the part is printed or cut),
// a flash for parts that just changed (on the surfaces that changed, when the
// view can tell them apart) and the front that sweeps the change through the
// part, the ripple that runs out from a click, and the pulse of a check that
// just failed. The part's edges get the outline that traces itself in.

import * as THREE from "three";
import { Detail, type Appearance } from "./appearance";

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
  /** scan reveal: on (0/1), where the fill has reached along uScanDir (world), band height */
  uScan: { value: THREE.Vector3 };
  /** the way the reveal fills (world, unit), and the pitch of the layer lines in its band (0: none), mm */
  uScanDir: { value: THREE.Vector4 };
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
  /** the front a change sweeps through the part with (see editSweep.ts): where it starts (world) and 0 off, 1 across, 2 out from there */
  uSweep: { value: THREE.Vector4 };
  /** the way it runs (world, unit) and how far, mm */
  uSweepDir: { value: THREE.Vector4 };
  /** how far it has run (0 to 1) and the width of its glowing band, as a part of the run */
  uSweepFront: { value: THREE.Vector2 };
  /** the outline drawing itself in (edges only): how far (0 to 1), on (0/1), and where the fill starts and how far it runs along uScanDir */
  uTrace: { value: THREE.Vector4 };
  /** a check's result landing on the part: its colour (HDR) and strength */
  uPulse: { value: THREE.Vector4 };
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
    uScanDir: { value: new THREE.Vector4(0, 0, 1, 0) },
    uFlash: { value: 0 },
    uEnvBoost: { value: 1 },
    uPly: { value: new THREE.Vector4(2, 0, 0, 0) },
    uThreads: { value: 0 },
    uChange: { value: new THREE.Vector4() },
    tChange: { value: null },
    uChangeView: { value: new THREE.Vector4(1, 1, 1, 1000) },
    uRipple: { value: new THREE.Vector4() },
    uRippleAmt: { value: new THREE.Vector2(0, 1) },
    uSweep: { value: new THREE.Vector4() },
    uSweepDir: { value: new THREE.Vector4(0, 0, 1, 1) },
    uSweepFront: { value: new THREE.Vector2(0, 0.12) },
    uTrace: { value: new THREE.Vector4() },
    uPulse: { value: new THREE.Vector4() },
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
uniform vec4 uScanDir;
uniform float uFlash;
uniform float uEnvBoost;
uniform vec4 uPly;
uniform float uThreads;
uniform vec4 uChange;
uniform sampler2D tChange;
uniform vec4 uChangeView;
uniform vec4 uRipple;
uniform vec2 uRippleAmt;
uniform vec4 uSweep;
uniform vec4 uSweepDir;
uniform vec2 uSweepFront;
uniform vec4 uPulse;
varying vec3 vKObj;
varying vec3 vKObjN;
varying vec3 vKWorld;
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

// how far along the sweep a point is, 0 to 1
float kSweepAt(vec3 p) {
  vec3 d = p - uSweep.xyz;
  return clamp((uSweep.w > 1.5 ? length(d) : dot(d, uSweepDir.xyz)) / max(uSweepDir.w, 1e-3), 0.0, 1.0);
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
    return vec3(amp * h, side * (1.0 - w) * fade + top * (1.0 - tw) * tf * 0.3, (h - 0.5 * (side * fade + top * tf * 0.35)) * rv);
  }
  if (kind == ${Detail.Brushed} || kind == ${Detail.Machined}) {
    float stretch = kind == ${Detail.Brushed} ? 90.0 : 10.0;
    // streaks run along the axis that lies in the face
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

/** Patch a part material once; its uniforms come from `u` so animations can drive them. */
export function patchPartMaterial(mat: THREE.MeshPhysicalMaterial, u: PartUniforms) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vKObj;\nvarying vec3 vKObjN;\nvarying vec3 vKWorld;\nattribute vec4 aThread;\nflat varying float vThreadCode;\nvarying vec3 vThread;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKObj = position;\nvKObjN = normal;\nvThreadCode = aThread.x;\nvThread = aThread.yzw;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvKWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + DETAIL)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
  float kChanged = 1.0;
  float kFront = 0.0;
  if (uChange.x > 0.5) {
    kChanged = kChangedHere(-vViewPosition);
    // the old shape where the new one matches it: the new one is drawn there
    if (uChange.x > 1.5 && kChanged < 0.5) discard;
    // a sweeping change: the new surfaces arrive behind the front, and the old ones go where the new surface seen
    // through the same pixel arrives, so the two swap over at once
    if (uSweep.w > 0.5 && kChanged > 0.5) {
      if (uChange.x > 1.5) {
        float kdn = texture2D(tChange, gl_FragCoord.xy * uChangeView.xy).x;
        vec3 kp = kdn < 0.99999 ? cameraPosition + (vKWorld - cameraPosition) * (kViewZ(kdn) / -vViewPosition.z) : vKWorld;
        float kAhead = kSweepAt(kp) - uSweepFront.x;
        if (kAhead < 0.0) discard;
        kFront = 1.0 - smoothstep(0.0, uSweepFront.y, kAhead);
      } else {
        float kBehind = uSweepFront.x - kSweepAt(vKWorld);
        if (kBehind < 0.0) discard;
        kFront = 1.0 - smoothstep(0.0, uSweepFront.y, kBehind);
      }
    }
  }
  float kEdge = 0.0;
  if (uDissolve > 0.0) {
    float kn = kNoise(vKObj * uNoiseScale) * 0.65 + kNoise(vKObj * uNoiseScale * 3.1) * 0.35;
    float kt = uDissolve * 1.1 - 0.05;
    if (kn < kt) discard;
    kEdge = 1.0 - smoothstep(kt, kt + 0.045, kn);
  }
  vec3 kd = kDetail(vKObj, normalize(vKObjN));
  vec2 kThr = uThreads > 0.5 ? kThread() : vec2(0.0);`,
      )
      .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, uTint2, clamp(kd.y * uTintAmt, 0.0, 1.0));\n  diffuseColor.rgb *= 1.0 - 0.3 * kThr.y;")
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + kd.z, 0.03, 1.0);")
      .replace("#include <lights_fragment_maps>", "#include <lights_fragment_maps>\n  radiance *= uEnvBoost;")
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
  totalEmissiveRadiance += uGlow * 2.6 * kFront;
  if (uScan.x > 0.5) {
    float kAlong = dot(vKWorld, uScanDir.xyz);
    float kz = uScan.y - kAlong;
    float kBand = step(0.0, kz) * (1.0 - smoothstep(0.0, uScan.z, kz));
    // a printed part's band shows its layers going down, fading out where they get too fine to see
    if (uScanDir.w > 0.0) {
      float kq = kAlong / uScanDir.w;
      float kLine = smoothstep(0.55, 0.95, abs(fract(kq) - 0.5) * 2.0);
      kBand *= mix(0.35 + 1.3 * kLine, 1.0, smoothstep(0.25, 0.6, fwidth(kq)));
    }
    totalEmissiveRadiance += uGlow * 2.5 * kBand;
  }
  totalEmissiveRadiance += uPulse.rgb * uPulse.w * (0.35 + 1.4 * kFres * kFres);`,
      );
  };
  // a mesh without threads has no aThread: its default, zero, draws none (whatever another program left at its slot)
  (mat as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aThread: [0, 0, 0, 0] };
  mat.customProgramCacheKey = () => "kerf-part-7";
}

/**
 * Patch a part's edge material: while a new part arrives (uTrace on), each edge draws itself in from one end (aOrder,
 * see traceOrder in arrival.ts), the ones low along the fill a little sooner, and the outline glows ahead of the fill.
 */
export function patchEdgeMaterial(mat: THREE.LineBasicMaterial, u: PartUniforms) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTrace = u.uTrace;
    shader.uniforms.uScan = u.uScan;
    shader.uniforms.uScanDir = u.uScanDir;
    shader.uniforms.uGlow = u.uGlow;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float aOrder;\nvarying float vKOrder;\nvarying vec3 vKWorldE;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKOrder = aOrder;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvKWorldE = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec4 uTrace;\nuniform vec3 uScan;\nuniform vec4 uScanDir;\nuniform vec3 uGlow;\nvarying float vKOrder;\nvarying vec3 vKWorldE;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  if (uTrace.y > 0.5) {
    float kAlong = dot(vKWorldE, uScanDir.xyz);
    float kHead = uTrace.x - (vKOrder * 0.6 + clamp((kAlong - uTrace.z) / max(uTrace.w, 1e-3), 0.0, 1.0) * 0.4);
    if (kHead < 0.0) discard;
    float kTip = 1.0 - smoothstep(0.0, 0.06, kHead);
    float kAbove = uScan.x > 0.5 ? step(uScan.y, kAlong) : 0.0;
    float kLit = max(kAbove, kTip);
    diffuseColor = vec4(mix(diffuseColor.rgb, uGlow * (0.45 + 2.4 * kTip), kLit), mix(diffuseColor.a, 1.0, kLit));
  }`,
      );
  };
  // edges drawn before their order is worked out (and the old ones of a rebuilt part) draw whole
  (mat as unknown as { defaultAttributeValues: Record<string, number[]> }).defaultAttributeValues = { aOrder: [0] };
  mat.customProgramCacheKey = () => "kerf-edge-1";
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
