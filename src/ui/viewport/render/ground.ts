// What the model stands on. A set with a real ground (a beech bench top, a
// sealed concrete floor, an outdoor pad) draws it at real scale, lit by the
// set and shadowed by every light; the other sets keep their backdrop and
// catch only the shadows. A glossy floor mirrors the model: its parts are
// drawn once more from below the floor into a texture, on the view's first
// sample, and the floor shows them blurred by its roughness.

import * as THREE from "three";
import type { GroundLook } from "./studio";

/**
 * A shadow catcher that weighs each light's shadow by that light's share of the light: the key's shadow full and a
 * big softbox's faint, where three's ShadowMaterial darkens as much for each.
 */
export function shadowCatcher(): { mat: THREE.ShadowMaterial; weights: { value: number[] } } {
  const weights = { value: [1, 0, 0, 0] };
  const mat = new THREE.ShadowMaterial({ opacity: 0.5, transparent: true });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uShadowW = weights;
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <shadowmask_pars_fragment>",
      /* glsl */ `
uniform float uShadowW[4];
float getShadowMask() {
  float dark = 0.0;
  #if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS > 0
  DirectionalLightShadow directionalLight;
  #pragma unroll_loop_start
  for ( int i = 0; i < NUM_DIR_LIGHT_SHADOWS; i ++ ) {
    directionalLight = directionalLightShadows[ i ];
    dark += uShadowW[ i ] * ( 1.0 - ( receiveShadow ? getShadow( directionalShadowMap[ i ], directionalLight.shadowMapSize, directionalLight.shadowIntensity, directionalLight.shadowBias, directionalLight.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0 ) );
  }
  #pragma unroll_loop_end
  #endif
  return 1.0 - clamp(dark, 0.0, 1.0);
}`,
    );
  };
  mat.customProgramCacheKey = () => "kerf-catcher-1";
  return { mat, weights };
}

/** The mirror image shared by the floors that show it. */
interface MirrorUniforms {
  tMirror: { value: THREE.Texture | null };
  /** world → the mirror image's texture coordinates */
  uMirrorVP: { value: THREE.Matrix4 };
  /** how much the floor mirrors (0: none), and the blur, in texture coordinates */
  uMirror: { value: THREE.Vector2 };
}

const MIRROR_PARS = /* glsl */ `
uniform sampler2D tMirror;
uniform mat4 uMirrorVP;
uniform vec2 uMirror;
vec4 kMirror(vec3 world, float blur) {
  vec4 c = uMirrorVP * vec4(world, 1.0);
  if (c.w <= 0.0) return vec4(0.0);
  vec2 uv = c.xy / c.w;
  vec4 s = texture2D(tMirror, uv) * 0.2;
  // a soft cross of taps, wider the rougher the floor
  for (int k = 0; k < 8; k++) {
    float a = float(k) * 0.7853982 + 0.3927;
    float r = blur * (k < 4 ? 0.5 : 1.0);
    s += texture2D(tMirror, uv + vec2(cos(a), sin(a)) * r) * 0.1;
  }
  return s;
}`;

/** Draws the parts mirrored in the floor, for the floors to show. */
export class FloorMirror {
  readonly uniforms: MirrorUniforms = { tMirror: { value: null }, uMirrorVP: { value: new THREE.Matrix4() }, uMirror: { value: new THREE.Vector2() } };
  private rt: THREE.WebGLRenderTarget | null = null;
  private cam = new THREE.PerspectiveCamera();
  private bias = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
  /** the floor showed the mirror image when last drawn */
  ready = false;

  constructor(private r: THREE.WebGLRenderer) {}

  /** Draw the parts on `layer` as the floor at height `z` mirrors them for `camera`, at half the view's size. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, z: number, layer: number, width: number, height: number) {
    const w = Math.max(1, Math.round(width / 2));
    const h = Math.max(1, Math.round(height / 2));
    if (!this.rt) {
      this.rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 2, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
      this.uniforms.tMirror.value = this.rt.texture;
    } else if (this.rt.width !== w || this.rt.height !== h) this.rt.setSize(w, h);
    const cam = this.cam;
    // the camera's mirror image below the floor, looking up at the parts
    const e = camera.matrixWorld.elements;
    const fwd = new THREE.Vector3(-e[8], -e[9], -e[10]);
    const up = new THREE.Vector3(e[4], e[5], e[6]);
    cam.position.set(camera.position.x, camera.position.y, 2 * z - camera.position.z);
    cam.up.set(up.x, up.y, -up.z);
    cam.lookAt(cam.position.x + fwd.x, cam.position.y + fwd.y, cam.position.z - fwd.z);
    cam.projectionMatrix.copy(camera.projectionMatrix);
    cam.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    cam.updateMatrixWorld();
    cam.layers.set(layer);
    this.uniforms.uMirrorVP.value.multiplyMatrices(this.bias, cam.projectionMatrix).multiply(cam.matrixWorldInverse);

    const r = this.r;
    const prevTarget = r.getRenderTarget();
    const prevShadow = r.shadowMap.autoUpdate;
    const prevAuto = r.autoClear;
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevBg = scene.background;
    // the shadows are the view's own: not drawn again for the mirror's camera
    r.shadowMap.autoUpdate = false;
    r.autoClear = false;
    scene.background = null;
    r.setRenderTarget(this.rt);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(scene, cam);
    scene.background = prevBg;
    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);
    r.autoClear = prevAuto;
    r.shadowMap.autoUpdate = prevShadow;
    this.ready = true;
  }

  /** Free the image (glossy floors off). */
  release() {
    this.rt?.dispose();
    this.rt = null;
    this.uniforms.tMirror.value = null;
    this.ready = false;
  }

