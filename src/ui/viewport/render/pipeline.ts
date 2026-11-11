// Kerf's render pipeline. three.js draws the scene; this layer decides how
// the frame is built:
//
//   1. Render one sample of the scene into an HDR target (MSAA, linear light).
//   2. Ambient occlusion from that sample's depth.
//   3. Average the sample into an accumulation buffer. While the view is
//      still, each new sample moves the camera by a sub-pixel amount and the
//      key light across its area, so the image converges to clean edges,
//      soft area shadows and smooth occlusion. Any change starts again.
//   4. Composite: tone mapping, backdrop, bloom, selection outlines from a
//      mask, vignette and dithering, then overlays that are not accumulated.
//
// Nothing renders when the image has converged and nothing moves.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";
import { halton } from "./studio";

export type Quality = "draft" | "balanced" | "high";

export const SAMPLES: Record<Quality, number> = { draft: 1, balanced: 64, high: 256 };

export interface Look {
  exposure: number;
  bloom: number;
  vignette: number;
  bgTop: THREE.Color;
  bgBottom: THREE.Color;
  bgGlow: THREE.Color;
  glowAmt: number;
  /** ambient occlusion strength 0..1 */
  ao: number;
  /** AO radius in world units (mm) */
  aoRadius: number;
  selColor: THREE.Color;
  hoverColor: THREE.Color;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const AO_FRAG = /* glsl */ `
uniform sampler2D tDepth;
uniform mat4 uProj;
uniform mat4 uProjInv;
uniform vec2 uRes;
uniform float uRadius;
uniform float uSeed;
varying vec2 vUv;

vec3 viewPos(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  return v.xyz / v.w;
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
void main() {
  float d = texture2D(tDepth, vUv).x;
  if (d >= 0.999999) { gl_FragColor = vec4(1.0); return; }
  vec2 px = 1.0 / uRes;
  vec3 P = viewPos(vUv);
  vec3 Pr = viewPos(vUv + vec2(px.x, 0.0));
  vec3 Pl = viewPos(vUv - vec2(px.x, 0.0));
  vec3 Pu = viewPos(vUv + vec2(0.0, px.y));
  vec3 Pd = viewPos(vUv - vec2(0.0, px.y));
  vec3 dx = abs(Pr.z - P.z) < abs(P.z - Pl.z) ? Pr - P : P - Pl;
  vec3 dy = abs(Pu.z - P.z) < abs(P.z - Pd.z) ? Pu - P : P - Pd;
  vec3 N = normalize(cross(dx, dy));
  float rPx = uRadius * uProj[1][1] * 0.5 * uRes.y / max(-P.z, 1e-4);
  rPx = min(rPx, 0.12 * uRes.y);
  if (rPx < 1.5) { gl_FragColor = vec4(1.0); return; }
  float ang = hash12(gl_FragCoord.xy + uSeed * 17.0) * 6.2831853;
  float occ = 0.0;
  const int NS = 14;
  for (int i = 0; i < NS; i++) {
    float t = (float(i) + hash12(gl_FragCoord.yx + float(i) + uSeed)) / float(NS);
    float a = ang + float(i) * 2.39996323;
    vec2 suv = vUv + vec2(cos(a), sin(a)) * (rPx * t * t + 1.0) * px;
    if (suv.x <= 0.0 || suv.y <= 0.0 || suv.x >= 1.0 || suv.y >= 1.0) continue;
    if (texture2D(tDepth, suv).x >= 0.999999) continue;
    vec3 v = viewPos(suv) - P;
    float l2 = dot(v, v);
    float l = sqrt(l2) + 1e-5;
    float falloff = max(0.0, 1.0 - l2 / (uRadius * uRadius));
    occ += falloff * max(0.0, dot(v, N) / l - 0.08);
  }
  float ao = clamp(1.0 - 1.6 * occ / float(NS), 0.0, 1.0);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tAO;
uniform sampler2D tDepth;
uniform vec2 uRes;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
float lin(float d) {
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
void main() {
  vec2 px = 1.0 / uRes;
  float z0 = lin(texture2D(tDepth, vUv).x);
  float sum = 0.0;
  float wsum = 0.0;
  for (int x = -2; x <= 2; x++) {
    for (int y = -2; y <= 2; y++) {
      vec2 uv = vUv + vec2(float(x), float(y)) * px * 1.25;
      float z = lin(texture2D(tDepth, uv).x);
      float w = exp(-abs(z - z0) / (0.02 * z0 + 1e-4)) * (1.0 - 0.1 * float(x * x + y * y) / 8.0);
      sum += texture2D(tAO, uv).r * w;
      wsum += w;
    }
  }
  float ao = sum / max(wsum, 1e-4);
  gl_FragColor = vec4(ao, ao, ao, 1.0);
}`;

const ACCUM_FRAG = /* glsl */ `
uniform sampler2D tPrev;
uniform sampler2D tCur;
uniform sampler2D tAO;
uniform float uWeight;
uniform float uAO;
varying vec2 vUv;
void main() {
  vec4 cur = texture2D(tCur, vUv);
  float ao = mix(1.0, texture2D(tAO, vUv).r, uAO);
  cur.rgb *= ao;
  // occlusion darkens the backdrop seen through the ground's shadow catcher too
  cur.a = 1.0 - (1.0 - cur.a) * ao;
  if (uWeight >= 1.0) { gl_FragColor = cur; return; }
  gl_FragColor = mix(texture2D(tPrev, vUv), cur, uWeight);
}`;

const BLOOM_PRE = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-0.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.5, -0.5)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-0.5, 0.5)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.5, 0.5)).rgb;
  c *= 0.25;
  float br = max(c.r, max(c.g, c.b));
  float soft = clamp(br - uThreshold + 0.5, 0.0, 1.0);
  soft = soft * soft * 0.5;
  float k = max(soft, br - uThreshold) / max(br, 1e-4);
  gl_FragColor = vec4(c * k, 1.0);
}`;

const DOWN_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 8.0, 1.0);
}`;

