import * as THREE from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appearanceFor, Detail } from "../src/ui/viewport/render/appearance";
import { detailMaps, releaseDetailMaps, ROUGH_MAP_MEAN } from "../src/ui/viewport/render/detailTextures";
import { boxProjected, photoMaterial } from "../src/ui/viewport/render/photoreal";

function frames(g: THREE.BufferGeometry) {
  const n = g.getAttribute("normal");
  const t = g.getAttribute("tangent");
  const out: { n: THREE.Vector3; t: THREE.Vector3; w: number }[] = [];
  for (let i = 0; i < n.count; i++) out.push({ n: new THREE.Vector3().fromBufferAttribute(n, i), t: new THREE.Vector3(t.getX(i), t.getY(i), t.getZ(i)), w: t.getW(i) });
  return out;
}

describe("photoreal geometry", () => {
  it("unrolls a mesh with UVs in tile units and a tangent frame at every vertex", () => {
    const box = new THREE.BoxGeometry(10, 20, 30);
    const g = boxProjected(box, 2);
    expect(g.getIndex()).toBeNull();
    expect(g.getAttribute("position").count).toBe(box.getIndex()!.count);
    for (const f of frames(g)) {
      expect(f.t.length()).toBeCloseTo(1, 5);
      expect(Math.abs(f.t.dot(f.n))).toBeLessThan(1e-5);
      expect(Math.abs(f.w)).toBe(1);
    }
    // a side facing +x maps y to u and z to v: 20 mm across is 10 tiles
    const pos = g.getAttribute("position");
    const uv = g.getAttribute("uv");
    const nor = g.getAttribute("normal");
    for (let i = 0; i < pos.count; i++)
      if (nor.getX(i) > 0.99) {
        expect(uv.getX(i)).toBeCloseTo(pos.getY(i) / 2, 5);
        expect(uv.getY(i)).toBeCloseTo(pos.getZ(i) / 2, 5);
      }
  });

  it("keeps the frame valid where smooth normals run along the projection axis", () => {
    // a sphere's smooth normals point every way, including straight along u
    const g = boxProjected(new THREE.SphereGeometry(5, 24, 16), 1);
    for (const f of frames(g)) {
      expect(Number.isFinite(f.t.x + f.t.y + f.t.z)).toBe(true);
      expect(f.t.length()).toBeCloseTo(1, 4);
      expect(Math.abs(f.t.dot(f.n))).toBeLessThan(1e-4);
      // the bitangent the path tracer rebuilds is never degenerate
      expect(new THREE.Vector3().crossVectors(f.n, f.t).length()).toBeGreaterThan(0.99);
    }
  });
});

describe("photoreal materials", () => {
  it("bakes tileable maps for every kind of surface detail", () => {
    for (const d of [Detail.Layers, Detail.Brushed, Detail.Grain, Detail.Peel, Detail.Weave, Detail.Wood, Detail.Machined]) {
      const m = detailMaps(d)!;
      expect(m, Detail[d]).toBeTruthy();
      expect(m.normal.image.width).toBe(256);
      expect(m.slope).toBeGreaterThan(0);
      expect(m.colorMean).toBeGreaterThan(0.3);
      expect(m.colorMean).toBeLessThanOrEqual(1);
      expect(detailMaps(d)).toBe(m);
    }
    expect(detailMaps(Detail.None)).toBeNull();
    expect(detailMaps(Detail.Weave)!.color).not.toBeNull();
    expect(detailMaps(Detail.Brushed)!.color).toBeNull();
  });

  it("matches the interactive look: same PBR values, detail as maps at the same scale", () => {
    const a = appearanceFor("PLA", "printed", "#2f6fe0");
    const { mat, tile } = photoMaterial(a);
    const maps = detailMaps(a.detail)!;
    expect(tile).toBeCloseTo(maps.cells * a.detailScale, 6);
    expect(mat.normalMap).toBe(maps.normal);
    expect(mat.normalScale.x).toBeCloseTo((a.detailAmp * maps.slope) / tile, 6);
    expect(mat.metalness).toBe(a.metalness);
    if (a.roughVar > 0) expect(mat.roughness).toBeCloseTo(Math.min(1, a.roughness / ROUGH_MAP_MEAN), 6);

    const glass = photoMaterial(appearanceFor("Acrylic", "clear", "#ffffff")).mat;
    expect(glass.transmission).toBe(1);
    expect(glass.side).toBe(THREE.DoubleSide);

    const metal = appearanceFor("Aluminum 6061", "brushed", "#c4c8ce");
    expect(photoMaterial(metal).mat.metalness).toBe(1);
  });
});

describe("photoreal recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("starts off after a reload, so a GPU that hung in the path tracer isn't sent back in", async () => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ photoreal: true, quality: "high" }), setItem: () => undefined, removeItem: () => undefined });
    vi.resetModules();
    const s = (await import("../src/app/settings")).useSettings.getState();
    expect(s.photoreal).toBe(false);
    expect(s.quality).toBe("high");
  });

  it("frees the detail maps' GPU copies and keeps the baked data for next time", () => {
    const m = detailMaps(Detail.Grain)!;
    let freed = 0;
    m.normal.addEventListener("dispose", () => freed++);
    m.rough.addEventListener("dispose", () => freed++);
    releaseDetailMaps();
    expect(freed).toBe(2);
    expect(detailMaps(Detail.Grain)).toBe(m);
    expect(m.normal.image.data.length).toBe(256 * 256 * 4);
  });
});