  dispose() {
    this.release();
  }
}

/**
 * The mirror image alone, over the backdrop of a set without a ground: a dark studio floor's gloss. It fades out
 * with distance from the model and is stronger toward grazing views.
 */
export function mirrorPlane(m: FloorMirror): { mesh: THREE.Mesh; fade: { value: THREE.Vector4 } } {
  // centre (x, y) and the distances it starts and finishes fading out
  const fade = { value: new THREE.Vector4(0, 0, 1, 2) };
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { ...m.uniforms, uFade: fade },
    vertexShader: /* glsl */ `
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      ${MIRROR_PARS}
      uniform vec4 uFade;
      varying vec3 vW;
      void main() {
        vec4 s = kMirror(vW, uMirror.y);
        vec3 v = normalize(cameraPosition - vW);
        float graze = 1.0 - abs(v.z);
        float k = uMirror.x * mix(0.55, 1.0, graze * graze) * (1.0 - smoothstep(uFade.z, uFade.w, length(vW.xy - uFade.xy)));
        float a = clamp(s.a * k, 0.0, 1.0);
        // the image is premultiplied by how much of each pixel a part covers
        gl_FragColor = vec4(s.a > 1e-4 ? s.rgb / s.a : vec3(0.0), a);
      }`,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  mesh.renderOrder = -2;
  mesh.frustumCulled = false;
  mesh.layers.set(0);
  mesh.visible = false;
  return { mesh, fade };
}

const GROUND_PARS = /* glsl */ `
uniform float uGKind;
uniform vec3 uGC1;
uniform vec3 uGC2;
uniform vec4 uGFade;
varying vec3 vGW;
${MIRROR_PARS}
float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float gNoise(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(gHash(i), gHash(i + vec2(1.0, 0.0)), f.x), mix(gHash(i + vec2(0.0, 1.0)), gHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float gFbm(vec2 x) {
  return gNoise(x) * 0.5 + gNoise(x * 2.03 + 1.7) * 0.27 + gNoise(x * 4.1 + 3.1) * 0.15 + gNoise(x * 8.3 + 5.3) * 0.08;
}
// x: tone (0 light colour .. 1 dark colour), y: roughness change, z: height (mm)
vec3 gPattern(vec2 p) {
  int kind = int(uGKind + 0.5);
  if (kind == 0) {
    // butcher-block beech: strips 30 to 45 mm wide along X, each its own tone, with grain and glue lines
    float y0 = p.y / 38.0;
    float j = floor(y0);
    float v = fract(y0);
    float tone = gHash(vec2(j, 7.0));
    float warp = gNoise(vec2(p.x * 0.004, j * 3.7)) * 9.0 + gNoise(vec2(p.x * 0.02, j)) * 1.5;
    float ring = fract((v * 38.0 + warp) / (1.1 + tone * 0.9));
    float late = smoothstep(0.55, 0.9, ring) * (1.0 - smoothstep(0.9, 1.0, ring));
    float fade = 1.0 - smoothstep(0.3, 0.9, fwidth((v * 38.0 + warp) / 1.5));
    float pore = gNoise(vec2(p.x * 0.25, p.y * 6.0));
    float glue = 1.0 - smoothstep(0.0, max(0.006, fwidth(y0) * 1.5), min(v, 1.0 - v));
    float t = 0.18 + tone * 0.24 + late * 0.3 * fade + (pore - 0.5) * 0.12 + glue * 0.45;
    return vec3(clamp(t, 0.0, 1.0), (pore - 0.5) * 0.08 + glue * 0.2, late * 0.004 * fade - glue * 0.03);
  }
  if (kind == 1) {
    // sealed concrete: broad cloudy tone, fine aggregate flecks, a few stains, saw-cut joints every 3 m
    float cloud = gFbm(p * 0.0025) * 0.7 + gFbm(p * 0.012 + 9.0) * 0.3;
    float fleck = gNoise(p * 0.55);
    float fw = fwidth(p.x * 0.55);
    float flecks = (smoothstep(0.78, 0.86, fleck) * 0.5 - smoothstep(0.82, 0.9, gNoise(p * 0.7 + 4.0)) * 0.6) * (1.0 - smoothstep(0.4, 1.0, fw));
    float stain = smoothstep(0.62, 0.8, gFbm(p * 0.0012 + 3.0)) * 0.5;
    vec2 jt = abs(mod(p + 1500.0, 3000.0) - 1500.0);
    float joint = 1.0 - smoothstep(2.0, 2.0 + max(1.0, fwidth(p.x) * 1.5), min(jt.x, jt.y));
    float trowel = gNoise(vec2(length(p - vec2(400.0, -300.0)) * 0.02, atan(p.y + 300.0, p.x - 400.0) * 3.0));
    float t = 0.2 + cloud * 0.55 + flecks * 0.35 + stain + joint * 0.6;
    return vec3(clamp(t, 0.0, 1.0), (trowel - 0.5) * 0.18 + stain * 0.15 + joint * 0.3, -joint * 1.5 + fleck * 0.01);
  }
  // an outdoor concrete pad: brushed across, weathered, with joints every 1.2 m
  float broom = gNoise(vec2(p.x * 0.05, p.y * 2.2));
  float bfade = 1.0 - smoothstep(0.3, 0.9, fwidth(p.y * 2.2));
  float weather = gFbm(p * 0.003) * 0.7 + gFbm(p * 0.03 + 2.0) * 0.3;
  vec2 jt = abs(mod(p + 600.0, 1200.0) - 600.0);
  float joint = 1.0 - smoothstep(4.0, 4.0 + max(1.0, fwidth(p.x) * 1.5), min(jt.x, jt.y));
  float grit = gNoise(p * 1.3);
  float t = 0.15 + weather * 0.5 + (broom - 0.5) * 0.18 * bfade + (grit - 0.5) * 0.15 + joint * 0.55;
  return vec3(clamp(t, 0.0, 1.0), (grit - 0.5) * 0.1, (broom * bfade * 0.03 + grit * 0.03) - joint * 3.0);
}
vec3 gPerturb(vec3 pos, vec3 n, float h) {
  vec3 sx = dFdx(pos);
  vec3 sy = dFdy(pos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1);
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - grad);
}`;

