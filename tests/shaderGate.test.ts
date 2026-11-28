// Shaders handed to the graphics card before the scene is drawn, so the page does not wait at the draw. The card
// here is a stand-in that says what it was asked to build and is told when each build is done.

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { ShaderGate } from "../src/ui/viewport/render/shaderGate";

interface Asked {
  /** names of the objects handed over */
  objects: string[];
  /** how many planes the draw before the hand-over was cut by: what the renderer builds for */
  planes: number;
  cross: boolean;
  /** what was being drawn into */
  target: string;
}

/** a renderer that builds nothing: it notes what it was asked and what it drew, and a build is done when the test says */
function card(parallel = true) {
  const asked: Asked[] = [];
  /** every draw made: what, as which material when not its own, into what */
  const drawn: string[] = [];
  /** draws that met a shader not built yet: the page waits there */
  const waited: string[] = [];
  /** what was cleared */
  const cleared: string[] = [];
  const programs = new Map<THREE.Material, { done: boolean; program?: object; isReady(): boolean }>();
  let target: THREE.WebGLRenderTarget | null = null;
  let lastPlanes = 0;
  let lastCross = false;
  /** what shadows are drawn with, when the scene has a light that casts them */
  const depth = new THREE.MeshDepthMaterial({ name: "depth" });
  const r = {
    extensions: { has: (name: string) => parallel && name === "KHR_parallel_shader_compile" },
    getContext: () => ({ linkProgram() {}, shaderSource() {}, getProgramInfoLog() {}, getProgramParameter() {} }),
    shadowMap: { enabled: true, type: THREE.PCFSoftShadowMap },
    localClippingEnabled: true,
    clippingPlanes: [] as THREE.Plane[],
    clear: () => void cleared.push(target ? target.texture.name : "canvas"),
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => (target = t),
    renderBufferDirect: (_camera: THREE.Camera, scene: THREE.Object3D | null, _geometry: THREE.BufferGeometry, m: THREE.Material, o: THREE.Object3D) => {
      lastPlanes = (m.clippingPlanes?.length ?? 0) + r.clippingPlanes.length;
      lastCross = !!m.clipIntersection;
      if (m.name === "kerf-gate-probe") return;
      let p = programs.get(m);
      if (!p) programs.set(m, (p = { done: false, program: {}, isReady() { return this.done; } }));
      if (!p.done) {
        waited.push(o.name);
        p.done = true;
      }
      drawn.push(`${o.name}${scene === null ? " shadow" : m !== (o as THREE.Mesh).material ? ` as ${m.name}` : ""} into ${target ? target.texture.name : "canvas"}`);
    },
    // as the renderer does: shadows first, each thing as the depth material; then each thing as its own material, or
    // as the one the scene puts in place of them all
    render: (root: THREE.Object3D, camera: THREE.Camera) => {
      const things: THREE.Mesh[] = [];
      let shadows = false;
      root.traverseVisible((o) => {
        if ((o as THREE.Mesh).isMesh) things.push(o as THREE.Mesh);
        if ((o as THREE.Light).isLight && o.castShadow) shadows = true;
      });
      if (shadows) {
        const into = target;
        target = shadowMap;
        for (const o of things) r.renderBufferDirect(camera, null, o.geometry, depth, o);
        target = into;
      }
      const over = (root as THREE.Scene).overrideMaterial;
      for (const o of things)
        for (const m of [over ?? o.material].flat()) {
          if (m.transparent && m.side === THREE.DoubleSide && !m.forceSinglePass) {
            // a see-through two-sided material: its back, then its front, marked changed for each
            for (const side of [THREE.BackSide, THREE.FrontSide] as const) {
              m.side = side;
              m.needsUpdate = true;
              r.renderBufferDirect(camera, root, o.geometry, m, o);
            }
            m.side = THREE.DoubleSide;
          } else r.renderBufferDirect(camera, root, o.geometry, m, o);
        }
    },
    compile: (list: THREE.Object3D, _camera: THREE.Camera, stage: THREE.Object3D) => {
      const names: string[] = [];
      const mats = new Set<THREE.Material>();
      list.traverse((o) => {
        const own = Object.getPrototypeOf(o) as THREE.Mesh;
        const m = (o as THREE.Mesh).material;
        // a thing handed over as another material than its own (it stands in for the thing itself) says which
        names.push(own instanceof THREE.Mesh && own.material !== m ? `${o.name} as ${(m as THREE.Material).name}${!(stage as { isScene?: boolean }).isScene ? " (shadow)" : ""}` : o.name);
        for (const x of [m].flat()) {
          mats.add(x);
          if (!programs.has(x)) programs.set(x, { done: false, program: {}, isReady() { return this.done; } });
        }
      });
      asked.push({ objects: names, planes: lastPlanes, cross: lastCross, target: target ? target.texture.name : "canvas" });
      return mats;
    },
    properties: { get: (m: THREE.Material) => ({ currentProgram: programs.get(m), programs: programs.has(m) ? new Map([["its", programs.get(m)!]]) : undefined }) },
  };
  const finish = () => programs.forEach((p) => (p.done = true));
  return { r: r as unknown as THREE.WebGLRenderer, asked, drawn, waited, cleared, programs, finish, depth };
}