const UP_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec3 c = vec3(0.0);
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 0.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, -1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(0.0, 1.0)).rgb * 2.0;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb;
  c += texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
  gl_FragColor = vec4(c / 12.0, 1.0);
}`;

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tAccum;
uniform sampler2D tBloom;
uniform sampler2D tMask;
uniform vec2 uRes;
uniform float uExposure;
uniform float uBloom;
uniform float uVignette;
uniform vec3 uBgTop;
uniform vec3 uBgBottom;
uniform vec3 uBgGlow;
uniform float uGlowAmt;
uniform float uTransparent;
uniform vec3 uSel;
uniform vec3 uHover;
uniform float uSelAmt;
uniform float uSelFill;
uniform float uHoverAmt;
uniform float uMask;
uniform float uPx;
uniform float uTime;
uniform float uEncode;
varying vec2 vUv;

// Khronos PBR Neutral: keeps product colours true while rolling off highlights
vec3 neutral(vec3 color) {
  const float start = 0.8 - 0.04;
  const float desat = 0.15;
  float x = min(color.r, min(color.g, color.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  color -= offset;
  float peak = max(color.r, max(color.g, color.b));
  if (peak < start) return color;
  float d = 1.0 - start;
  float newPeak = 1.0 - d * d / (peak + d - start);
  color *= newPeak / peak;
  float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
  return mix(color, vec3(newPeak), g);
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
void main() {
  vec4 s = texture2D(tAccum, vUv);
  float a = clamp(s.a, 0.0, 1.0);
  vec3 hdr = a > 1e-5 ? max(s.rgb, 0.0) / a : vec3(0.0);
  vec3 col = neutral(hdr * uExposure);

  float aspect = uRes.x / uRes.y;
  vec2 q = (vUv - vec2(0.5, 0.58)) * vec2(aspect, 1.0);
  float glow = exp(-dot(q, q) * 2.6);
  vec3 bg = mix(uBgBottom, uBgTop, smoothstep(-0.1, 1.05, vUv.y)) + uBgGlow * glow * uGlowAmt;

  vec3 outc = uTransparent > 0.5 ? col : col * a + bg * (1.0 - a);
  outc += neutral(texture2D(tBloom, vUv).rgb * uExposure) * uBloom;

  if (uMask > 0.5) {
    vec2 px = uPx / uRes;
    vec4 m = texture2D(tMask, vUv);
    vec3 ring = vec3(0.0);
    vec3 ring2 = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float ang = float(i) * 0.5235988;
      vec2 dir = vec2(cos(ang), sin(ang));
      ring = max(ring, texture2D(tMask, vUv + dir * px * 1.6).rgb);
      ring2 = max(ring2, texture2D(tMask, vUv + dir * px * 3.2).rgb);
    }
    float selEdge = clamp(max(ring.r, ring2.r * 0.55) - m.r, 0.0, 1.0);
    float hidEdge = clamp(ring.b - max(m.b, m.r), 0.0, 1.0);
    float hovEdge = clamp(max(ring.g, ring2.g * 0.4) - m.g, 0.0, 1.0);
    // fill keeps the surface's brightness so dark metals don't turn bright blue
    float lum = dot(outc, vec3(0.2126, 0.7152, 0.0722));
    vec3 tint = uSel * (lum / max(dot(uSel, vec3(0.2126, 0.7152, 0.0722)), 1e-4)) + uSel * 0.015;
    outc = mix(outc, tint, (m.r * 0.22 + m.b * (1.0 - m.r) * 0.06) * uSelAmt * uSelFill);
    outc = mix(outc, uSel, selEdge * uSelAmt);
    outc = mix(outc, uSel, hidEdge * 0.5 * uSelAmt);
    outc = mix(outc, uHover, (m.g * 0.07 + hovEdge * 0.75) * uHoverAmt * (1.0 - m.r));
  }

  float v = length((vUv - 0.5) * vec2(aspect * 0.8, 1.0));
  outc *= 1.0 - uVignette * smoothstep(0.35, 1.05, v);

  // an sRGB render target encodes on write (a capture): hand it linear colour, or it is encoded twice and comes out pale
  vec3 srgb = uEncode > 0.5 ? toSRGB(outc) + (hash(gl_FragCoord.xy + fract(uTime) * 61.0) - 0.5) / 255.0 : clamp(outc, 0.0, 1.0);
  gl_FragColor = uTransparent > 0.5 ? vec4(srgb, a) : vec4(srgb, 1.0);
}`;

