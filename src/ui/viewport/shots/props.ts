// Everyday objects of known size, modelled to scale so a product shot shows
// how big the product is: a coin, a bank card, a pen, an AA cell, a steel
// rule, a mug and a phone. Built from three.js primitives with physically
// based materials, so they render the same in the rasteriser and the path
// tracer. Z is up and every prop stands on z = 0.

import * as THREE from "three";
import type { PropId } from "../../../shots/spec";

const phys = (p: THREE.MeshPhysicalMaterialParameters) => new THREE.MeshPhysicalMaterial(p);

function mesh(g: THREE.BufferGeometry, m: THREE.Material) {
  const x = new THREE.Mesh(g, m);
  x.castShadow = true;
  x.receiveShadow = true;
  return x;
}

/** A Z-up cylinder standing on z = z0. */
function cyl(r: number, h: number, m: THREE.Material, z0 = 0, seg = 64) {
  const g = new THREE.CylinderGeometry(r, r, h, seg, 1);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0, z0 + h / 2);
  return mesh(g, m);
}

/** A rounded slab w × d × h standing on z = 0. */
function slab(w: number, d: number, h: number, r: number, m: THREE.Material) {
  const s = new THREE.Shape();
  const x = w / 2 - r;
  const y = d / 2 - r;
  s.moveTo(-x, -d / 2);
  s.lineTo(x, -d / 2);
  s.absarc(x, -y, r, -Math.PI / 2, 0, false);
  s.lineTo(w / 2, y);
  s.absarc(x, y, r, 0, Math.PI / 2, false);
  s.lineTo(-x, d / 2);
  s.absarc(-x, y, r, Math.PI / 2, Math.PI, false);
  s.lineTo(-w / 2, -y);
  s.absarc(-x, -y, r, Math.PI, Math.PI * 1.5, false);
  const bevel = Math.min(h * 0.3, r * 0.5, 1.2);
  const g = new THREE.ExtrudeGeometry(s, { depth: h - bevel * 2, bevelEnabled: bevel > 0.05, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 3, curveSegments: 12 });
  g.translate(0, 0, bevel);
  g.computeVertexNormals();
  return mesh(g, m);
}

function rulerTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 128;
  const x = c.getContext("2d")!;
  x.fillStyle = "#b9bec4";
  x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#1c1f24";
  const pxPerMm = c.width / 150;
  for (let mm = 0; mm <= 150; mm++) {
    const len = mm % 10 === 0 ? 46 : mm % 5 === 0 ? 32 : 20;
    x.fillRect(mm * pxPerMm - 1.5, 0, 3, len);
    if (mm % 10 === 0 && mm > 0 && mm < 150) {
      x.font = "600 30px 'IBM Plex Mono', monospace";
      x.textAlign = "center";
      x.fillText(String(mm / 10), mm * pxPerMm, 84);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function makeProp(id: PropId): THREE.Group {
  const g = new THREE.Group();
  switch (id) {
    case "coin": {
      // a one-euro coin: brass ring around a nickel centre, 23.25 × 2.33 mm
      const ring = phys({ color: "#d2b26a", metalness: 1, roughness: 0.32 });
      const centre = phys({ color: "#c8cbcf", metalness: 1, roughness: 0.3 });
      g.add(cyl(23.25 / 2, 2.2, ring), cyl(16.25 / 2, 2.33, centre));
      break;
    }
    case "card": {
      const body = phys({ color: "#2b4e8c", roughness: 0.35, clearcoat: 0.6, clearcoatRoughness: 0.2 });
      const chip = phys({ color: "#d6b56a", metalness: 1, roughness: 0.3 });
      g.add(slab(85.6, 53.98, 0.76, 3.18, body));
      const c = slab(11, 9, 0.1, 1.4, chip);
      c.position.set(-28, 4, 0.7);
      g.add(c);
      break;
    }
    case "pen": {
      // lying on its side along +X: body, grip, cone and clip
      const body = phys({ color: "#1f2a44", roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.1 });
      const metal = phys({ color: "#d9dce0", metalness: 1, roughness: 0.18 });
      const grip = phys({ color: "#202226", roughness: 0.8 });
      const r = 5;
      const add = (len: number, m: THREE.Material, x0: number, r0 = r, r1 = r) => {
        const geo = new THREE.CylinderGeometry(r1, r0, len, 48, 1);
        geo.rotateZ(-Math.PI / 2);
        geo.translate(x0 + len / 2, 0, r);
        g.add(mesh(geo, m));
      };
      add(18, metal, -70, r * 0.92, r * 0.92);
      add(82, body, -52);
      add(28, grip, 30);
      add(10, metal, 58, r, 1.2);
      const clip = slab(48, 2.2, 1.4, 1, metal);
      clip.rotation.x = Math.PI / 2;
      clip.position.set(-40, 0, r * 2 + 0.3);
      g.add(clip);
      break;
    }
    case "battery": {
      const wrap = phys({ color: "#16181c", roughness: 0.4, clearcoat: 0.5 });
      const band = phys({ color: "#b8742d", metalness: 0.6, roughness: 0.35 });
      const metal = phys({ color: "#d4d7db", metalness: 1, roughness: 0.25 });
      const r = 14.5 / 2;
      const add = (len: number, m: THREE.Material, x0: number, rr = r) => {
        const geo = new THREE.CylinderGeometry(rr, rr, len, 48, 1);
        geo.rotateZ(-Math.PI / 2);
        geo.translate(x0 + len / 2, 0, r);
        g.add(mesh(geo, m));
      };
      add(34, wrap, -25.25);
      add(15, band, 8.75);
      add(1.5, metal, 23.75, r * 0.98);
      add(1.2, metal, 25.25, 2.7);
      break;
    }
    case "ruler": {
      const tex = rulerTexture();
      const steel = phys({ color: "#ffffff", map: tex, metalness: 0.85, roughness: 0.36 });
      const geo = new THREE.BoxGeometry(160, 18, 0.8);
      // the scale sits on the top face; the box's top face UVs run along +X
      geo.translate(0, 0, 0.4);
      const m = mesh(geo, [phys({ color: "#b9bec4", metalness: 0.85, roughness: 0.4 }), phys({ color: "#b9bec4", metalness: 0.85, roughness: 0.4 }), phys({ color: "#b9bec4", metalness: 0.85, roughness: 0.4 }), phys({ color: "#b9bec4", metalness: 0.85, roughness: 0.4 }), steel, steel] as unknown as THREE.Material);
      g.add(m);
      break;
    }
    case "mug": {
      const glaze = phys({ color: "#f1efe9", roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.05 });
      const pts: THREE.Vector2[] = [];
      const R = 41;
      const H = 95;
      const w = 3.5;
      pts.push(new THREE.Vector2(0, 0.0), new THREE.Vector2(R - 4, 0), new THREE.Vector2(R - 1, 1.5), new THREE.Vector2(R, 5), new THREE.Vector2(R, H - 1), new THREE.Vector2(R - w / 2, H), new THREE.Vector2(R - w, H - 1), new THREE.Vector2(R - w, 8), new THREE.Vector2(0, 7));
      const geo = new THREE.LatheGeometry(pts, 96);
      geo.rotateX(Math.PI / 2);
      g.add(mesh(geo, glaze));
      const handle = new THREE.TorusGeometry(24, 5.5, 24, 48, Math.PI);
      handle.rotateX(Math.PI / 2);
      handle.rotateY(-Math.PI / 2);
      handle.translate(R - 2, 0, H / 2);
      g.add(mesh(handle, glaze));
      break;
    }
    case "phone": {
      const frame = phys({ color: "#5d6168", metalness: 1, roughness: 0.3 });
      const glass = phys({ color: "#0b0c0f", roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.02 });
      g.add(slab(147, 71.5, 7.8, 10, frame));
      const top = slab(144.5, 69, 0.4, 9, glass);
      top.position.z = 7.6;
      g.add(top);
      break;
    }
  }
  g.userData.prop = id;
  return g;
}

/** A new copy of a prop (its materials are its own, so it can be disposed). */
export function buildProp(id: PropId): THREE.Group {
  return makeProp(id);
}

/** Footprint radius of a prop on the floor, mm. */
export function propRadius(id: PropId): number {
  return { coin: 11.6, card: 50, pen: 75, battery: 26, ruler: 80, mug: 72, phone: 80 }[id];
}

export function disposeProp(g: THREE.Object3D) {
  g.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) {
        (m as THREE.MeshPhysicalMaterial).map?.dispose();
        m.dispose();
      }
    }
  });
}