const shadowMap = Object.assign(new THREE.WebGLRenderTarget(1, 1), { texture: Object.assign(new THREE.Texture(), { name: "shadow map" }) });
const rt = (name: string) => Object.assign(new THREE.WebGLRenderTarget(1, 1), { texture: Object.assign(new THREE.Texture(), { name }) });
const part = (name: string, m: THREE.Material = new THREE.MeshStandardMaterial()) => Object.assign(new THREE.Mesh(new THREE.BufferGeometry(), m), { name });
const plane = () => new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
/** only what the scene must wait for: the builds for what it is now (the others are for what may come next) */
const needed = (asked: Asked[], scene: THREE.Scene) => asked.filter((a) => a.objects.every((n) => (scene.getObjectByName(n) as THREE.Mesh).material && ((scene.getObjectByName(n) as THREE.Mesh).material as THREE.Material).clippingPlanes?.length === a.planes || (!((scene.getObjectByName(n) as THREE.Mesh).material as THREE.Material).clippingPlanes && a.planes === 0)));

describe("shaders built before the draw", () => {
  const cam = new THREE.PerspectiveCamera();

  it("hands the card what is in the scene, and is not ready until the card has built it", () => {
    const { r, asked, finish } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const scene = new THREE.Scene().add(part("a"), part("b"));
    const into = rt("sample");
    expect(gate.ready(scene, cam, into)).toBe(false);
    expect(gate.busy).toBe(true);
    // both objects, for no cutting planes, into the buffer the scene is drawn into
    expect(asked[0]).toEqual({ objects: ["a", "b"], planes: 0, cross: false, target: "sample" });
    // asked again while the card works: nothing more is handed over
    const n = asked.length;
    expect(gate.ready(scene, cam, into)).toBe(false);
    expect(asked).toHaveLength(n);
    finish();
    expect(gate.ready(scene, cam, into)).toBe(true);
    expect(gate.busy).toBe(false);
    expect(asked).toHaveLength(n);
  });

  it("also has the card build for a section before one is asked for, without waiting for that", () => {
    const { r, asked, programs } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const a = part("a");
    const scene = new THREE.Scene().add(a);
    gate.ready(scene, cam, null, true);
    expect(asked.map((x) => x.planes)).toEqual([0, 1]);
    // the build it waits for is the one handed over first
    expect(needed(asked, scene)).toHaveLength(1);
    programs.get(a.material)!.done = true;
    expect(gate.ready(scene, cam, null, true)).toBe(true);
    // and not at all for a scene nothing cuts
    asked.length = 0;
    gate.ready(new THREE.Scene().add(part("b")), cam, null);
    expect(asked.map((x) => x.planes)).toEqual([0]);
  });

  it("builds a cut part for its planes, and uncut too, since a section is switched off again", () => {
    const { r, asked } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const cut = part("cut", new THREE.MeshStandardMaterial({ clippingPlanes: [plane()] }));
    const whole = part("whole");
    const twice = part("twice", new THREE.MeshStandardMaterial({ clippingPlanes: [plane(), plane()], clipIntersection: true }));
    gate.ready(new THREE.Scene().add(cut, whole, twice), cam, null, true);
    expect(asked).toEqual([
      { objects: ["cut"], planes: 1, cross: false, target: "canvas" },
      { objects: ["whole"], planes: 0, cross: false, target: "canvas" },
      { objects: ["twice"], planes: 2, cross: true, target: "canvas" },
      { objects: ["cut"], planes: 0, cross: false, target: "canvas" },
      { objects: ["whole"], planes: 1, cross: false, target: "canvas" },
    ]);
  });

  it("hands over only what is new or changed after that", () => {
    const { r, asked, finish } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const a = part("a");
    const b = part("b");
    const scene = new THREE.Scene().add(a, b);
    gate.ready(scene, cam, null);
    finish();
    expect(gate.ready(scene, cam, null)).toBe(true);
    asked.length = 0;
    // nothing changed
    gate.ready(scene, cam, null);
    expect(asked).toEqual([]);
    // a new part
    scene.add(part("c"));
    gate.ready(scene, cam, null);
    expect(asked.map((x) => x.objects)).toEqual([["c"]]);
    asked.length = 0;
    // a material marked changed (see-through, a different kind of surface)
    (b.material as THREE.Material).needsUpdate = true;
    gate.ready(scene, cam, null);
    expect(asked[0].objects).toEqual(["b"]);
    asked.length = 0;
    // a section through one part
    (a.material as THREE.Material).clippingPlanes = [plane()];
    gate.ready(scene, cam, null);
    expect(asked[0]).toMatchObject({ objects: ["a"], planes: 1 });
    asked.length = 0;
    // a part given another material
    b.material = new THREE.MeshBasicMaterial();
    gate.ready(scene, cam, null);
    expect(asked[0].objects).toEqual(["b"]);
  });

  it("leaves hidden things until they show", () => {
    const { r, asked, finish } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const hidden = part("hidden");
    hidden.visible = false;
    const scene = new THREE.Scene().add(part("a"), hidden);
    gate.ready(scene, cam, null);
    expect(asked[0].objects).toEqual(["a"]);
    finish();
    asked.length = 0;
    hidden.visible = true;
    expect(gate.ready(scene, cam, null)).toBe(false);
    expect(asked[0].objects).toEqual(["hidden"]);
  });

  it("builds everything again when a light is added, the surroundings arrive, or the card was reset", () => {
    const { r, asked, finish } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const scene = new THREE.Scene().add(part("a"), part("b"));
    gate.ready(scene, cam, null);
    finish();
    asked.length = 0;
    scene.add(new THREE.DirectionalLight());
    gate.ready(scene, cam, null);
    expect(asked[0].objects).toEqual(["a", "b"]);
    asked.length = 0;
    scene.environment = Object.assign(new THREE.Texture(), { mapping: THREE.CubeUVReflectionMapping, image: { height: 256 } });
    gate.ready(scene, cam, null);
    expect(asked[0].objects).toEqual(["a", "b"]);
    asked.length = 0;
    // a light that only changes colour or moves is the same shader
    (scene.children[2] as THREE.DirectionalLight).intensity = 3;
    gate.ready(scene, cam, null);
    expect(asked).toEqual([]);
    gate.reset();
    gate.ready(scene, cam, null);
    expect(asked[0].objects).toEqual(["a", "b"]);
  });

  it("does not take a see-through two-sided material's marks for changes: the renderer makes them at every draw", () => {
    const { r, asked, finish } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const glass = part("glass", new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide }));
    const scene = new THREE.Scene().add(glass);
    gate.ready(scene, cam, null);
    finish();
    asked.length = 0;
    (glass.material as THREE.Material).needsUpdate = true;
    expect(gate.ready(scene, cam, null)).toBe(true);
    expect(asked).toEqual([]);
  });

  it("keeps two scenes apart, and waits for both", () => {
    const { r, asked, programs } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const a = part("a");
    const b = part("b");
    const one = new THREE.Scene().add(a);
    const two = new THREE.Scene().add(b);
    gate.ready(one, cam, rt("sample"));
    gate.ready(two, cam, null);
    expect(asked.filter((x) => x.planes === 0).map((x) => [x.objects, x.target])).toEqual([
      [["a"], "sample"],
      [["b"], "canvas"],
    ]);
    programs.get(a.material)!.done = true;
    // the first scene's own builds are done, but a frame draws both
    expect(gate.ready(one, cam, rt("sample"))).toBe(false);
    programs.get(b.material)!.done = true;
    expect(gate.ready(one, cam, rt("sample"))).toBe(true);
  });

  it("stops waiting for a build whose program was let go", () => {
    const { r, programs } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const a = part("a");
    const scene = new THREE.Scene().add(a);
    expect(gate.ready(scene, cam, null)).toBe(false);
    // the part went before its shader was built: the renderer let the program go
    programs.get(a.material)!.program = undefined;
    expect(gate.ready(scene, cam, null)).toBe(true);
  });

  it("puts back what was being drawn into", () => {
    const { r } = card();
    const gate = new ShaderGate(r, rt("scratch"));
    const mine = rt("mine");
    r.setRenderTarget(mine);
    gate.ready(new THREE.Scene().add(part("a")), cam, rt("sample"));
    expect(r.getRenderTarget()).toBe(mine);
  });

  it("says every scene is ready where the card cannot say when a build is done", () => {
    const { r, asked } = card(false);
    const gate = new ShaderGate(r, rt("scratch"));
    expect(gate.works).toBe(false);
    expect(gate.ready(new THREE.Scene().add(part("a")), cam, null)).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe("a frame drawn while the card may still be building", () => {
  const cam = new THREE.PerspectiveCamera();
  /** a scene with one part whose own shader the card has built */
  const builtScene = () => {
    const c = card();
    const gate = new ShaderGate(c.r, rt("scratch"));
    const a = part("a");
    const scene = new THREE.Scene().add(a);
    gate.ready(scene, cam, null);
    c.finish();
    expect(gate.ready(scene, cam, null)).toBe(true);
    c.asked.length = 0;
    return { ...c, gate, a, scene };
  };
  /** one frame of the scene, as the view draws it; true when the frame is not whole */
  const frame = (gate: ShaderGate, r: THREE.WebGLRenderer, scene: THREE.Object3D) => {
    gate.begin();
    r.render(scene as THREE.Scene, cam);
    return gate.end();
  };

  it("draws what the card has built, and nothing is waited for", () => {
    const { gate, r, scene, drawn, waited } = builtScene();
    expect(frame(gate, r, scene)).toBe(false);
    expect(drawn).toEqual(["a into canvas"]);
    expect(waited).toEqual([]);
  });

  it("leaves out a draw with a material put in place of the part's own, has it built, and draws it once it is", () => {
    const { gate, r, scene, drawn, waited, asked, finish } = builtScene();
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ name: "outline" });
    expect(frame(gate, r, scene)).toBe(true);
    expect(drawn).toEqual([]);
    expect(waited).toEqual([]);
    // handed over as it was to be drawn: the part, with that material
    expect(asked).toEqual([{ objects: ["a as outline"], planes: 0, cross: false, target: "canvas" }]);
    expect(gate.busy).toBe(true);
    // while the card works the frame stays without it, and it is not handed over again
    expect(frame(gate, r, scene)).toBe(true);
    expect(drawn).toEqual([]);
    expect(asked).toHaveLength(1);
    finish();
    expect(gate.ready(scene, cam, null)).toBe(true);
    expect(frame(gate, r, scene)).toBe(false);
    expect(drawn).toEqual(["a as outline into canvas"]);
    expect(waited).toEqual([]);
  });

  it("does the same for the shader a shadow is drawn with, built as the renderer draws shadows", () => {
    const { gate, r, scene, drawn, waited, asked, finish } = builtScene();
    const sun = new THREE.DirectionalLight();
    sun.castShadow = true;
    scene.add(sun);
    // the light is a new shader for the part itself, which looking the scene over hands to the card
    gate.ready(scene, cam, null);
    finish();
    asked.length = 0;
    expect(frame(gate, r, scene)).toBe(true);
    // the part is drawn; its shadow is not, yet
    expect(drawn).toEqual(["a into canvas"]);
    expect(asked).toEqual([{ objects: ["a as depth (shadow)"], planes: 0, cross: false, target: "scratch" }]);
    finish();
    drawn.length = 0;
    expect(frame(gate, r, scene)).toBe(false);
    expect(drawn).toEqual(["a shadow into shadow map", "a into canvas"]);
    expect(waited).toEqual([]);
  });

  it("leaves out what looking the scene over handed to the card and the card has not finished", () => {
    const c = card();
    const gate = new ShaderGate(c.r, rt("scratch"));
    const scene = new THREE.Scene().add(part("a"));
    expect(gate.ready(scene, cam, null)).toBe(false);
    const n = c.asked.length;
    expect(frame(gate, c.r, scene)).toBe(true);
    expect(c.drawn).toEqual([]);
    expect(c.waited).toEqual([]);
    expect(c.asked).toHaveLength(n);
  });

  it("takes a draw into a buffer and one onto the canvas for different shaders, and so with a plane cutting everything", () => {
    const { gate, r, scene, drawn, asked, finish } = builtScene();
    r.setRenderTarget(rt("sample"));
    expect(frame(gate, r, scene)).toBe(true);
    expect(asked).toEqual([{ objects: ["a"], planes: 0, cross: false, target: "scratch" }]);
    finish();
    expect(frame(gate, r, scene)).toBe(false);
    expect(drawn).toEqual(["a into sample"]);
    asked.length = 0;
    r.clippingPlanes = [plane()];
    expect(frame(gate, r, scene)).toBe(true);
    expect(asked).toEqual([{ objects: ["a"], planes: 1, cross: false, target: "scratch" }]);
  });

  it("goes through the showing of a frame that is not whole without drawing or clearing, and has what it draws with built", () => {
    const { gate, r, scene, drawn, cleared, asked, finish } = builtScene();
    const marks = new THREE.Scene().add(part("mark", new THREE.MeshBasicMaterial({ name: "mark" })));
    const show = () => {
      r.setRenderTarget(null);
      r.clear();
      r.render(scene, cam);
      r.render(marks, cam);
    };
    // a whole frame is shown as ever
    gate.begin();
    gate.unshown(() => undefined);
    show();
    expect(gate.end()).toBe(true);
    expect(cleared).toEqual(["canvas"]);
    // (the marks were new to the card: that frame was not whole after all)
    expect(drawn).toEqual(["a into canvas"]);
    finish();
    gate.ready(scene, cam, null);
    drawn.length = cleared.length = asked.length = 0;
    // one that is not whole: an outline the card has not built
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ name: "outline" });
    gate.begin();
    r.render(scene, cam);
    expect(gate.partial).toBe(true);
    scene.overrideMaterial = null;
    const more = new THREE.Scene().add(part("label", new THREE.MeshBasicMaterial({ name: "label" })));
    gate.unshown(() => {
      show();
      r.render(more, cam);
    });
    expect(gate.end()).toBe(true);
    expect(drawn).toEqual([]);
    expect(cleared).toEqual([]);
    // the outline, and the label only the showing would have drawn
    expect(asked.map((x) => x.objects)).toEqual([["a as outline"], ["label"]]);
  });

  it("says once, after something new was handed over, that a frame should go through to meet the rest", () => {
    const c = card();
    const gate = new ShaderGate(c.r, rt("scratch"));
    const scene = new THREE.Scene().add(part("a"));
    expect(gate.scout()).toBe(false);
    gate.ready(scene, cam, null);
    expect(gate.scout()).toBe(true);
    expect(gate.scout()).toBe(false);
    gate.ready(scene, cam, null);
    expect(gate.scout()).toBe(false);
  });

  it("leaves out a material never seen before at every frame, however many in a row: each frame drawn again is whole", () => {
    const { gate, r, scene, drawn, waited, programs } = builtScene();
    // a material never seen before at every frame, each with a shader the card has already
    const another = () => {
      const m = new THREE.MeshBasicMaterial({ name: "new" });
      programs.set(m, { done: true, program: {}, isReady: () => true });
      scene.overrideMaterial = m;
    };
    for (let i = 0; i < 4; i++) {
      another();
      expect(frame(gate, r, scene)).toBe(true);
      // the card had its shader: there is nothing to wait for, and the frame drawn again is whole
      expect(gate.ready(scene, cam, null)).toBe(true);
      expect(frame(gate, r, scene)).toBe(false);
    }
    expect(drawn).toEqual(Array(4).fill("a as new into canvas"));
    expect(waited).toEqual([]);
  });

  it("leaves out a draw with a shader that was handed over with nothing waiting for it and is not built yet, and waits for it from then on", () => {
    const c = card();
    const gate = new ShaderGate(c.r, rt("scratch"));
    const scene = new THREE.Scene().add(part("a"));
    const into = rt("picture");
    // handed over for a picture: nothing waits
    gate.too(scene, cam, into);
    expect(gate.busy).toBe(false);
    // a frame comes to draw it there before the card is done
    const draw = () => {
      gate.begin();
      c.r.setRenderTarget(into);
      c.r.render(scene, cam);
      c.r.setRenderTarget(null);
      return gate.end();
    };
    expect(draw()).toBe(true);
    expect(c.drawn).toEqual([]);
    expect(c.waited).toEqual([]);
    expect(gate.busy).toBe(true);
    c.finish();
    expect(draw()).toBe(false);
    expect(c.drawn).toEqual(["a into picture"]);
    expect(c.waited).toEqual([]);
  });

  it("takes a material made anew for one the card may have nothing built for, in every kind of draw", () => {
    const { gate, r, scene, a, drawn, waited, asked, programs, finish } = builtScene();
    const into = rt("mirror");
    const mirror = () => {
      gate.begin();
      r.setRenderTarget(into);
      r.render(scene, cam);
      r.setRenderTarget(null);
      return gate.end();
    };
    // a second way the part is drawn, which looking the scene over does not see: met in a frame, and built
    expect(mirror()).toBe(true);
    finish();
    expect(mirror()).toBe(false);
    drawn.length = asked.length = 0;
    // the material is made anew (see-through now, say): its shader for that way is another, which the card has not built
    const m = a.material as THREE.Material;
    m.needsUpdate = true;
    programs.get(m)!.done = false;
    expect(mirror()).toBe(true);
    expect(drawn).toEqual([]);
    expect(waited).toEqual([]);
    expect(asked.map((x) => x.objects)).toEqual([["a"]]);
    finish();
    expect(mirror()).toBe(false);
    expect(drawn).toEqual(["a into mirror"]);
    expect(waited).toEqual([]);
  });

  it("gives up on builds only when the card has finished none for a long time, and then draws with them as it used to", () => {
    let t = 1000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => t);
    try {
      const c = card();
      const gate = new ShaderGate(c.r, rt("scratch"));
      const a = part("a");
      const scene = new THREE.Scene().add(a, part("b"));
      expect(gate.ready(scene, cam, null)).toBe(false);
      // a long wait is not given up on while the card finishes something now and then
      t += 50_000;
      c.programs.get(a.material as THREE.Material)!.done = true;
      expect(gate.ready(scene, cam, null)).toBe(false);
      t += 50_000;
      expect(gate.ready(scene, cam, null)).toBe(false);
      // nothing at all for more than a minute
      t += 20_000;
      expect(gate.ready(scene, cam, null)).toBe(true);
      expect(frame(gate, c.r, scene)).toBe(false);
      expect(c.drawn).toEqual(["a into canvas", "b into canvas"]);
      expect(c.waited).toEqual(["b"]);
    } finally {
      now.mockRestore();
    }
  });

  it("draws a thing the renderer could not build ahead at its draw, as it used to, and not never", () => {
    const { gate, r, scene, drawn, waited } = builtScene();
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ name: "outline" });
    const compile = r.compile;
    r.compile = () => {
      throw new Error("no shader");
    };
    expect(frame(gate, r, scene)).toBe(true);
    r.compile = compile;
    expect(frame(gate, r, scene)).toBe(false);
    expect(drawn).toEqual(["a as outline into canvas"]);
    expect(waited).toEqual(["a"]);
  });

  it("draws a see-through two-sided thing, back then front, in whole frames once the card has built for it", () => {
    const c = card();
    const gate = new ShaderGate(c.r, rt("scratch"));
    const scene = new THREE.Scene().add(part("glass", new THREE.MeshBasicMaterial({ transparent: true, side: THREE.DoubleSide })));
    gate.ready(scene, cam, null);
    c.finish();
    expect(gate.ready(scene, cam, null)).toBe(true);
    for (let i = 0; i < 3; i++) expect(frame(gate, c.r, scene)).toBe(false);
    expect(c.drawn).toEqual(Array(6).fill("glass into canvas"));
    expect(c.waited).toEqual([]);
    // and one first met inside a frame, put in place of a part's own: whole from the frame after
    const { gate: g2, r, scene: s2, drawn, waited, finish } = builtScene();
    s2.overrideMaterial = new THREE.MeshBasicMaterial({ name: "ghost", transparent: true, side: THREE.DoubleSide });
    expect(frame(g2, r, s2)).toBe(true);
    finish();
    for (let i = 0; i < 3; i++) expect(frame(g2, r, s2)).toBe(false);
    expect(drawn).toEqual(Array(6).fill("a as ghost into canvas"));
    expect(waited).toEqual([]);
  });

  it("lets every draw through outside a frame, waited for as it always was", () => {
    const { r, scene, drawn, waited } = builtScene();
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ name: "outline" });
    r.render(scene, cam);
    expect(drawn).toEqual(["a as outline into canvas"]);
    expect(waited).toEqual(["a"]);
  });

  it("has the card build what a picture for a file draws into a buffer too, and waits for none of that", () => {
    const { gate, r, scene, asked, drawn, waited, finish } = builtScene();
    const into = rt("picture");
    gate.too(scene, cam, into);
    expect(asked).toEqual([{ objects: ["a"], planes: 0, cross: false, target: "picture" }]);
    // the live view is as ready as it was
    expect(gate.busy).toBe(false);
    expect(gate.ready(scene, cam, null)).toBe(true);
    // asked again: nothing more, until the thing changes
    gate.too(scene, cam, into);
    expect(asked).toHaveLength(1);
    ((scene.getObjectByName("a") as THREE.Mesh).material as THREE.Material).needsUpdate = true;
    gate.too(scene, cam, into);
    expect(asked).toHaveLength(2);
    finish();
    r.setRenderTarget(into);
    r.render(scene, cam);
    expect(drawn).toEqual(["a into picture"]);
    expect(waited).toEqual([]);
  });

  it("goes through work that can be put off without drawing it, and says when the card has built what it draws with", () => {
    const { gate, r, drawn, waited, cleared, asked, finish } = builtScene();
    const into = rt("map");
    const set = new THREE.Scene().add(part("sky", new THREE.ShaderMaterial({ name: "sky" })));
    const bake = () => {
      r.setRenderTarget(into);
      r.clear();
      r.render(set, cam);
      r.setRenderTarget(null);
    };
    const built = gate.rehearse(bake)!;
    expect(drawn).toEqual([]);
    expect(cleared).toEqual([]);
    expect(asked.map((x) => x.objects)).toEqual([["sky"]]);
    expect(built()).toBe(false);
    // the live view does not wait for it
    expect(gate.busy).toBe(false);
    finish();
    expect(built()).toBe(true);
    bake();
    expect(drawn).toEqual(["sky into map"]);
    expect(waited).toEqual([]);
    // and the same work again has nothing left to build: it is done there and then
    expect(gate.rehearse(bake)).toBe(null);
    expect(asked).toHaveLength(1);
  });

  it("has work rehearsed again wait for a build of its own that was handed over the first time and is not done", () => {
    const { gate, r, asked, finish } = builtScene();
    const set = new THREE.Scene().add(part("sky"));
    const bake = () => r.render(set, cam);
    expect(gate.rehearse(bake)!()).toBe(false);
    // again before the card is done: nothing more is handed over, and it is still not time for the work
    const built = gate.rehearse(bake)!;
    expect(asked).toHaveLength(1);
    expect(built()).toBe(false);
    finish();
    expect(built()).toBe(true);
    expect(gate.rehearse(bake)).toBe(null);
  });

  it("hands over what a rehearsal met even when the work failed part of the way", () => {
    const { gate, r, asked } = builtScene();
    const set = new THREE.Scene().add(part("sky"));
    expect(() =>
      gate.rehearse(() => {
        r.render(set, cam);
        throw new Error("no room for the map");
      }),
    ).toThrow("no room");
    expect(asked.map((x) => x.objects)).toEqual([["sky"]]);
    // and frames are drawn as before
    expect(gate.partial).toBe(false);
  });

  it("rehearses nothing where the card cannot build on the side: the work is done at once, as it was", () => {
    const c = card(false);
    const gate = new ShaderGate(c.r, rt("scratch"));
    let went = false;
    expect(gate.rehearse(() => (went = true))).toBe(null);
    expect(went).toBe(false);
  });

  it("gives the renderer its own drawing back when it is done with", () => {
    const c = card();
    const draw = c.r.renderBufferDirect;
    const render = c.r.render;
    const gate = new ShaderGate(c.r, rt("scratch"));
    expect(c.r.renderBufferDirect).not.toBe(draw);
    gate.dispose();
    expect(c.r.renderBufferDirect).toBe(draw);
    expect(c.r.render).toBe(render);
  });
});

