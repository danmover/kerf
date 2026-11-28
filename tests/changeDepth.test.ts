import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { ChangeDepth } from "../src/ui/viewport/render/changeDepth";

// While a rebuilt part shows what changed, the depth of its old and new meshes is drawn each frame, each mesh as a
// scene of its own. A scene of one mesh has no lights in it, so anything drawn there with a part's material would
// need a shader built for no lights: the parts' large shader once more, which a Direct3D card takes seconds over
// while the picture waits (3.4 s at a 14-part edit of the robot dog on an RX 7800 XT).

/** A renderer that only writes down what each render call would draw: every visible mesh under what it is given. */
function standIn() {
  const draws: { name: string; material: THREE.Material }[][] = [];
  let target: THREE.WebGLRenderTarget | null = null;
  const r = {
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => void (target = t),
    clear: () => {},
    render: (scene: THREE.Object3D) => {
      const drawn: { name: string; material: THREE.Material }[] = [];
      scene.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh) drawn.push({ name: o.name, material: (o as THREE.Mesh).material as THREE.Material });
      });
      draws.push(drawn);
    },
  };
  return { r: r as unknown as THREE.WebGLRenderer, draws };
}

function part(name: string) {
  const mat = new THREE.MeshPhysicalMaterial({ side: THREE.DoubleSide });
  mat.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  mesh.name = name;
  // its rounded edges hang on it, drawn with the part's own material
  const bevel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  bevel.name = `${name} bevel`;
  const hidden = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  hidden.name = `${name} hidden`;
  hidden.visible = false;
  mesh.add(bevel, hidden);
  return { mesh, mat, bevel, hidden };
}

describe("the depth a changing part's surfaces are told apart by", () => {
  it("draws each mesh alone, with a material of its own and never the part's", () => {
    const { r, draws } = standIn();
    const depth = new ChangeDepth(r);
    const old = part("old");
    const now = part("new");
    depth.draw(new THREE.PerspectiveCamera(), 64, 48, [old.mesh], [now.mesh]);
    expect(draws.map((d) => d.map((x) => x.name))).toEqual([["old"], ["new"]]);
    for (const d of draws) for (const x of d) expect(x.material.type).toBe("MeshBasicMaterial");
    depth.dispose();
  });

  it("leaves the mesh and what hangs on it as they were", () => {
    const { r } = standIn();
    const depth = new ChangeDepth(r);
    const p = part("part");
    depth.draw(new THREE.PerspectiveCamera(), 64, 48, [], [p.mesh]);
    expect(p.mesh.material).toBe(p.mat);
    expect(p.bevel.visible).toBe(true);
    expect(p.hidden.visible).toBe(false);
    depth.dispose();
  });

  it("cuts and culls the mesh as the part is cut and culled", () => {
    const seen: { side: THREE.Side; planes: number }[] = [];
    const { r } = standIn();
    (r as unknown as { render: (s: THREE.Object3D) => void }).render = (s) => {
      const m = (s as THREE.Mesh).material as THREE.Material;
      seen.push({ side: m.side, planes: m.clippingPlanes?.length ?? 0 });
    };
    const depth = new ChangeDepth(r);
    const p = part("part");
    depth.draw(new THREE.PerspectiveCamera(), 64, 48, [], [p.mesh]);
    expect(seen).toEqual([{ side: THREE.DoubleSide, planes: 1 }]);
    depth.dispose();
  });
});