/**
 * Place props on the floor beside the subject, in view of the camera: the
 * first goes in front of the subject on the camera's right, the next ones
 * step outward, each turned a little against the camera so it reads as set
 * down by hand rather than lined up.
 */
export function placeProps(ids: PropId[], subject: THREE.Box3, floorZ: number, right: THREE.Vector3, toward: THREE.Vector3, keepOut = 0): { id: PropId; matrix: THREE.Matrix4 }[] {
  const c = subject.getCenter(new THREE.Vector3());
  const size = subject.getSize(new THREE.Vector3());
  const r = new THREE.Vector3(right.x, right.y, 0).normalize();
  const t = new THREE.Vector3(toward.x, toward.y, 0).normalize();
  if (r.lengthSq() < 1e-6) r.set(1, 0, 0);
  if (t.lengthSq() < 1e-6) t.set(0, -1, 0);
  // half the subject's footprint seen along r and t
  const halfR = Math.abs(r.x) * size.x * 0.5 + Math.abs(r.y) * size.y * 0.5;
  const halfT = Math.abs(t.x) * size.x * 0.5 + Math.abs(t.y) * size.y * 0.5;
  const reach = Math.max(halfR, keepOut);
  const out: { id: PropId; matrix: THREE.Matrix4 }[] = [];
  let along = reach + 14;
  const baseAz = Math.atan2(r.y, r.x);
  ids.forEach((id, i) => {
    const pr = propRadius(id);
    // long props lie across the view, in front; round ones sit beside
    const long = id === "pen" || id === "ruler" || id === "phone" || id === "card" || id === "battery";
    let pos: THREE.Vector3;
    let turn: number;
    if (long) {
      const ahead = Math.max(halfT, keepOut) + 16 + (id === "ruler" || id === "pen" ? 10 : pr * 0.4);
      pos = c.clone().addScaledVector(t, ahead).addScaledVector(r, (i % 2 ? -1 : 1) * Math.min(halfR * 0.4, 30));
      turn = baseAz + (i % 2 ? -0.32 : 0.26);
    } else {
      along += pr;
      pos = c.clone().addScaledVector(r, along).addScaledVector(t, Math.min(halfT * 0.5, 20));
      along += pr + 10;
      turn = baseAz + 0.5;
    }
    const m = new THREE.Matrix4().makeRotationZ(turn).setPosition(pos.x, pos.y, floorZ);
    out.push({ id, matrix: m });
  });
  return out;
}