// Edge-aware à-trous filter for a path traced image with few samples:
// neighbours count less the more their colour, coverage or depth differs.
const DENOISE_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uStep;
uniform float uSigma;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
float linDepth(vec2 uv) {
  float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}
vec3 squash(vec4 c) {
  vec3 h = c.a > 1e-4 ? max(c.rgb, 0.0) / c.a : vec3(0.0);
  return h / (1.0 + h);
}
float b3(int i) { return i == 0 ? 0.375 : (i == 1 ? 0.25 : 0.0625); }
void main() {
  vec4 c0 = texture2D(tSrc, vUv);
  vec3 s0 = squash(c0);
  float z0 = linDepth(vUv);
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 uv = vUv + vec2(float(i), float(j)) * uStep * uTexel;
      vec4 c = texture2D(tSrc, uv);
      vec3 d = squash(c) - s0;
      float z = linDepth(uv);
      float w = b3(i < 0 ? -i : i) * b3(j < 0 ? -j : j)
        * exp(-dot(d, d) / (uSigma * uSigma))
        * exp(-abs(c.a - c0.a) * 6.0)
        * exp(-abs(z - z0) / (0.015 * z0 + 0.05));
      sum += c * w;
      wsum += w;
    }
  }
  gl_FragColor = sum / max(wsum, 1e-6);
}`;

const PHOTO_MIX_FRAG = /* glsl */ `
uniform sampler2D tAccum;
uniform sampler2D tRaw;
uniform sampler2D tClean;
uniform float uMix;
uniform float uClean;
varying vec2 vUv;
// NaN or infinite, checked on the bits: compilers may fold isnan() away
bool bad(vec4 c) {
  uvec4 e = floatBitsToUint(c) & 0x7f800000u;
  return any(equal(e, uvec4(0x7f800000u)));
}
void main() {
  vec4 pt = mix(texture2D(tRaw, vUv), texture2D(tClean, vUv), uClean);
  // one bad value here would spread across the screen through the bloom
  if (bad(pt)) pt = vec4(0.0);
  gl_FragColor = mix(texture2D(tAccum, vUv), pt, uMix);
}`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }`;

