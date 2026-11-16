// Contact shadows: the soft darkening of the floor right under and around a
// model, where little light from the room reaches. The key light's shadow
// map gives one directional shadow; this gives the grounding that makes a
// model sit on the floor instead of floating over it.
//
// The parts are drawn once from below the floor, looking up, into a small
// texture: each texel keeps how close the lowest surface above it is to the
// floor. Two blurs of it (a tight one for contact, a wide one for the
// ambient pool) are laid on the floor by a plane under the model. None of it
// depends on the camera, so it is drawn again only when the model changes,
// not while the view turns.

import * as THREE from "three";
import { FullScreenQuad } from "three/examples/jsm/postprocessing/Pass.js";

const SIZE = 512;

const HEIGHT_VERT = /* glsl */ `
uniform float uFloor;
varying float vH;
#include <common>
#include <clipping_planes_pars_vertex>
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
  vH = (modelMatrix * vec4(position, 1.0)).z - uFloor;
}`;

const HEIGHT_FRAG = /* glsl */ `
uniform float uReach;
varying float vH;
#include <clipping_planes_pars_fragment>
void main() {
  #include <clipping_planes_fragment>
  float t = clamp(vH / uReach, 0.0, 1.0);
  // r: near contact (falls off fast), g: the wider pool (falls off slowly)
  float near = 1.0 - smoothstep(0.0, 0.18, t);
  float far = (1.0 - t) * (1.0 - t);
  gl_FragColor = vec4(near, far, 0.0, 1.0);
}`;

const BLUR_FRAG = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uDir;
varying vec2 vUv;
void main() {
  // 13-tap Gaussian folded into 7 linear fetches
  vec4 c = texture2D(tSrc, vUv) * 0.19648255;
  c += (texture2D(tSrc, vUv + uDir * 1.41176471) + texture2D(tSrc, vUv - uDir * 1.41176471)) * 0.29690696;
  c += (texture2D(tSrc, vUv + uDir * 3.29411765) + texture2D(tSrc, vUv - uDir * 3.29411765)) * 0.09447040;
  c += (texture2D(tSrc, vUv + uDir * 5.17647059) + texture2D(tSrc, vUv - uDir * 5.17647059)) * 0.01038136;
  gl_FragColor = c;
}`

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FLOOR_VERT = /* glsl */ `
uniform mat4 uShadowVP;
varying vec2 vSUv;
varying vec2 vXY;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec4 s = uShadowVP * w;
  vSUv = s.xy / s.w * 0.5 + 0.5;
  vXY = w.xy;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const FLOOR_FRAG = /* glsl */ `
uniform sampler2D tTight;
uniform sampler2D tWide;
uniform float uContact;
uniform float uPool;
uniform vec3 uLight;
uniform float uLightAmt;
uniform vec2 uCenter;
uniform vec2 uHalf;
varying vec2 vSUv;
varying vec2 vXY;
void main() {
  vec2 e = min(vSUv, 1.0 - vSUv);
  float edge = smoothstep(0.0, 0.12, min(e.x, e.y));
  float tight = texture2D(tTight, vSUv).r;
  float wide = texture2D(tWide, vSUv).g;
  // darkness: the contact shadow and the softer pool of shade around it
  float s = clamp((1.0 - (1.0 - tight * uContact) * (1.0 - wide * uPool)) * edge, 0.0, 1.0);
  // light: a soft spot of light on the floor under the model, so that on a dark set the floor
  // (and the shadows on it) can be seen; it fades out well inside the patch
  vec2 q = (vXY - uCenter) / uHalf;
  float w = uLightAmt * (1.0 - smoothstep(0.15, 1.0, length(q)));
  // the backdrop is laid in behind by the composite through the alpha:
  // seen = light * w * (1 - s) + backdrop * (1 - w) * (1 - s)
  float a = 1.0 - (1.0 - w) * (1.0 - s);
  gl_FragColor = vec4(a > 1e-4 ? uLight * w * (1.0 - s) / a : vec3(0.0), a);
}`;

export class ContactShadow {
  /** the plane on the floor that carries the shadow; add it to the scene */
  readonly mesh: THREE.Mesh;
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private heightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private floorMat: THREE.ShaderMaterial;
  private raw: THREE.WebGLRenderTarget;
  private tight: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private wide: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private quad = new FullScreenQuad();
  /** the model changed since the shadow was drawn */
  dirty = true;

