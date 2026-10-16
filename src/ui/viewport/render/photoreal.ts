// Photoreal view: the same parts, materials and studio lighting, path traced
// on the GPU (three-gpu-pathtracer). Light bounces between parts, metals
// reflect each other, clear plastics refract, and shadows come from the real
// size of every light. It refines sample by sample while the view is still;
// the interactive renderer covers the gaps while things move.
//
// Kerf additions on top of the library:
// - a shadow catcher: the floor shows the viewport backdrop, darkened by the
//   share of light the parts block (alpha carries the shadow), so the
//   photoreal view sits on the same set as the interactive one;
// - surface detail as baked maps on millimetre UVs (detailTextures.ts);
// - the key light as a circular area light the size of the preset's light.

import * as THREE from "three";
import { ShapedAreaLight, WebGLPathTracer } from "three-gpu-pathtracer";
import { Detail, type Appearance } from "./appearance";
import { detailMaps, ROUGH_MAP_MEAN } from "./detailTextures";

export interface PhotoPart {
  id: string;
  geoKey: string;
  /** the interactive view's geometry: indexed positions and normals */
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  look: Appearance;
}

export interface PhotoStage {
  floorZ: number;
  center: THREE.Vector3;
  /** rough size of the model, mm */
  radius: number;
  /** floor colour seen in reflections and bounce light (linear) */
  floor: THREE.Color;
  /** shadow strength on the backdrop, 0..1 */
  shadow: number;
  env: THREE.CubeTexture;
  envIntensity: number;
  /** environment turn about Z, radians */
  envRotation: number;
  key: { dir: THREE.Vector3; color: THREE.Color; intensity: number; /** angular radius, degrees */ size: number };
  /** the camera is under the floor: no floor */
  below: boolean;
}

export interface PhotoQuality {
  maxSamples: number;
  /** path traced resolution relative to the canvas */
  scale: number;
  bounces: number;
}

const SHADOW_CATCHER = /* glsl */ `
if ( material.matte && state.firstRay ) {
  // Kerf shadow catcher: the backdrop shows through, and alpha is how much of
  // the light reaching this point the parts block. Like the interactive view,
  // the key light casts the shadow and the surroundings add a contact shadow.
  vec3 kN = dot( surfaceHit.faceNormal, ray.direction ) < 0.0 ? surfaceHit.faceNormal : - surfaceHit.faceNormal;
  vec3 kP = stepRayOrigin( ray.origin, ray.direction, kN, surfaceHit.dist );
  float kKeyLit = 0.0;
  float kKeyAll = 0.0;
  float kEnvLit = 0.0;
  float kEnvAll = 0.0;
  for ( int k = 0; k < KERF_SHADOW_RAYS; k ++ ) {
    sobolBounceIndex ++;
    bool kKey = lights.count != 0u && k % 2 == 0;
    vec3 kDir;
    float kW;
    float kDist = INFINITY;
    if ( kKey ) {
      LightRecord kRec = randomLightSample( lights.tex, iesProfiles, lights.count, kP, rand3( 6 ) );
      kDir = kRec.direction;
      kDist = kRec.dist;
      kW = 1.0;
    } else {
      if ( envMapInfo.totalSum == 0.0 || environmentIntensity == 0.0 ) continue;
      vec3 kCol;
      float kPdf = sampleEquirectProbability( rand2( 7 ), kCol, kDir );
      kDir = invEnvRotation3x3 * kDir;
      kW = kPdf > 0.0 ? dot( kCol, vec3( 0.2126, 0.7152, 0.0722 ) ) * max( dot( kDir, kN ), 0.0 ) / kPdf : 0.0;
    }
    if ( dot( kDir, kN ) <= 0.0 || ! ( kW > 0.0 ) ) continue;
    Ray kRay;
    kRay.origin = kP;
    kRay.direction = kDir;
    vec3 kAtt;
    float kVis = attenuateHit( state, kRay, kDist, kAtt ) ? 0.0 : dot( kAtt, vec3( 0.2126, 0.7152, 0.0722 ) );
    if ( kKey ) {
      kKeyLit += kVis;
      kKeyAll += 1.0;
    } else {
      kEnvLit += kW * kVis;
      kEnvAll += kW;
    }
  }
  float kKeyOcc = kKeyAll > 0.0 ? 1.0 - kKeyLit / kKeyAll : 0.0;
  float kEnvOcc = kEnvAll > 0.0 ? 1.0 - kEnvLit / kEnvAll : 0.0;
  float kShadow = clamp( 1.0 - ( 1.0 - kKeyOcc ) * ( 1.0 - 0.6 * kEnvOcc ), 0.0, 1.0 );
  kShadow = kShadow < 1e-3 ? 0.0 : kShadow;
  gl_FragColor = vec4( 0.0, 0.0, 0.0, kShadow * kerfShadow );
  break;
}`;