/** A set's ground: a big plane at real scale, lit, shadowed, fading into the backdrop well away from the model. */
export class Ground {
  readonly mesh: THREE.Mesh;
  private mat: THREE.MeshPhysicalMaterial;
  private u = {
    uGKind: { value: 0 },
    uGC1: { value: new THREE.Color() },
    uGC2: { value: new THREE.Color() },
    /** centre (x, y) and the distances it starts and finishes fading out */
    uGFade: { value: new THREE.Vector4(0, 0, 1, 2) },
  };

  constructor(mirror: FloorMirror) {
    const mat = new THREE.MeshPhysicalMaterial({ transparent: true, depthWrite: true });
    const u = { ...this.u, ...mirror.uniforms };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, u);
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vGW;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", "#include <common>\n" + GROUND_PARS)
        .replace("#include <color_fragment>", "#include <color_fragment>\n  vec3 gp = gPattern(vGW.xy);\n  diffuseColor.rgb = mix(uGC1, uGC2, gp.x);\n  diffuseColor.a *= 1.0 - smoothstep(uGFade.z, uGFade.w, length(vGW.xy - uGFade.xy));")
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\n  roughnessFactor = clamp(roughnessFactor + gp.y, 0.05, 1.0);")
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\n  normal = gPerturb(-vViewPosition, normal, gp.z);")
        .replace(
          "#include <opaque_fragment>",
          `// a glossy floor mirrors the model, sharper the smoother it is
  if (uMirror.x > 0.0) {
    vec4 gm = kMirror(vGW, uMirror.y * (0.5 + roughnessFactor));
    vec3 gv = normalize(cameraPosition - vGW);
    float graze = 1.0 - abs(gv.z);
    float gk = clamp(gm.a * uMirror.x * mix(0.55, 1.0, graze * graze) * (1.2 - roughnessFactor), 0.0, 1.0);
    outgoingLight = mix(outgoingLight, gm.rgb / max(gm.a, 1e-4), gk);
  }
#include <opaque_fragment>`,
        );
    };
    mat.customProgramCacheKey = () => "kerf-ground-1";
    this.mat = mat;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = -3;
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(0);
    this.mesh.visible = false;
  }

  /** Show `look` (null: no ground). */
  set(look: GroundLook | null) {
    this.mesh.visible = !!look;
    if (!look) return;
    this.u.uGKind.value = look.kind === "wood" ? 0 : look.kind === "concrete" ? 1 : 2;
    this.u.uGC1.value.set(look.color);
    this.u.uGC2.value.set(look.color2);
    this.mat.roughness = look.roughness;
    this.mat.clearcoat = look.coat;
    this.mat.clearcoatRoughness = 0.25;
  }

  /** Lay it under the model: centred on it at height z, fading out between `near` and `far` from its centre. */
  layout(center: THREE.Vector3, z: number, near: number, far: number) {
    this.mesh.scale.set(far * 2.2, far * 2.2, 1);
    this.mesh.position.set(center.x, center.y, z);
    this.mesh.updateMatrixWorld();
    this.u.uGFade.value.set(center.x, center.y, near, far);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}