  constructor(private r: THREE.WebGLRenderer) {
    const opts = { type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false } as const;
    this.raw = new THREE.WebGLRenderTarget(SIZE, SIZE, { ...opts, depthBuffer: true });
    this.tight = [new THREE.WebGLRenderTarget(SIZE, SIZE, opts), new THREE.WebGLRenderTarget(SIZE, SIZE, opts)];
    this.wide = [new THREE.WebGLRenderTarget(SIZE / 4, SIZE / 4, opts), new THREE.WebGLRenderTarget(SIZE / 4, SIZE / 4, opts)];
    this.heightMat = new THREE.ShaderMaterial({ vertexShader: HEIGHT_VERT, fragmentShader: HEIGHT_FRAG, uniforms: { uFloor: { value: 0 }, uReach: { value: 1 } }, side: THREE.DoubleSide, clipping: true });
    this.blurMat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: BLUR_FRAG, uniforms: { tSrc: { value: null }, uDir: { value: new THREE.Vector2() } }, depthTest: false, depthWrite: false });
    this.floorMat = new THREE.ShaderMaterial({
      vertexShader: FLOOR_VERT,
      fragmentShader: FLOOR_FRAG,
      uniforms: { tTight: { value: this.tight[0].texture }, tWide: { value: this.wide[0].texture }, uShadowVP: { value: new THREE.Matrix4() },
        uContact: { value: 0.7 },
        uPool: { value: 0.35 },
        uLight: { value: new THREE.Color() },
        uLightAmt: { value: 0 },
        uCenter: { value: new THREE.Vector2() },
        uHalf: { value: new THREE.Vector2(1, 1) },
      },
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.floorMat);
    this.mesh.renderOrder = -1;
    // drawn in the colour pass only: it must not shadow itself or show up in its own height map
    this.mesh.layers.set(0);
    this.mesh.frustumCulled = false;
  }

  /** How strong the contact darkening and the wider pool of shade are (0..1), and the spot of light on the floor under the model (sRGB colour, 0..1). */
  setStrength(contact: number, pool: number, light?: { color: string; amount: number }) {
    const u = this.floorMat.uniforms;
    u.uContact.value = contact;
    u.uPool.value = pool;
    u.uLight.value.set(light?.color ?? "#000000");
    u.uLightAmt.value = light?.amount ?? 0;
    this.mesh.visible = contact > 0.001 || pool > 0.001 || u.uLightAmt.value > 0.001;
  }

  /** Place the shadow: centre of the model on the floor, half the width of the patch, and how high above the floor a surface still darkens it. */
  layout(center: THREE.Vector3, floorZ: number, ext: number, reach: number, footprint: THREE.Vector2 = new THREE.Vector2(ext, ext)) {
    this.floorMat.uniforms.uCenter.value.set(center.x, center.y);
    // the light spot: an ellipse a little wider than the model, inside the patch
    this.floorMat.uniforms.uHalf.value.set(Math.min(ext, footprint.x + reach), Math.min(ext, footprint.y + reach));
    const c = this.cam;
    c.left = -ext;
    c.right = ext;
    c.top = ext;
    c.bottom = -ext;
    c.near = 0;
    c.far = reach;
    c.up.set(0, 1, 0);
    c.position.set(center.x, center.y, floorZ);
    c.lookAt(center.x, center.y, floorZ + 1);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    this.heightMat.uniforms.uFloor.value = floorZ;
    this.heightMat.uniforms.uReach.value = reach;
    this.floorMat.uniforms.uShadowVP.value.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    this.mesh.scale.set(ext * 2, ext * 2, 1);
    this.mesh.position.set(center.x, center.y, floorZ + Math.max(0.005, reach * 0.0005));
    this.mesh.updateMatrixWorld();
    this.dirty = true;
  }

  /** Draw the height map and its blurs from the parts on `layer` (the visible opaque ones). */
  render(scene: THREE.Scene, layer: number, clipping: THREE.Plane[] = []) {
    if (!this.mesh.visible) return;
    const r = this.r;
    const prevTarget = r.getRenderTarget();
    const prevClip = r.clippingPlanes;
    const prevShadow = r.shadowMap.autoUpdate;
    const prevAuto = r.autoClear;
    const prevColor = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    const prevBg = scene.background;
    r.shadowMap.autoUpdate = false;
    r.autoClear = false;
    r.clippingPlanes = clipping;
    scene.background = null;
    this.cam.layers.set(layer);
    r.setRenderTarget(this.raw);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    scene.overrideMaterial = this.heightMat;
    r.render(scene, this.cam);
    scene.overrideMaterial = null;
    r.clippingPlanes = prevClip;
    scene.background = prevBg;

    // tight: one blur at full size, a fraction of a millimetre to a few mm on the floor
    this.blur(this.raw.texture, this.tight, 0.6);
    // wide: the pool, blurred twice at a quarter size
    this.blur(this.raw.texture, this.wide, 1.5);
    this.blur(this.wide[0].texture, this.wide, 2.5);

    r.setRenderTarget(prevTarget);
    r.setClearColor(prevColor, prevAlpha);
    r.autoClear = prevAuto;
    r.shadowMap.autoUpdate = prevShadow;
    this.dirty = false;
  }

  private blur(src: THREE.Texture, rts: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget], step: number) {
    const u = this.blurMat.uniforms;
    const px = 1 / rts[0].width;
    u.tSrc.value = src;
    u.uDir.value.set(px * step, 0);
    this.pass(rts[1]);
    u.tSrc.value = rts[1].texture;
    u.uDir.value.set(0, px * step);
    this.pass(rts[0]);
  }

  private pass(target: THREE.WebGLRenderTarget) {
    this.r.setRenderTarget(target);
    this.quad.material = this.blurMat;
    this.quad.render(this.r);
  }

  dispose() {
    for (const rt of [this.raw, ...this.tight, ...this.wide]) rt.dispose();
    this.heightMat.dispose();
    this.blurMat.dispose();
    this.floorMat.dispose();
    this.mesh.geometry.dispose();
    this.quad.dispose();
  }
}