const KERF_BAD = /* glsl */ `
bool kerfBad( vec4 c ) {
  uvec4 e = floatBitsToUint( c ) & 0x7f800000u;
  return any( equal( e, uvec4( 0x7f800000u ) ) );
}`;

/**
 * Copy a mesh into one the path tracer can texture: unindexed, with UVs in
 * tile units projected onto each triangle's dominant plane (top faces run
 * diagonally, like a printer's top skin), and tangents to match.
 */
export function boxProjected(src: THREE.BufferGeometry, tile: number): THREE.BufferGeometry {
  const pos = src.getAttribute("position") as THREE.BufferAttribute;
  const nor = src.getAttribute("normal") as THREE.BufferAttribute;
  const index = src.getIndex();
  const count = index ? index.count : pos.count;
  const P = new Float32Array(count * 3);
  const Nn = new Float32Array(count * 3);
  const UV = new Float32Array(count * 2);
  const T = new Float32Array(count * 4);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const fn = new THREE.Vector3();
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  const bt = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const ot = new THREE.Vector3();
  const s = Math.SQRT1_2;
  const k = 1 / tile;
  for (let f = 0; f < count; f += 3) {
    const i0 = index ? index.getX(f) : f;
    const i1 = index ? index.getX(f + 1) : f + 1;
    const i2 = index ? index.getX(f + 2) : f + 2;
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    fn.subVectors(c, b).cross(tmp.subVectors(a, b)).normalize();
    const ax = Math.abs(fn.x);
    const ay = Math.abs(fn.y);
    const az = Math.abs(fn.z);
    // u axis (tangent) and v axis (bitangent) of the projection
    if (az >= ax && az >= ay) {
      t.set(s, -s, 0);
      bt.set(s, s, 0);
    } else if (ax >= ay) {
      t.set(0, 1, 0);
      bt.set(0, 0, 1);
    } else {
      t.set(1, 0, 0);
      bt.set(0, 0, 1);
    }
    const vs = [i0, i1, i2];
    // on a rounded edge the smooth vertex normals can lie along the projected
    // u axis; the path tracer builds its bitangent as cross(normal, tangent),
    // so lead with the v axis there instead
    let lead = t;
    for (const vi of vs) if (Math.abs(n.fromBufferAttribute(nor, vi).dot(t)) > 0.9) lead = bt;
    for (let j = 0; j < 3; j++) {
      const vi = vs[j];
      const o = f + j;
      const p = j === 0 ? a : j === 1 ? b : c;
      P[o * 3] = p.x;
      P[o * 3 + 1] = p.y;
      P[o * 3 + 2] = p.z;
      n.fromBufferAttribute(nor, vi);
      Nn[o * 3] = n.x;
      Nn[o * 3 + 1] = n.y;
      Nn[o * 3 + 2] = n.z;
      UV[o * 2] = p.dot(t) * k;
      UV[o * 2 + 1] = p.dot(bt) * k;
      // tangent along the leading axis, at right angles to this vertex's normal
      ot.copy(lead).addScaledVector(n, -n.dot(lead));
      if (ot.lengthSq() < 1e-8) ot.copy(lead === t ? bt : t).addScaledVector(n, -n.dot(lead === t ? bt : t));
      ot.normalize();
      // three.js rebuilds the bitangent as cross(normal, tangent) * w; it must follow +v (or -u when v leads)
      const w = tmp.crossVectors(n, ot).dot(lead === t ? bt : t) * (lead === t ? 1 : -1) < 0 ? -1 : 1;
      if (lead === t) {
        T[o * 4] = ot.x;
        T[o * 4 + 1] = ot.y;
        T[o * 4 + 2] = ot.z;
        T[o * 4 + 3] = w;
      } else {
        // the tangent must still point along +u: rebuild it from the v-led frame
        tmp.crossVectors(ot, n).multiplyScalar(w);
        T[o * 4] = tmp.x;
        T[o * 4 + 1] = tmp.y;
        T[o * 4 + 2] = tmp.z;
        T[o * 4 + 3] = w;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(P, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(Nn, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(UV, 2));
  g.setAttribute("tangent", new THREE.BufferAttribute(T, 4));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

/** A path tracer material for an appearance, with its surface detail as maps. */
export function photoMaterial(a: Appearance): { mat: THREE.MeshPhysicalMaterial; tile: number } {
  const m = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
  m.color.set(a.color);
  m.metalness = a.metalness;
  m.roughness = a.roughness;
  m.clearcoat = a.clearcoat;
  m.clearcoatRoughness = a.clearcoatRoughness;
  m.sheen = a.sheen;
  m.sheenRoughness = a.sheenRoughness;
  m.sheenColor.set(a.color).lerp(new THREE.Color(1, 1, 1), 0.5);
  m.transmission = a.transmission;
  m.thickness = a.thickness;
  m.ior = a.ior;
  m.iridescence = a.iridescence;
  m.iridescenceIOR = 1.8;
  m.iridescenceThicknessRange = [180, 520];
  m.specularIntensity = a.specularIntensity;
  let tile = 1;
  const maps = a.detail !== Detail.None && a.detailAmp > 0 ? detailMaps(a.detail) : null;
  if (maps) {
    tile = maps.cells * a.detailScale;
    const f = (a.detailAmp * maps.slope) / tile;
    m.normalMap = maps.normal;
    m.normalScale.set(f, f);
    if (a.roughVar > 0) {
      m.roughnessMap = maps.rough;
      m.roughness = Math.min(1, a.roughness / ROUGH_MAP_MEAN);
    }
    if (maps.color && a.tintAmt > 0) {
      m.map = maps.color;
      m.color.multiplyScalar(1 / maps.colorMean);
    }
  }
  return { mat: m, tile };
}

function signature(parts: PhotoPart[], st: PhotoStage) {
  const out: string[] = [];
  for (const p of parts) out.push(p.id, p.geoKey, p.look.key, ...Array.from(p.matrix.elements, (e) => e.toFixed(4)));
  out.push(st.floorZ.toFixed(3), String(st.below));
  return out.join("|");
}

function stageSignature(st: PhotoStage) {
  const k = st.key;
  return [st.env.uuid, st.envIntensity, st.envRotation.toFixed(5), k.dir.x.toFixed(5), k.dir.y.toFixed(5), k.dir.z.toFixed(5), k.color.getHexString(), k.intensity, k.size, st.shadow, st.floor.getHexString(), st.center.x.toFixed(2), st.center.y.toFixed(2), st.center.z.toFixed(2), st.radius.toFixed(2)].join("|");
}

export class PhotoRenderer {
  private pt: WebGLPathTracer;
  private scene = new THREE.Scene();
  private parts = new THREE.Group();
  private catcher: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshStandardMaterial>;
  private light: ShapedAreaLight;
  private geos = new Map<string, THREE.BufferGeometry>();
  private mats = new Map<string, { mat: THREE.MeshPhysicalMaterial; tile: number; look: Appearance; bump: number; fade: number }>();
  private shadow = { value: 0.8 };
  private sig = "";
  private stageSig = "";
  private needScene = true;
  private needStage = true;
  private needCamera = true;
  private needMaterials = false;
  private lastPos = new THREE.Vector3(Infinity, 0, 0);
  private lastQuat = new THREE.Quaternion();
  private lastProj = new THREE.Matrix4();
  private linearOk: boolean;
  /** when the scene or camera last changed (ms) */
  changedAt = 0;
  quality: PhotoQuality = { maxSamples: 512, scale: 1, bounces: 5 };
  /** the shader could not be patched: floors render without shadows */
  readonly catcherMissing: boolean;

  constructor(
    private renderer: THREE.WebGLRenderer,
    private camera: THREE.PerspectiveCamera,
  ) {
    this.pt = new WebGLPathTracer(renderer);
    this.pt.renderToCanvas = false;
    this.pt.renderDelay = 0;
    this.pt.minSamples = 1;
    this.pt.fadeDuration = 0;
    this.pt.dynamicLowRes = false;
    this.pt.rasterizeScene = false;
    this.pt.multipleImportanceSampling = true;
    this.pt.transmissiveBounces = 8;
    this.pt.filterGlossyFactor = 0.5;
    this.pt.textureSize.set(256, 256);
    this.linearOk = renderer.extensions.has("OES_texture_float_linear");

    // patch the shadow catcher into the path tracing shader
    const m = (this.pt as unknown as { _pathTracer: { material: THREE.ShaderMaterial } })._pathTracer.material;
    const matte = /if \( material\.matte && state\.firstRay \) \{\s*gl_FragColor = vec4\( 0\.0 \);\s*break;\s*\}/;
    const patched = matte.test(m.fragmentShader) && /void main\(\s*\)\s*\{/.test(m.fragmentShader);
    this.catcherMissing = !patched;
    let frag = m.fragmentShader;
    if (patched) frag = frag.replace(matte, SHADOW_CATCHER);
    // a sample that goes bad (NaN or infinite) would stay in the running
    // average for good: keep the pixel's last sample instead
    frag = frag.replace(/gl_FragColor\.a \*= opacity;/, "gl_FragColor.a *= opacity;\nif ( kerfBad( gl_FragColor ) ) discard;");
    m.fragmentShader = frag.replace(/void main\(\s*\)\s*\{/, `uniform float kerfShadow;\n${KERF_BAD}\nvoid main() {`);
    m.uniforms.kerfShadow = this.shadow;
    m.defines.KERF_SHADOW_RAYS = 4;
    m.needsUpdate = true;
    // the library's alpha blend divides by the summed alpha, which a faint
    // shadow can round to zero: blend only where there is real coverage
    const blend = (this.pt as unknown as { _pathTracer: { _blendQuad: { material: THREE.ShaderMaterial } } })._pathTracer._blendQuad.material;
    blend.fragmentShader = blend.fragmentShader.replace(/if \( color1\.a != 0\.0 \|\| color2\.a != 0\.0 \)/, "if ( totalAlpha > 1e-6 )");
    blend.needsUpdate = true;

    this.catcher = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshStandardMaterial({ roughness: 0.92 }));
    Object.assign(this.catcher.material, { matte: patched, castShadow: false });
    this.light = new ShapedAreaLight(0xffffff, 1, 1, 1);
    this.light.isCircular = true;
    this.scene.add(this.parts, this.catcher, this.light);
  }

  get samples() {
    return this.pt.samples;
  }

  get done() {
    return this.pt.samples >= this.quality.maxSamples;
  }

  get compiling() {
    return (this.pt as unknown as { isCompiling: boolean }).isCompiling;
  }

  get texture() {
    return this.pt.target.texture;
  }

  /** Start the image again, e.g. after a quality change. */
  restart(now: number) {
    this.changedAt = now;
    this.pt.reset();
  }

  /** Bring the path traced scene up to date; returns true when it had to restart. */
  sync(parts: PhotoPart[], st: PhotoStage, now: number): boolean {
    let restart = false;
    const sig = signature(parts, st);
    if (sig !== this.sig) {
      this.sig = sig;
      this.rebuild(parts, st);
      this.needScene = true;
      restart = true;
    }
    const ss = stageSignature(st);
    if (ss !== this.stageSig) {
      this.stageSig = ss;
      this.applyStage(st);
      this.needStage = true;
      restart = true;
    }
    const cam = this.camera;
    cam.updateMatrixWorld();
    // orbit damping keeps nudging the camera long after a drag: only a move
    // of a fraction of a pixel since the last restart starts the image again
    if (!near(cam.projectionMatrix, this.lastProj) || this.cameraShiftPx(st) > 0.25) {
      this.lastPos.copy(cam.position);
      this.lastQuat.copy(cam.quaternion);
      this.lastProj.copy(cam.projectionMatrix);
      this.needCamera = true;
      restart = true;
    }
    if (this.fadeDetail(st)) restart = true;
    if (restart) {
      this.changedAt = now;
      this.pt.reset();
    }
    return restart;
  }

  /**
   * Trace one more tile; true when that finished a whole sample. Call only
   * while the camera is not jittered. `frameMs` is how long the last
   * animation frame took when it only traced: the frame is split into more
   * tiles while frames run long, so the app stays responsive.
   */
  render(frameMs?: number) {
    const pt = this.pt;
    pt.renderScale = this.quality.scale;
    pt.bounces = this.quality.bounces;
    if (this.needScene) {
      pt.setScene(this.scene, this.camera);
      this.needScene = this.needStage = this.needCamera = false;
      this.linearTargets();
    }
    if (this.needStage) {
      pt.updateEnvironment();
      pt.updateLights();
      this.needStage = false;
    }
    if (this.needCamera) {
      pt.updateCamera();
      this.needCamera = false;
    }
    if (this.needMaterials) {
      pt.updateMaterials();
      this.needMaterials = false;
    }
    if (this.done) return false;
    this.adaptTiles(frameMs);
    // report only whole samples: a part-traced frame isn't worth a composite
    const before = Math.floor(pt.samples + 1e-6);
    pt.renderSample();
    this.renderer.setRenderTarget(null);
    return Math.floor(pt.samples + 1e-6) !== before;
  }

  /** How far the image would shift, in pixels, since the camera the image was started with. */
  private cameraShiftPx(st: PhotoStage) {
    const cam = this.camera;
    if (!Number.isFinite(this.lastPos.x)) return Infinity;
    const h = this.renderer.domElement.height;
    const fov = THREE.MathUtils.degToRad(cam.fov) / cam.zoom;
    const turn = 2 * Math.acos(Math.min(1, Math.abs(this.lastQuat.dot(cam.quaternion))));
    const dist = Math.max(1e-3, cam.position.distanceTo(st.center));
    const shift = cam.position.distanceTo(this.lastPos);
    return (turn / fov) * h + (shift / (2 * dist * Math.tan(fov / 2))) * h;
  }

  /**
   * Fade surface detail finer than a pixel, as the interactive shader does:
   * the average of sub-pixel bumps is flat, and tracing them only adds grain.
   */
  private fadeDetail(st: PhotoStage) {
    const cam = this.camera;
    const px = this.renderer.domElement.height * this.quality.scale;
    const mmPerPx = (2 * cam.position.distanceTo(st.center) * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / Math.max(1, px * cam.zoom);
    let changed = false;
    for (const m of this.mats.values()) {
      if (!m.bump) continue;
      const k = THREE.MathUtils.smoothstep(mmPerPx / m.look.detailScale, 0.3, 0.75);
      const fade = Math.round((1 - k) * 20) / 20;
      if (fade === m.fade) continue;
      m.fade = fade;
      m.mat.normalScale.setScalar(m.bump * fade);
      changed = true;
    }
    if (changed && !this.needScene) this.needMaterials = true;
    return changed;
  }

  private tiles = 0;
  private slow = 0;
  private fast = 0;

  private adaptTiles(frameMs: number | undefined) {
    if (!this.tiles) {
      // first guess from the pixel count, then follow the frame time
      const px = this.renderer.domElement.width * this.renderer.domElement.height * this.quality.scale * this.quality.scale;
      this.tiles = Math.max(1, Math.min(4, Math.round(Math.sqrt(px / 350_000))));
    } else if (frameMs === undefined) {
      // nothing to go on this frame
    } else if (frameMs > 40) {
      this.fast = 0;
      if (++this.slow >= 2 && this.tiles < MAX_TILES) {
        this.tiles = Math.min(MAX_TILES, Math.ceil(this.tiles * Math.min(2, Math.sqrt(frameMs / 25))));
        this.slow = 0;
      }
    } else if (frameMs < 20) {
      this.slow = 0;
      if (++this.fast >= 30 && this.tiles > 1) {
        this.tiles--;
        this.fast = 0;
      }
    } else this.slow = this.fast = 0;
    if (this.pt.tiles.x !== this.tiles) this.pt.tiles.set(this.tiles, this.tiles);
  }

  private linearTargets() {
    // a path tracer at less than full size is upscaled in the composite: filter it
    if (!this.linearOk) return;
    const inner = (this.pt as unknown as { _pathTracer: { _primaryTarget: THREE.WebGLRenderTarget; _blendTargets: THREE.WebGLRenderTarget[] } })._pathTracer;
    for (const rt of [inner._primaryTarget, ...inner._blendTargets]) {
      rt.texture.minFilter = THREE.LinearFilter;
      rt.texture.magFilter = THREE.LinearFilter;
    }
  }

  private rebuild(parts: PhotoPart[], st: PhotoStage) {
    this.parts.clear();
    const usedGeos = new Set<string>();
    for (const p of parts) {
      let m = this.mats.get(p.look.key);
      if (!m) {
        const pm = photoMaterial(p.look);
        m = { ...pm, look: p.look, bump: pm.mat.normalScale.x, fade: 1 };
        this.mats.set(p.look.key, m);
      }
      const gk = `${p.geoKey}|${m.tile.toFixed(5)}`;
      let g = this.geos.get(gk);
      if (!g) {
        g = boxProjected(p.geometry, m.tile);
        this.geos.set(gk, g);
      }
      usedGeos.add(gk);
      const mesh = new THREE.Mesh(g, m.mat);
      mesh.matrixAutoUpdate = false;
      mesh.matrix.copy(p.matrix);
      this.parts.add(mesh);
    }
    for (const [k, g] of this.geos)
      if (!usedGeos.has(k)) {
        g.dispose();
        this.geos.delete(k);
      }
    this.catcher.visible = !st.below;
    if (st.below) this.catcher.removeFromParent();
    else if (!this.catcher.parent) this.scene.add(this.catcher);
    const size = Math.max(st.radius, 20) * 60;
    this.catcher.scale.set(size, size, 1);
    this.catcher.position.set(st.center.x, st.center.y, st.floorZ);
    this.scene.updateMatrixWorld(true);
  }

  private applyStage(st: PhotoStage) {
    this.scene.environment = st.env;
    this.scene.environmentIntensity = st.envIntensity;
    this.scene.environmentRotation.set(0, 0, st.envRotation);
    this.scene.background = null;
    this.shadow.value = st.shadow;
    this.catcher.material.color.copy(st.floor);
    // the key light: a disc far away, as wide as the preset's light
    const r = Math.max(st.radius, 20);
    const dist = r * 20;
    const tan = Math.tan(THREE.MathUtils.degToRad(Math.max(0.5, st.key.size)));
    const diam = 2 * dist * tan;
    this.light.width = diam;
    this.light.height = diam;
    this.light.color.copy(st.key.color);
    // same irradiance as the interactive key light: radiance × solid angle
    this.light.intensity = st.key.intensity / (Math.PI * tan * tan);
    this.light.position.copy(st.center).addScaledVector(st.key.dir, dist);
    this.light.lookAt(st.center);
    this.light.updateMatrixWorld();
  }

  dispose() {
    // the library's own dispose() trips over a missing quad in this version
    const inner = (this.pt as unknown as { _pathTracer: { dispose(): void } })._pathTracer;
    inner.dispose();
    for (const g of this.geos.values()) g.dispose();
    for (const m of this.mats.values()) m.mat.dispose();
    this.catcher.geometry.dispose();
    this.catcher.material.dispose();
  }
}

/** the frame is split into at most this many tiles each way */
const MAX_TILES = 12;

function near(a: THREE.Matrix4, b: THREE.Matrix4) {
  const x = a.elements;
  const y = b.elements;
  for (let i = 0; i < 16; i++) if (Math.abs(x[i] - y[i]) > 1e-6 * (1 + Math.abs(x[i]))) return false;
  return true;
}