function nearly(a: THREE.Matrix4, b: THREE.Matrix4) {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > 1e-6 * (1 + Math.abs(x[i]))) return false;
  return true;
}

function mat(frag: string, uniforms: Record<string, THREE.IUniform>, opts: Partial<THREE.ShaderMaterialParameters> = {}) {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...opts });
}

export class RenderPipeline {
  /** device pixels */
  width = 1;
  height = 1;
  pixelRatio = 1;
  samples = 0;
  maxSamples = SAMPLES.balanced;
  private sampleRT: THREE.WebGLRenderTarget;
  private aoRT: THREE.WebGLRenderTarget;
  private aoBlurRT: THREE.WebGLRenderTarget;
  private accum: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private cur = 0;
  readonly maskRT: THREE.WebGLRenderTarget;
  private bloomRTs: THREE.WebGLRenderTarget[] = [];
  private quad = new FullScreenQuad();
  private aoMat = mat(AO_FRAG, { tDepth: { value: null }, uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2() }, uRadius: { value: 10 }, uSeed: { value: 0 } });
  private blurMat = mat(BLUR_FRAG, { tAO: { value: null }, tDepth: { value: null }, uRes: { value: new THREE.Vector2() }, uNear: { value: 1 }, uFar: { value: 1000 } });
  private accumMat = mat(ACCUM_FRAG, { tPrev: { value: null }, tCur: { value: null }, tAO: { value: null }, uWeight: { value: 1 }, uAO: { value: 0.8 } });
  private preMat = mat(BLOOM_PRE, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 1.2 } });
  private downMat = mat(DOWN_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
  private upMat = mat(UP_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } }, { blending: THREE.AdditiveBlending, transparent: true });
  private copyMat = mat(COPY_FRAG, { tSrc: { value: null } });
  private denoiseMat = mat(DENOISE_FRAG, { tSrc: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 }, uSigma: { value: 0.2 }, uNear: { value: 1 }, uFar: { value: 1000 } });
  private photoMixMat = mat(PHOTO_MIX_FRAG, { tAccum: { value: null }, tRaw: { value: null }, tClean: { value: null }, uMix: { value: 0 }, uClean: { value: 0 } });
  /** path traced image, denoise ping-pong and the blend that composite() shows */
  private photoRTs: THREE.WebGLRenderTarget[] = [];
  private photoSrc: THREE.Texture | null = null;
  readonly compMat = mat(COMPOSITE_FRAG, {
    tAccum: { value: null },
    tBloom: { value: null },
    tMask: { value: null },
    uRes: { value: new THREE.Vector2() },
    uExposure: { value: 1 },
    uBloom: { value: 0 },
    uVignette: { value: 0.25 },
    uBgTop: { value: new THREE.Color() },
    uBgBottom: { value: new THREE.Color() },
    uBgGlow: { value: new THREE.Color() },
    uGlowAmt: { value: 0.5 },
    uTransparent: { value: 0 },
    uSel: { value: new THREE.Color() },
    uHover: { value: new THREE.Color() },
    uSelAmt: { value: 0 },
    uSelFill: { value: 1 },
    uHoverAmt: { value: 0 },
    uMask: { value: 0 },
    uPx: { value: 1 },
    uTime: { value: 0 },
    uEncode: { value: 1 },
  });
  private black: THREE.DataTexture;
  private savedProj = new THREE.Matrix4();
  private savedProjInv = new THREE.Matrix4();
  private lastView = new THREE.Matrix4();
  private lastProj = new THREE.Matrix4();
  private bloomFresh = false;
  look: Look = {
    exposure: 1,
    bloom: 0.1,
    vignette: 0.25,
    bgTop: new THREE.Color(),
    bgBottom: new THREE.Color(),
    bgGlow: new THREE.Color(),
    glowAmt: 0.5,
    ao: 0.85,
    aoRadius: 8,
    selColor: new THREE.Color(0x6d8bff),
    hoverColor: new THREE.Color(0x9fb2ff),
  };

  constructor(
    private r: THREE.WebGLRenderer,
    opts: { msaa?: number } = {},
  ) {
    const floatOk = r.extensions.has("EXT_color_buffer_float");
    const msaa = opts.msaa ?? 4;
    const depth = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    this.sampleRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: msaa, depthTexture: depth, depthBuffer: true });
    this.sampleRT.texture.name = "kerf.sample";
    const lin = { type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter } as const;
    this.aoRT = new THREE.WebGLRenderTarget(1, 1, lin);
    this.aoBlurRT = new THREE.WebGLRenderTarget(1, 1, lin);
    const acc = { type: floatOk ? THREE.FloatType : THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } as const;
    this.accum = [new THREE.WebGLRenderTarget(1, 1, acc), new THREE.WebGLRenderTarget(1, 1, acc)];
    this.maskRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.UnsignedByteType, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    for (let i = 0; i < 5; i++) this.bloomRTs.push(new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    this.black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    this.black.needsUpdate = true;
  }

  setSize(cssW: number, cssH: number, pixelRatio: number) {
    const w = Math.max(1, Math.round(cssW * pixelRatio));
    const h = Math.max(1, Math.round(cssH * pixelRatio));
    if (w === this.width && h === this.height && pixelRatio === this.pixelRatio) return;
    this.width = w;
    this.height = h;
    this.pixelRatio = pixelRatio;
    this.sampleRT.setSize(w, h);
    this.aoRT.setSize(w, h);
    this.aoBlurRT.setSize(w, h);
    this.accum[0].setSize(w, h);
    this.accum[1].setSize(w, h);
    this.maskRT.setSize(w, h);
    for (const rt of this.photoRTs) rt.setSize(w, h);
    let bw = w;
    let bh = h;
    for (const rt of this.bloomRTs) {
      bw = Math.max(1, Math.ceil(bw / 2));
      bh = Math.max(1, Math.ceil(bh / 2));
      rt.setSize(bw, bh);
    }
    this.reset();
  }

  reset() {
    this.samples = 0;
  }

  get done() {
    return this.samples >= this.maxSamples;
  }

  /** True when the camera moved since the last call (the accumulation must restart). */
  cameraMoved(camera: THREE.Camera): boolean {
    const v = camera.matrixWorldInverse;
    const p = camera.projectionMatrix;
    // orbit damping keeps nudging the camera by vanishing amounts; those do not count
    if (nearly(v, this.lastView) && nearly(p, this.lastProj)) return false;
    this.lastView.copy(v);
    this.lastProj.copy(p);
    return true;
  }

  /**
   * Render one more sample into the accumulation. `before(i)` runs first so the
   * caller can move lights for this sample; sample 0 is the unjittered view.
   */
  renderSample(scene: THREE.Scene, camera: THREE.PerspectiveCamera, before?: (i: number) => void) {
    const r = this.r;
    const i = this.samples;
    before?.(i);
    const jitter = i > 0;
    if (jitter) {
      this.savedProj.copy(camera.projectionMatrix);
      this.savedProjInv.copy(camera.projectionMatrixInverse);
      const jx = (halton(i, 2) - 0.5) * 2;
      const jy = (halton(i, 3) - 0.5) * 2;
      camera.projectionMatrix.elements[8] += jx / this.width;
      camera.projectionMatrix.elements[9] += jy / this.height;
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    const prevTarget = r.getRenderTarget();
    r.setRenderTarget(this.sampleRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, true);
    r.render(scene, camera);

    const useAO = this.look.ao > 0.01;
    if (useAO) {
      const u = this.aoMat.uniforms;
      u.tDepth.value = this.sampleRT.depthTexture;
      u.uProj.value.copy(camera.projectionMatrix);
      u.uProjInv.value.copy(camera.projectionMatrixInverse);
      u.uRes.value.set(this.width, this.height);
      u.uRadius.value = this.look.aoRadius;
      u.uSeed.value = i === 0 ? 0 : halton(i, 5) * 13.0;
      this.pass(this.aoMat, this.aoRT);
      const b = this.blurMat.uniforms;
      b.tAO.value = this.aoRT.texture;
      b.tDepth.value = this.sampleRT.depthTexture;
      b.uRes.value.set(this.width, this.height);
      b.uNear.value = camera.near;
      b.uFar.value = camera.far;
      this.pass(this.blurMat, this.aoBlurRT);
    }
    if (jitter) {
      camera.projectionMatrix.copy(this.savedProj);
      camera.projectionMatrixInverse.copy(this.savedProjInv);
    }

    const prev = this.accum[this.cur];
    const next = this.accum[1 - this.cur];
    const a = this.accumMat.uniforms;
    a.tPrev.value = prev.texture;
    a.tCur.value = this.sampleRT.texture;
    a.tAO.value = useAO ? this.aoBlurRT.texture : this.black;
    a.uAO.value = useAO ? this.look.ao : 0;
    a.uWeight.value = 1 / (i + 1);
    this.pass(this.accumMat, next);
    this.cur = 1 - this.cur;
    this.samples++;
    this.bloomFresh = false;
    r.setRenderTarget(prevTarget);
  }

  get accumTexture() {
    return this.accum[this.cur].texture;
  }

  private pass(m: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) {
    this.r.setRenderTarget(target);
    this.quad.material = m;
    this.quad.render(this.r);
  }

  private updateBloom() {
    if (this.bloomFresh) return;
    const src = this.photoSrc ?? this.accumTexture;
    const rts = this.bloomRTs;
    const p = this.preMat.uniforms;
    p.tSrc.value = src;
    p.uTexel.value.set(1 / this.width, 1 / this.height);
    this.pass(this.preMat, rts[0]);
    for (let i = 1; i < rts.length; i++) {
      const d = this.downMat.uniforms;
      d.tSrc.value = rts[i - 1].texture;
      d.uTexel.value.set(1 / rts[i - 1].width, 1 / rts[i - 1].height);
      this.pass(this.downMat, rts[i]);
    }
    for (let i = rts.length - 1; i > 0; i--) {
      const u = this.upMat.uniforms;
      u.tSrc.value = rts[i].texture;
      u.uTexel.value.set(1 / rts[i].width, 1 / rts[i].height);
      this.pass(this.upMat, rts[i - 1]);
    }
    this.bloomFresh = true;
  }

  /**
   * Draw the finished frame into `target` (null: the canvas). `transparent`
   * leaves the background clear (material swatches).
   */
  composite(target: THREE.WebGLRenderTarget | null, opts: { mask?: boolean; selAmt?: number; selFill?: number; hoverAmt?: number; transparent?: boolean; time?: number } = {}) {
    const look = this.look;
    const useBloom = look.bloom > 0.001;
    if (useBloom) this.updateBloom();
    const u = this.compMat.uniforms;
    u.tAccum.value = this.photoSrc ?? this.accumTexture;
    u.tBloom.value = useBloom ? this.bloomRTs[0].texture : this.black;
    u.tMask.value = opts.mask ? this.maskRT.texture : this.black;
    u.uMask.value = opts.mask ? 1 : 0;
    u.uRes.value.set(this.width, this.height);
    u.uExposure.value = look.exposure;
    u.uBloom.value = useBloom ? look.bloom : 0;
    u.uVignette.value = opts.transparent ? 0 : look.vignette;
    u.uBgTop.value.copy(look.bgTop);
    u.uBgBottom.value.copy(look.bgBottom);
    u.uBgGlow.value.copy(look.bgGlow);
    u.uGlowAmt.value = look.glowAmt;
    u.uTransparent.value = opts.transparent ? 1 : 0;
    u.uSel.value.copy(look.selColor);
    u.uHover.value.copy(look.hoverColor);
    u.uSelAmt.value = opts.selAmt ?? 0;
    u.uSelFill.value = opts.selFill ?? 1;
    u.uHoverAmt.value = opts.hoverAmt ?? 0;
    u.uPx.value = this.pixelRatio;
    u.uTime.value = opts.time ?? 0;
    u.uEncode.value = target?.texture.colorSpace === THREE.SRGBColorSpace ? 0 : 1;
    this.pass(this.compMat, target);
  }

  /**
   * Show a path traced image (premultiplied HDR, like the accumulation) in
   * place of the accumulation, `mix` of the way. While it has few samples it
   * is denoised, guided by the last interactive sample's depth.
   */
  photo(src: THREE.Texture | null, opts: { mix: number; samples: number; near: number; far: number } = { mix: 0, samples: 0, near: 1, far: 1000 }) {
    if (!src || opts.mix <= 0.001) {
      if (this.photoSrc) this.bloomFresh = false;
      this.photoSrc = null;
      return;
    }
    if (!this.photoRTs.length)
      for (let i = 0; i < 3; i++) this.photoRTs.push(new THREE.WebGLRenderTarget(this.width, this.height, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }));
    const [a, b, out] = this.photoRTs;
    const clean = Math.min(1, Math.max(0, 1 - opts.samples / 128));
    let cleanTex = src;
    if (clean > 0.01) {
      const d = this.denoiseMat.uniforms;
      d.tDepth.value = this.sampleRT.depthTexture;
      d.uTexel.value.set(1 / this.width, 1 / this.height);
      d.uNear.value = opts.near;
      d.uFar.value = opts.far;
      d.uSigma.value = 0.04 + 0.5 / Math.sqrt(Math.max(1, opts.samples));
      let from = src;
      const steps = [1, 2, 4];
      for (let i = 0; i < steps.length; i++) {
        const to = i % 2 ? b : a;
        d.tSrc.value = from;
        d.uStep.value = steps[i];
        this.pass(this.denoiseMat, to);
        from = to.texture;
      }
      cleanTex = from;
    }
    const m = this.photoMixMat.uniforms;
    m.tAccum.value = this.accumTexture;
    m.tRaw.value = src;
    m.tClean.value = cleanTex;
    m.uMix.value = opts.mix;
    m.uClean.value = clean;
    this.pass(this.photoMixMat, out);
    this.photoSrc = out.texture;
    this.bloomFresh = false;
  }

  /** Free the photoreal buffers (about 24 bytes a pixel) once the photoreal view is off. */
  releasePhoto() {
    this.photo(null);
    for (const rt of this.photoRTs) rt.dispose();
    this.photoRTs = [];
  }

  /** Copy a texture to a target (used to keep the last frame for crossfades). */
  copy(src: THREE.Texture, target: THREE.WebGLRenderTarget | null) {
    this.copyMat.uniforms.tSrc.value = src;
    this.pass(this.copyMat, target);
  }

  dispose() {
    this.sampleRT.depthTexture?.dispose();
    for (const rt of [this.sampleRT, this.aoRT, this.aoBlurRT, ...this.accum, this.maskRT, ...this.bloomRTs, ...this.photoRTs]) rt.dispose();
    for (const m of [this.aoMat, this.blurMat, this.accumMat, this.preMat, this.downMat, this.upMat, this.copyMat, this.compMat, this.denoiseMat, this.photoMixMat]) m.dispose();
    this.quad.dispose();
    this.black.dispose();
  }
}
