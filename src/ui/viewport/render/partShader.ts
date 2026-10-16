// Shader additions for part materials, patched into three's physical
// material: procedural surface detail in part coordinates (bump, roughness
// and colour variation), the dissolve used when a part is rebuilt, the scan
// glow of the build-in reveal, and a flash for parts that just changed.

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
  /** scan reveal: on (0/1), world z of the cut, band height */
  uScan: { value: THREE.Vector3 };
  uFlash: { value: number };
  /** extra strength for environment reflections (metals read brighter) */
  uEnvBoost: { value: number };
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
  };
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
varying vec3 vKObj;
varying vec3 vKObjN;
varying vec3 vKWorld;
${NOISE}

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
      .replace("#include <common>", "#include <common>\nvarying vec3 vKObj;\nvarying vec3 vKObjN;\nvarying vec3 vKWorld;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvKObj = position;\nvKObjN = normal;")
      .replace("#include <project_vertex>", "#include <project_vertex>\nvKWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\n" + DETAIL)
      .replace(
        "#include <clipping_planes_fragment>",
        `#include <clipping_planes_fragment>
  float kEdge = 0.0;
  if (uDissolve > 0.0) {
    float kn = kNoise(vKObj * uNoiseScale) * 0.65 + kNoise(vKObj * uNoiseScale * 3.1) * 0.35;
    float kt = uDissolve * 1.1 - 0.05;
    if (kn < kt) discard;
    kEdge = 1.0 - smoothstep(kt, kt + 0.045, kn);
  }
  vec3 kd = kDetail(vKObj, normalize(vKObjN));`,
      )
      .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, uTint2, clamp(kd.y * uTintAmt, 0.0, 1.0));")
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + kd.z, 0.03, 1.0);")
      .replace("#include <lights_fragment_maps>", "#include <lights_fragment_maps>\n  radiance *= uEnvBoost;")
      .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n  if (uDetail.y > 0.0) normal = kPerturb(-vViewPosition, normal, kd.x, faceDirection);")
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  totalEmissiveRadiance += uGlow * (kEdge * 3.0 + uFlash * 0.35);
  if (uScan.x > 0.5) {
    float kz = uScan.y - vKWorld.z;
    totalEmissiveRadiance += uGlow * 2.5 * step(0.0, kz) * (1.0 - smoothstep(0.0, uScan.z, kz));
  }`,
      );
  };
  mat.customProgramCacheKey = () => "kerf-part-2";
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
